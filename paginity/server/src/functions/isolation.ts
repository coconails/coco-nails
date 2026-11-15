import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomId, UserError } from '../lib/util.js';

/**
 * Isolation du code des sites (fonctions serveur et étape de préparation).
 *
 * - « podman » (choix D5) : un conteneur par site, sans droits administrateur, système de fichiers en lecture
 *   seule, aucun privilège, limites de mémoire/processeur/processus. Le conteneur ne voit que le code du site.
 * - « processus » (secours, si Podman est absent) : un processus Node.js séparé, avec le modèle de permissions
 *   de Node (lecture limitée au code du site, aucune écriture hors d'un dossier, aucun sous-processus).
 *   Isolation plus faible : acceptable pour vos propres sites, pas pour du code de tiers.
 */

export type IsolationMode = 'podman' | 'processus';

export const WORKER_FILE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'runtime', 'worker.mjs');

export interface WorkerSpec {
  key: string;
  appDir: string;
  functionsDir: string;
  socketDir: string;
  env: Record<string, string>;
  memoryMb: number;
}

export interface RunningWorker {
  socket: string;
  stop(): Promise<void>;
  exited: Promise<number | null>;
}

export interface IsolationOptions {
  mode: IsolationMode;
  image: string;
  network: string;
  onLog: (key: string, line: string) => void;
}

export function detectIsolation(pref: string | undefined): IsolationMode {
  if (pref === 'processus') return 'processus';
  const ok = spawnSync('podman', ['--version'], { stdio: 'ignore' }).status === 0;
  if (pref === 'podman' && !ok) throw new Error('PAGINITY_ISOLATION=podman, mais Podman n’est pas installé.');
  return ok ? 'podman' : 'processus';
}

