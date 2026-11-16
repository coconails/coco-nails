import fs from 'node:fs';
import path from 'node:path';
import { readManifest, TECHNICAL_FILES, type SiteManifest } from '../sites/manifest.js';
import { parsePagesYml, validateEntryValue } from '../content/schema.js';
import { UserError } from '../lib/util.js';
import { RULES_FILE } from '../servers/static.js';
import { scanForms } from '../functions/forms.js';
import { findSymlinks } from '../sites/files.js';

/**
 * Refuse tout lien symbolique dans le code d'un site : un lien peut pointer vers un fichier de PAGINITY
 * (clé du coffre, base…) et l'isolation « processus » de Node.js suit les liens (limite documentée).
 */
export function assertNoSymlinks(dir: string): void {
  const links = findSymlinks(dir, 10);
  if (links.length) {
    throw new UserError(
      422,
      `Le site contient ${links.length > 1 ? 'des liens symboliques' : 'un lien symbolique'} (${links.join(', ')}), refusé par sécurité : remplacez-le par une vraie copie du fichier.`,
      { liens: links },
    );
  }
}

/**
 * Fabrication d'une version : contrôles, copie du dossier publié, vérification des liens.
 * L'étape de préparation du site, elle, est exécutée à part, dans un environnement isolé (fabrication.ts).
 */

const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'avi', 'mkv', 'm4v']);
const MAX_FILE = 50 * 1024 * 1024;

function walkFiles(root: string, rel = ''): { rel: string; size: number }[] {
  const out: { rel: string; size: number }[] = [];
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) out.push(...walkFiles(root, r));
    else if (e.isFile()) out.push({ rel: r, size: fs.statSync(path.join(root, r)).size });
  }
  return out;
}

export interface CheckResult {
  manifest: SiteManifest;
  warnings: string[];
  files: number;
}

/** Contrôles avant fabrication, sur une copie figée du dépôt. */
export function checkSource(srcDir: string): CheckResult {
  assertNoSymlinks(srcDir);
  const manifest = readManifest(srcDir);
  const warnings = manifest.warnings.filter((w) => !w.startsWith('Fonctions serveur'));
  const errors: string[] = [];
  const pubDir = path.join(srcDir, manifest.publishDir === '.' ? '' : manifest.publishDir);
  if (!fs.existsSync(pubDir) || !fs.statSync(pubDir).isDirectory()) {
    throw new UserError(422, `Le dossier publié « ${manifest.publishDir} » n'existe pas. Corrigez la fiche du site (paginity.yml).`);
  }
  if (!fs.existsSync(path.join(pubDir, 'index.html'))) errors.push(`Il manque la page d'accueil « ${manifest.publishDir}/index.html ».`);
  const files = walkFiles(srcDir);
  let mediaTotal = 0;
  for (const f of files) {
    const ext = path.posix.extname(f.rel).slice(1).toLowerCase();
    if (f.size > MAX_FILE) errors.push(`Le fichier ${f.rel} dépasse 50 Mo.`);
    if (VIDEO_EXT.has(ext)) warnings.push(`Vidéo détectée (${f.rel}) : l'offre gratuite de Cloudflare interdit d'héberger des vidéos. Préférez YouTube ou Vimeo.`);
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'pdf', 'svg'].includes(ext)) mediaTotal += f.size;
    if ((ext === 'json' || ext === 'webmanifest') && f.size < 5 * 1024 * 1024 && !f.rel.includes('node_modules/')) {
      try {
        JSON.parse(fs.readFileSync(path.join(srcDir, f.rel), 'utf8'));
      } catch (e) {
        errors.push(`${f.rel} n'est pas un JSON valide (${(e as Error).message}).`);
      }
    }
  }
  if (mediaTotal > 500 * 1024 * 1024) warnings.push(`Les images et documents du site pèsent ${Math.round(mediaTotal / 1048576)} Mo (alerte au-delà de 500 Mo).`);
  const yml = path.join(srcDir, '.pages.yml');
  if (fs.existsSync(yml)) {
    const schema = parsePagesYml(fs.readFileSync(yml, 'utf8'));
    for (const entry of schema.entries) {
      if (entry.type !== 'file') continue;
      const p = path.join(srcDir, entry.path);
      if (!fs.existsSync(p)) continue;
      try {
        const value = JSON.parse(fs.readFileSync(p, 'utf8'));
        for (const err of validateEntryValue(entry, value).slice(0, 5)) errors.push(`${entry.label} › ${err.message}`);
      } catch {
        /* déjà signalé plus haut */
      }
    }
  }
  if (errors.length) {
    throw new UserError(422, `Publication arrêtée : ${errors.length} problème(s) à corriger. ${errors.slice(0, 6).join(' ')}${errors.length > 6 ? ' …' : ''}`, { erreurs: errors });
  }
  return { manifest, warnings, files: files.length };
}

