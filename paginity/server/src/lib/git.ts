import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';

/**
 * Petite interface autour du logiciel Git (le même que GitHub utilise), sans service en ligne.
 * Chaque site a son propre dépôt ; chaque enregistrement crée un point d'historique.
 * L'historique n'est jamais réécrit : annuler ou restaurer crée toujours un nouveau point.
 */
export interface Author {
  name: string;
  email: string;
}

const BASE_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  LANG: 'C.UTF-8',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  HOME: '/nonexistent',
};

const BASE_ARGS = [
  '-c', 'core.quotepath=off',
  '-c', 'commit.gpgsign=false',
  '-c', 'tag.gpgsign=false',
  '-c', 'user.name=PAGINITY',
  '-c', 'user.email=paginity@localhost',
  '-c', 'core.autocrlf=false',
  '-c', 'core.symlinks=false',
  '-c', 'init.defaultBranch=main',
];

export class GitError extends Error {
  constructor(message: string, public stderr: string) {
    super(message);
  }
}

export function git(cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...BASE_ARGS, ...args],
      { cwd, env: { ...BASE_ENV, ...opts.env }, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) reject(new GitError(`git ${args[0]} a échoué : ${stderr || err.message}`, stderr));
        else resolve(stdout);
      },
    );
  });
}

function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', [...BASE_ARGS, ...args], { cwd, env: BASE_ENV, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (err) reject(new GitError(`git ${args[0]} a échoué : ${stderr.toString() || err.message}`, stderr.toString()));
      else resolve(stdout);
    });
  });
}

export class Repo {
  constructor(public dir: string) {}