function pipeLines(stream: NodeJS.ReadableStream | null, cb: (line: string) => void) {
  if (!stream) return;
  let buf = '';
  stream.setEncoding?.('utf8');
  stream.on('data', (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      cb(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
    if (buf.length > 8000) {
      cb(buf);
      buf = '';
    }
  });
  stream.on('end', () => buf && cb(buf));
}

function baseEnv(spec: WorkerSpec, socketPath: string, appDir: string): Record<string, string> {
  return {
    ...spec.env,
    PAGINITY_APP_DIR: appDir,
    PAGINITY_FUNCTIONS_DIR: spec.functionsDir,
    PAGINITY_SOCKET: socketPath,
    TZ: 'UTC',
    NODE_ENV: 'production',
    LANG: 'C.UTF-8',
  };
}

function waitForSocket(socket: string, child: { exited: Promise<number | null> }, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let done = false;
    child.exited.then((code) => {
      if (!done) {
        done = true;
        reject(new UserError(500, `L’exécuteur des fonctions s’est arrêté au démarrage (code ${code}). Consultez le journal des fonctions.`));
      }
    });
    const tick = () => {
      if (done) return;
      if (fs.existsSync(socket)) {
        done = true;
        return resolve();
      }
      if (Date.now() - started > timeoutMs) {
        done = true;
        return reject(new UserError(504, 'L’exécuteur des fonctions ne démarre pas (délai dépassé).'));
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

export class Isolation {
  constructor(public opts: IsolationOptions) {}

  get mode(): IsolationMode {
    return this.opts.mode;
  }

  async startWorker(spec: WorkerSpec): Promise<RunningWorker> {
    fs.mkdirSync(spec.socketDir, { recursive: true, mode: 0o770 });
    const socketHost = path.join(spec.socketDir, 'fonctions.sock');
    fs.rmSync(socketHost, { force: true });
    const log = (l: string) => this.opts.onLog(spec.key, l);

    if (this.opts.mode === 'processus') {
      const child = spawn(
        process.execPath,
        [
          '--permission',
          `--allow-fs-read=${spec.appDir}`,
          `--allow-fs-read=${path.dirname(WORKER_FILE)}`,
          `--allow-fs-read=${spec.socketDir}`,
          `--allow-fs-write=${spec.socketDir}`,
          `--max-old-space-size=${spec.memoryMb}`,
          '--disable-warning=ExperimentalWarning',
          WORKER_FILE,
        ],
        { cwd: spec.appDir, env: { PATH: process.env.PATH ?? '', ...baseEnv(spec, socketHost, spec.appDir) }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return this.track(child, socketHost, log, async () => {
        child.kill('SIGTERM');
      });
    }

    // Conteneur Podman.
    const name = `paginity-${spec.key.replace(/[^a-z0-9-]/gi, '-')}-${randomId()}`.toLowerCase();
    const env = baseEnv(spec, '/run/paginity/fonctions.sock', '/app');
    // Les valeurs (secrets) passent par l'environnement du programme podman (« -e NOM » sans valeur) :
    // elles n'apparaissent ni dans la liste des processus ni dans un fichier.
    const envArgs = Object.keys(env).flatMap((k) => ['-e', k]);
    const args = [
      'run', '--rm', '--name', name,
      '--read-only', '--tmpfs', '/tmp:rw,size=64m,mode=1777',
      '--cap-drop=ALL', '--security-opt', 'no-new-privileges',
      '--memory', `${spec.memoryMb + 64}m`, '--cpus', '1', '--pids-limit', '128',
      '--network', this.opts.network,
      '-v', `${spec.appDir}:/app:ro`,
      '-v', `${WORKER_FILE}:/paginity/worker.mjs:ro`,
      '-v', `${spec.socketDir}:/run/paginity:rw`,
      ...envArgs,
      '-w', '/app',
      this.opts.image,
      'node', `--max-old-space-size=${spec.memoryMb}`, '/paginity/worker.mjs',
    ];
    const hostEnv: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', ...env };
    if (process.env.XDG_RUNTIME_DIR) hostEnv.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
    const child = spawn('podman', args, { stdio: ['ignore', 'pipe', 'pipe'], env: hostEnv });
    return this.track(child, socketHost, log, async () => {
      await new Promise((r) => execFile('podman', ['stop', '-t', '5', name], () => r(null)));
    });
  }

  private async track(child: ChildProcess, socket: string, log: (l: string) => void, stopper: () => Promise<void>): Promise<RunningWorker> {
    pipeLines(child.stdout, log);
    pipeLines(child.stderr, (l) => (/^WARNING: (Support for|The cgroupv2)/.test(l) || /Resource limits are not supported/.test(l) ? undefined : log(l)));
    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
      child.on('error', (e) => {
        log(`[paginity] démarrage impossible : ${e.message}`);
        resolve(-1);
      });
    });
    const w: RunningWorker = {
      socket,
      exited,
      stop: async () => {
        await stopper();
        await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
        if (child.exitCode === null) child.kill('SIGKILL');
      },
    };
    try {
      await waitForSocket(socket, w);
    } catch (e) {
      await w.stop().catch(() => undefined);
      throw e;
    }
    return w;
  }

  /**
   * Exécute l'étape de préparation (« node script.mjs ») dans la copie de travail, isolée.
   * Seules les commandes « node <fichier> [arguments] » sont acceptées : pas d'interpréteur de commandes.
   */
  async runBuild(workDir: string, command: string, onLog: (l: string) => void, timeoutMs = 120_000): Promise<void> {
    const parts = command.trim().split(/\s+/);
    if (parts[0] !== 'node' || parts.length < 2 || parts.slice(1).some((p) => p.includes('..') || p.startsWith('/') || /[;&|`$<>]/.test(p))) {
      throw new UserError(422, `Étape de préparation non prise en charge : « ${command} ». Seule la forme « node chemin/vers/script.mjs » est acceptée.`);
    }
    const script = parts[1];
    if (!fs.existsSync(path.join(workDir, script))) throw new UserError(422, `Le script de préparation « ${script} » est introuvable.`);
    let child: ChildProcess;
    if (this.opts.mode === 'processus') {
      child = spawn(
        process.execPath,
        ['--permission', `--allow-fs-read=${workDir}`, `--allow-fs-write=${workDir}`, '--max-old-space-size=512', '--disable-warning=ExperimentalWarning', ...parts.slice(1)],
        { cwd: workDir, env: { PATH: process.env.PATH ?? '', TZ: 'UTC', LANG: 'C.UTF-8', NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } else {
      child = spawn(
        'podman',
        [
          'run', '--rm', '--read-only', '--tmpfs', '/tmp:rw,size=64m,mode=1777', '--cap-drop=ALL', '--security-opt', 'no-new-privileges',
          '--memory', '640m', '--cpus', '2', '--pids-limit', '128', '--network', 'none',
          '-v', `${workDir}:/src:rw`, '-w', '/src', '-e', 'TZ=UTC', '-e', 'NODE_ENV=production',
          this.opts.image, 'node', '--max-old-space-size=512', ...parts.slice(1),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    }
    pipeLines(child.stdout, onLog);
    pipeLines(child.stderr, (l) => (/^WARNING: |Resource limits are not supported/.test(l) ? undefined : onLog(l)));
    const code = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => {
        onLog('[paginity] délai dépassé : arrêt de l’étape de préparation');
        child.kill('SIGKILL');
      }, timeoutMs);
      child.on('exit', (c) => {
        clearTimeout(t);
        resolve(c);
      });
      child.on('error', () => resolve(-1));
    });
    if (code !== 0) throw new UserError(422, `L’étape de préparation a échoué (code ${code}). Le site en ligne n’a pas été modifié.`);
  }
}

/**
 * Installation des dépendances (« npm ci ») sans exécuter aucun script du paquet (--ignore-scripts) :
 * aucun code du site ni de ses bibliothèques ne s'exécute pendant l'installation. Résultat mis en cache.
 */
export async function installDependencies(workDir: string, cacheRoot: string, onLog: (l: string) => void): Promise<'aucune' | 'cache' | 'installees'> {
  const pkgPath = path.join(workDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return 'aucune';
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) return 'aucune';
  const lockPath = path.join(workDir, 'package-lock.json');
  if (!fs.existsSync(lockPath)) throw new UserError(422, 'Le site a des dépendances mais pas de fichier package-lock.json : impossible de garantir des versions identiques.');
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(fs.readFileSync(lockPath)).update(process.version.split('.')[0]).digest('hex').slice(0, 20);
  const cached = path.join(cacheRoot, hash);
  if (!fs.existsSync(path.join(cached, 'node_modules'))) {
    const tmp = `${cached}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    fs.copyFileSync(pkgPath, path.join(tmp, 'package.json'));
    fs.copyFileSync(lockPath, path.join(tmp, 'package-lock.json'));
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], {
        cwd: tmp,
        env: { ...process.env, npm_config_update_notifier: 'false' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      pipeLines(child.stdout, onLog);
      pipeLines(child.stderr, onLog);
      child.on('exit', resolve);
      child.on('error', () => resolve(-1));
    });
    if (code !== 0) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new UserError(422, 'L’installation des dépendances du site a échoué (voir le journal).');
    }
    fs.rmSync(cached, { recursive: true, force: true });
    fs.renameSync(tmp, cached);
  } else {
    onLog('[paginity] dépendances déjà installées (cache)');
  }
  fs.rmSync(path.join(workDir, 'node_modules'), { recursive: true, force: true });
  // Liens physiques : pas de copie, les versions publiées restent en lecture seule.
  await new Promise<void>((resolve, reject) =>
    execFile('cp', ['-al', path.join(cached, 'node_modules'), path.join(workDir, 'node_modules')], (e) => (e ? reject(e) : resolve())),
  );
  // Les raccourcis de commandes (node_modules/.bin) sont des liens symboliques inutiles aux fonctions : retirés.
  for (const dir of [path.join(workDir, 'node_modules', '.bin')]) fs.rmSync(dir, { recursive: true, force: true });
  return fs.existsSync(path.join(cached, '.used')) ? 'cache' : (fs.writeFileSync(path.join(cached, '.used'), ''), 'installees');
}