/** Copie le dossier publié vers la destination, sans fichiers techniques ni fichiers cachés. */
export function buildOutput(srcDir: string, manifest: SiteManifest, outDir: string, version: string, extra: { functionsDir?: string | null } = {}): number {
  const pubDir = path.join(srcDir, manifest.publishDir === '.' ? '' : manifest.publishDir);
  const atRoot = manifest.publishDir === '.';
  let count = 0;
  fs.cpSync(pubDir, outDir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(pubDir, src);
      if (!rel) return true;
      const parts = rel.split(path.sep);
      if (parts.some((p) => p.startsWith('.') && p !== '.well-known')) return false;
      if (atRoot && TECHNICAL_FILES.includes(parts[0])) return false;
      if (parts.includes('node_modules')) return false;
      if (fs.lstatSync(src).isFile()) count++;
      return !fs.lstatSync(src).isSymbolicLink();
    },
  });
  // Règles (redirections, en-têtes) et numéro de version, lus par le serveur des sites. Fichier caché : jamais servi.
  fs.writeFileSync(
    path.join(outDir, RULES_FILE),
    JSON.stringify({ version, redirects: manifest.redirects, headers: manifest.headers, forms: scanForms(outDir), functionsDir: extra.functionsDir ?? null }),
  );
  return count;
}

/** Repère les liens internes cassés (avertissements, pas d'échec). */
export function checkLinks(outDir: string): string[] {
  const warnings: string[] = [];
  const index = path.join(outDir, 'index.html');
  if (!fs.existsSync(index) || fs.statSync(index).size === 0) throw new UserError(422, "La page d'accueil fabriquée est vide.");
  const html = walkFiles(outDir).filter((f) => f.rel.endsWith('.html') && f.size < 5 * 1024 * 1024);
  const re = /\b(?:href|src)\s*=\s*["']([^"'#?]+)[^"']*["']/gi;
  for (const f of html) {
    const text = fs.readFileSync(path.join(outDir, f.rel), 'utf8');
    for (const m of text.matchAll(re)) {
      const url = m[1].trim();
      if (!url || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\{|\$)/i.test(url)) continue;
      let target: string;
      try {
        target = decodeURIComponent(url.startsWith('/') ? url.slice(1) : path.posix.join(path.posix.dirname(f.rel), url));
      } catch {
        continue;
      }
      const abs = path.join(outDir, target);
      const ok =
        fs.existsSync(abs) && fs.statSync(abs).isFile()
          ? true
          : fs.existsSync(path.join(abs, 'index.html')) || fs.existsSync(`${abs}.html`) || target === '' || target.startsWith('api/') || target.startsWith('.netlify/');
      if (!ok) warnings.push(`Lien cassé dans ${f.rel} : ${url}`);
      if (warnings.length >= 20) return warnings;
    }
  }
  return warnings;
}

export function makeReadOnly(dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      makeReadOnly(p);
      fs.chmodSync(p, 0o555);
    } else if (e.isFile()) fs.chmodSync(p, 0o444);
  }
}

export function removeTree(dir: string): void {
  if (!fs.existsSync(dir)) return;
  const unlock = (d: string) => {
    fs.chmodSync(d, 0o755);
    for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) unlock(path.join(d, e.name));
  };
  try {
    unlock(dir);
  } catch {
    /* ignore */
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Remplace un lien symbolique de façon atomique (les visiteurs ne voient jamais d'état intermédiaire). */
export function swapSymlink(link: string, target: string): void {
  const tmp = `${link}.tmp-${process.pid}-${Date.now()}`;
  fs.symlinkSync(target, tmp);
  fs.renameSync(tmp, link);
}

export function readLink(link: string): string | null {
  try {
    return fs.readlinkSync(link);
  } catch {
    return null;
  }
}