  async init(): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
    await git(this.dir, ['init', '-q', '-b', 'main']);
  }

  /** Enregistre tout l'état du dossier. Renvoie l'identifiant du point créé, ou null s'il n'y avait rien à enregistrer. */
  async commitAll(message: string, author: Author): Promise<string | null> {
    await git(this.dir, ['add', '-A']);
    const status = await git(this.dir, ['status', '--porcelain']);
    if (!status.trim()) return null;
    await git(this.dir, ['commit', '-q', '-m', message, `--author=${sanitizeAuthor(author)}`]);
    return this.head();
  }

  /** Enregistre seulement certains chemins (évite d'emporter les modifications d'autres personnes). */
  async commitPaths(paths: string[], message: string, author: Author): Promise<string | null> {
    await git(this.dir, ['add', '-A', '--', ...paths]);
    const staged = await git(this.dir, ['diff', '--cached', '--name-only']);
    if (!staged.trim()) return null;
    await git(this.dir, ['commit', '-q', '-m', message, `--author=${sanitizeAuthor(author)}`]);
    return this.head();
  }

  async head(): Promise<string | null> {
    try {
      return (await git(this.dir, ['rev-parse', 'HEAD'])).trim();
    } catch {
      return null;
    }
  }

  async tag(name: string, commit: string): Promise<void> {
    await git(this.dir, ['tag', '-f', name, commit]);
  }

  async resolve(rev: string): Promise<string | null> {
    try {
      return (await git(this.dir, ['rev-parse', '--verify', '-q', `${rev}^{commit}`])).trim();
    } catch {
      return null;
    }
  }

  /** Liste des fichiers d'une version : chemin et taille. */
  async listFiles(rev: string): Promise<{ path: string; size: number }[]> {
    const out = await git(this.dir, ['ls-tree', '-r', '-l', '-z', rev]);
    return out
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const [meta, p] = line.split('\t');
        const parts = meta.split(/\s+/);
        return { path: p, size: Number(parts[3]) || 0 };
      });
  }

  async show(rev: string, filePath: string): Promise<Buffer | null> {
    try {
      return await gitBuffer(this.dir, ['show', `${rev}:${filePath}`]);
    } catch {
      return null;
    }
  }

  /** Différences entre deux versions : liste des fichiers ajoutés (A), modifiés (M), supprimés (D), renommés (R). */
  async diffNameStatus(from: string | null, to: string): Promise<{ status: string; path: string; oldPath?: string }[]> {
    const args = from ? ['diff', '--name-status', '-z', '-M', from, to] : ['show', '--name-status', '-z', '--format=', '-M', '--root', to];
    if (!from) {
      // Aucune publication : tout ce qui existe est « ajouté ».
      return (await this.listFiles(to)).map((f) => ({ status: 'A', path: f.path }));
    }
    const out = await git(this.dir, args);
    const parts = out.split('\0').filter((p) => p !== '');
    const res: { status: string; path: string; oldPath?: string }[] = [];
    for (let i = 0; i < parts.length; i++) {
      const st = parts[i];
      if (st.startsWith('R') || st.startsWith('C')) {
        res.push({ status: 'R', oldPath: parts[i + 1], path: parts[i + 2] });
        i += 2;
      } else {
        res.push({ status: st.charAt(0), path: parts[i + 1] });
        i += 1;
      }
    }
    return res;
  }

  /** Historique des enregistrements. */
  async log(opts: { limit?: number; range?: string; path?: string } = {}): Promise<{ hash: string; at: number; author: string; email: string; message: string }[]> {
    const args = ['log', `--max-count=${opts.limit ?? 50}`, '--format=%H%x1f%at%x1f%an%x1f%ae%x1f%s%x1e'];
    if (opts.range) args.push(opts.range);
    if (opts.path) args.push('--', opts.path);
    let out = '';
    try {
      out = await git(this.dir, args);
    } catch {
      return [];
    }
    return out
      .split('\x1e')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((rec) => {
        const [hash, at, author, email, message] = rec.split('\x1f');
        return { hash, at: Number(at) * 1000, author, email, message };
      });
  }

  /** Remet le dossier de travail exactement dans l'état d'une version (fichiers en trop supprimés). */
  async resetTreeTo(rev: string): Promise<void> {
    await git(this.dir, ['read-tree', '-u', '--reset', rev]);
    await git(this.dir, ['clean', '-fdq']);
  }

  /** Remet un seul fichier dans l'état d'une version (ou le supprime s'il n'y existait pas). */
  async restorePath(rev: string, filePath: string): Promise<void> {
    const exists = await this.show(rev, filePath);
    if (exists === null) {
      await git(this.dir, ['rm', '-q', '-f', '--ignore-unmatch', '--', filePath]);
      fs.rmSync(`${this.dir}/${filePath}`, { force: true });
    } else {
      await git(this.dir, ['checkout', rev, '--', filePath]);
    }
  }

  /** Extrait un dossier d'une version vers une destination (sans l'historique). */
  async extract(rev: string, subdir: string, dest: string): Promise<void> {
    fs.mkdirSync(dest, { recursive: true });
    const treeish = subdir && subdir !== '.' ? `${rev}:${subdir}` : rev;
    await new Promise<void>((resolve, reject) => {
      const g = spawn('git', [...BASE_ARGS, 'archive', '--format=tar', treeish], { cwd: this.dir, env: BASE_ENV });
      const t = spawn('tar', ['-x', '-C', dest, '--no-same-owner', '--no-same-permissions'], { env: BASE_ENV });
      let err = '';
      g.stderr.on('data', (d) => (err += d));
      t.stderr.on('data', (d) => (err += d));
      g.stdout.pipe(t.stdin);
      let done = 0;
      let failed = false;
      const finish = (code: number | null) => {
        if (code !== 0) failed = true;
        if (++done === 2) failed ? reject(new GitError(`Extraction impossible : ${err}`, err)) : resolve();
      };
      g.on('close', finish);
      t.on('close', finish);
      g.on('error', reject);
      t.on('error', reject);
    });
  }

  async bundle(dest: string): Promise<void> {
    await git(this.dir, ['bundle', 'create', dest, '--all']);
  }
}

function sanitizeAuthor(a: Author): string {
  const name = a.name.replace(/[<>\n]/g, '').trim() || 'Utilisateur';
  const email = a.email.replace(/[<>\s]/g, '') || 'inconnu@localhost';
  return `${name} <${email}>`;
}
