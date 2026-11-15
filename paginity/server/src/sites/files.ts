import fs from 'node:fs';
import path from 'node:path';
import { contentVersion, UserError } from '../lib/util.js';

/**
 * Accès sûr aux fichiers d'un site : impossible de sortir du dossier du site,
 * d'atteindre l'historique Git (.git) ou de suivre un lien symbolique.
 */

export const TEXT_EXTENSIONS = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'json', 'md', 'txt', 'xml', 'svg', 'yml', 'yaml', 'toml', 'webmanifest', 'ts', 'csv', 'map', 'ics',
]);
export const MAX_TEXT_SIZE = 2 * 1024 * 1024;

export function normalizeRel(rel: unknown): string {
  if (typeof rel !== 'string' || !rel.trim()) throw new UserError(400, 'Chemin de fichier manquant.');
  if (rel.includes('\0') || rel.includes('\\')) throw new UserError(400, 'Chemin de fichier invalide.');
  const n = path.posix.normalize(rel.trim().replace(/^\/+/, ''));
  if (!n || n === '.' || n.startsWith('../') || n === '..' || path.posix.isAbsolute(n)) throw new UserError(400, 'Chemin de fichier invalide.');
  const parts = n.split('/');
  if (parts.some((p) => p === '.git' || p === '..' || p === '')) throw new UserError(400, 'Ce chemin est réservé.');
  if (n.length > 300) throw new UserError(400, 'Chemin trop long.');
  return n;
}

/** Chemin absolu sûr à l'intérieur du dépôt. */
export function resolveIn(root: string, rel: unknown): { rel: string; abs: string } {
  const n = normalizeRel(rel);
  const abs = path.join(root, n);
  if (!abs.startsWith(root + path.sep)) throw new UserError(400, 'Chemin de fichier invalide.');
  // Aucun lien symbolique sur le trajet.
  let cur = root;
  for (const part of n.split('/')) {
    cur = path.join(cur, part);
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) throw new UserError(400, 'Les liens symboliques ne sont pas autorisés.');
    } catch (e) {
      if (e instanceof UserError) throw e;
      break; // n'existe pas encore
    }
  }
  return { rel: n, abs };
}

export function extOf(p: string): string {
  return path.posix.extname(p).slice(1).toLowerCase();
}

export function isText(p: string): boolean {
  return TEXT_EXTENSIONS.has(extOf(p)) || path.posix.basename(p).startsWith('.') || ['_redirects', '_headers', 'LICENSE', 'README'].includes(path.posix.basename(p));
}

export interface TreeEntry {
  chemin: string;
  type: 'fichier' | 'dossier';
  taille: number;
  texte: boolean;
}

export function listTree(root: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  const walk = (dir: string, prefix: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, 'fr');
    });
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules' || e.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push({ chemin: rel, type: 'dossier', taille: 0, texte: false });
        walk(path.join(dir, e.name), rel);
      } else if (e.isFile()) {
        out.push({ chemin: rel, type: 'fichier', taille: fs.statSync(path.join(dir, e.name)).size, texte: isText(rel) });
      }
    }
  };
  walk(root, '');
  return out;
}

export function readText(root: string, rel: unknown): { rel: string; content: string; version: string } {
  const r = resolveIn(root, rel);
  if (!fs.existsSync(r.abs) || !fs.statSync(r.abs).isFile()) throw new UserError(404, 'Fichier introuvable.');
  if (!isText(r.rel)) throw new UserError(400, 'Ce fichier n’est pas un fichier texte modifiable.');
  const buf = fs.readFileSync(r.abs);
  if (buf.length > MAX_TEXT_SIZE) throw new UserError(400, 'Fichier trop volumineux pour l’éditeur (2 Mo maximum).');
  return { rel: r.rel, content: buf.toString('utf8'), version: contentVersion(buf) };
}

export function currentVersion(abs: string): string | null {
  if (!fs.existsSync(abs)) return null;
  return contentVersion(fs.readFileSync(abs));
}

/**
 * Écrit un fichier seulement s'il n'a pas changé depuis son ouverture (protection anti-écrasement).
 * `baseVersion` null = création d'un nouveau fichier (refusée s'il existe déjà).
 */
export function writeChecked(root: string, rel: unknown, content: string | Buffer, baseVersion: string | null | undefined): { rel: string; version: string } {
  const r = resolveIn(root, rel);
  const cur = currentVersion(r.abs);
  if (baseVersion === null && cur !== null) throw new UserError(409, 'Un fichier porte déjà ce nom.');
  if (baseVersion !== undefined && baseVersion !== null && cur !== baseVersion) {
    throw new UserError(409, 'Ce fichier a été modifié ailleurs entre-temps (autre onglet, autre personne ou autre mode). Rien n’a été écrasé.', {
      conflit: true,
      versionActuelle: cur,
    });
  }
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  if (typeof content === 'string' && buf.length > MAX_TEXT_SIZE) throw new UserError(400, 'Fichier trop volumineux (2 Mo maximum).');
  fs.mkdirSync(path.dirname(r.abs), { recursive: true });
  const tmp = `${r.abs}.paginity-tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, r.abs);
  return { rel: r.rel, version: contentVersion(buf) };
}

/** Vérifications simples avant d'enregistrer un fichier texte (JSON valide, etc.). */
export function validateText(rel: string, content: string): string[] {
  const errors: string[] = [];
  const ext = extOf(rel);
  if (ext === 'json' || ext === 'webmanifest') {
    try {
      JSON.parse(content);
    } catch (e) {
      errors.push(`JSON invalide : ${(e as Error).message}`);
    }
  }
  return errors;
}

/** Liste les liens symboliques d'un dossier (chemins relatifs), sans les suivre. Le dossier .git est ignoré. */
export function findSymlinks(root: string, max = 50): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    if (out.length >= max) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' && !rel) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) out.push(r);
      else if (e.isDirectory()) walk(path.join(dir, e.name), r);
      if (out.length >= max) return;
    }
  };
  if (fs.existsSync(root)) walk(root, '');
  return out;
}
