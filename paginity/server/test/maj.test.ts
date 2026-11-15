import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * P1-8 : le script de mise à jour paginity-maj, essayé pour de vrai dans un dossier temporaire.
 * Un faux PAGINITY minuscule remplace le vrai (même organisation des dossiers, même vérification « répond-il ? »),
 * pour tester les cas difficiles : version qui ne démarre pas après avoir modifié la base, fabrication en échec…
 */
const SCRIPT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'scripts', 'paginity-maj');

const SERVEUR = `import http from "node:http";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
const ici = new URL(".", import.meta.url).pathname;
if (fs.existsSync(ici + "migration")) {
  const d = new DatabaseSync(process.env.PAGINITY_DATA_DIR + "/plateforme/paginity.db");
  d.exec("UPDATE t SET v = 'abimee'"); d.close();
}
if (fs.existsSync(ici + "casse")) process.exit(1);
http.createServer((q, r) => r.end(JSON.stringify({ version: fs.readFileSync(ici + "version", "utf8").trim() }))).listen(Number(process.env.PORT), "127.0.0.1");
`;

function portLibre(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

describe('Mise à jour avec retour arrière (paginity-maj)', () => {
  let racine: string;
  let base: string;
  let donnees: string;
  let source: string;
  let env: NodeJS.ProcessEnv;
  const g = (...a: string[]) => execFileSync('git', ['-C', source, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  const valeur = () => {
    const d = new DatabaseSync(path.join(donnees, 'plateforme', 'paginity.db'));
    const v = (d.prepare('SELECT v FROM t').get() as { v: string }).v;
    d.close();
    return v;
  };
  const enService = () => fs.readFileSync(path.join(fs.realpathSync(path.join(base, 'actuelle')), 'version'), 'utf8').trim();
  // Nouvelle connexion à chaque fois (pas de connexion gardée ouverte vers un serveur arrêté entre-temps).
  const repond = () =>
    new Promise<string | null>((resolve) => {
      http
        .get({ host: '127.0.0.1', port: Number(env.PORT), path: '/', agent: false }, (res) => {
          let b = '';
          res.on('data', (d) => (b += d));
          res.on('end', () => resolve(JSON.parse(b).version));
        })
        .on('error', () => resolve(null));
    });
  function publier(version: string, extra: Record<string, string> = {}, build = 'node -e 0') {
    for (const f of ['casse', 'migration']) fs.rmSync(path.join(source, f), { force: true });
    fs.writeFileSync(path.join(source, 'version'), version);
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'faux', version: '1.0.0', scripts: { build, test: 'node -e 0' } }));
    for (const [f, c] of Object.entries(extra)) fs.writeFileSync(path.join(source, f), c);
    g('add', '-A');
    g('commit', '-qm', version);
  }
  const maj = () => spawnSync('bash', [SCRIPT, '--ref', 'main'], { env, encoding: 'utf8', timeout: 120_000 });

  beforeAll(async () => {
    racine = fs.mkdtempSync(path.join(os.tmpdir(), 'paginity-maj-'));
    base = path.join(racine, 'opt');
    donnees = path.join(racine, 'donnees');
    source = path.join(racine, 'depot');
    fs.mkdirSync(source);
    execFileSync('git', ['init', '-q', '-b', 'main', source]);
    fs.writeFileSync(path.join(source, 'serveur.mjs'), SERVEUR);
    fs.writeFileSync(path.join(source, 'package-lock.json'), JSON.stringify({ name: 'faux', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'faux', version: '1.0.0' } } }));
    publier('v0');
    // Installation initiale (ce que fera la phase 4).
    fs.mkdirSync(path.join(base, 'versions'), { recursive: true });
    execFileSync('git', ['clone', '-q', source, path.join(base, 'versions', 'v0')]);
    fs.symlinkSync(path.join(base, 'versions', 'v0'), path.join(base, 'actuelle'));
    fs.mkdirSync(path.join(donnees, 'plateforme'), { recursive: true });
    const d = new DatabaseSync(path.join(donnees, 'plateforme', 'paginity.db'));
    d.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('intacte')");
    d.close();
    const pid = path.join(racine, 'pid');
    const port = await portLibre();
    env = {
      PATH: process.env.PATH,
      HOME: racine,
      PORT: String(port),
      PAGINITY_MAJ_BASE: base,
      PAGINITY_DATA_DIR: donnees,
      PAGINITY_MAJ_SOURCE: source,
      PAGINITY_MAJ_ATTENTE: '5',
      PAGINITY_MAJ_SANTE: `http://127.0.0.1:${port}/api/etat`,
      PAGINITY_MAJ_DEMARRAGE: `cd "${base}/actuelle" && (node --disable-warning=ExperimentalWarning serveur.mjs >/dev/null 2>&1 & echo $! > "${pid}")`,
      PAGINITY_MAJ_ARRET: `kill $(cat "${pid}" 2>/dev/null) 2>/dev/null; sleep 0.5; true`,
      npm_config_cache: path.join(racine, 'npm-cache'),
    };
    execFileSync('sh', ['-c', env.PAGINITY_MAJ_DEMARRAGE!], { env });
    for (let i = 0; i < 50 && !(await repond()); i++) await new Promise((r) => setTimeout(r, 100));
    expect(await repond()).toBe('v0');
  });
  afterAll(() => {
    spawnSync('sh', ['-c', env.PAGINITY_MAJ_ARRET!], { env });
    fs.rmSync(racine, { recursive: true, force: true });
  });

  it('installe une nouvelle version qui fonctionne, après avoir copié la base', async () => {
    publier('v1');
    const r = maj();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Mise à jour réussie/);
    expect(enService()).toBe('v1');
    expect(await repond()).toBe('v1');
    expect(fs.readdirSync(path.join(donnees, 'sauvegardes')).filter((f) => f.startsWith('avant-maj-'))).toHaveLength(1);
  });

  it('ne fait rien si la version est déjà en service', () => {
    const r = maj();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Déjà à jour/);
  });

  it('revient en arrière tout seul si la nouvelle version ne démarre pas, base comprise', async () => {
    publier('v2', { migration: '1', casse: '1' });
    const r = maj();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/l'ancienne a été remise en service avec la base d'avant/);
    expect(enService()).toBe('v1');
    expect(await repond()).toBe('v1');
    expect(valeur()).toBe('intacte'); // la modification de la version ratée a été annulée
  });

  it('ne touche à rien si la fabrication échoue (PAGINITY n’est même pas arrêté)', async () => {
    publier('v3', {}, 'node -e "process.exit(1)"');
    const r = maj();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/la fabrication a échoué. Rien n'a changé/);
    expect(enService()).toBe('v1');
    expect(await repond()).toBe('v1');
    expect(fs.readdirSync(path.join(base, 'versions')).filter((f) => f.startsWith('.en-preparation'))).toEqual([]);
  });

  it('refuse deux mises à jour en même temps', () => {
    const fd = fs.openSync(path.join(base, '.maj.verrou'), 'w');
    const verrou = spawnSync('bash', ['-c', `exec 9>"${base}/.maj.verrou"; flock -n 9 && bash "${SCRIPT}" --ref main`], { env, encoding: 'utf8' });
    fs.closeSync(fd);
    expect(verrou.stderr).toMatch(/une autre mise à jour est déjà en cours/);
  });
});
