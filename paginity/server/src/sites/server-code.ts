import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../context.js';
import type { UserRow } from '../auth/service.js';
import type { SiteRow } from './service.js';
import { UserError } from '../lib/util.js';

/**
 * Code exécuté SUR LE SERVEUR : réservé au propriétaire de la plateforme (avant d'accueillir des sites de clients).
 * - les fonctions serveur (dossier des fonctions) ;
 * - les réglages de fabrication et les dépendances (paginity.yml, netlify.toml, package.json, .npmrc…) ;
 * - tout script (js, mjs, ts…) placé hors du dossier publié : l'étape de préparation peut l'exécuter.
 * Le reste (pages, styles, images, scripts du navigateur dans le dossier publié, contenus) reste modifiable
 * par les administrateurs du site.
 */
const CONFIG_FILES = new Set(['paginity.yml', 'paginity.yaml', 'netlify.toml', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json', '.npmrc', '.nvmrc', '.node-version']);
const SCRIPT_EXT = /\.(js|mjs|cjs|ts|mts|cts|jsx|tsx|node|wasm|sh)$/i;

export function isServerCode(ctx: Ctx, site: SiteRow, rel: string): boolean {
  const m = ctx.sites.manifest(site);
  const norm = rel.replace(/^\.\/+/, '').replace(/\/+$/, '');
  const inside = (dir: string | null | undefined) => !!dir && dir !== '.' && (norm === dir || norm.startsWith(`${dir}/`));
  if (CONFIG_FILES.has(norm)) return true;
  for (const dir of [m.functionsDir, 'netlify/functions', 'netlify/edge-functions']) if (inside(dir)) return true;
  if (SCRIPT_EXT.test(norm) && !inside(m.publishDir)) return true;
  return false;
}

/** Refuse à un non-propriétaire toute écriture (création, modification, renommage, suppression) dans le code serveur. */
export function assertMayWrite(ctx: Ctx, site: SiteRow, user: UserRow, rels: string[]): void {
  if (user.is_owner) return;
  const root = ctx.sites.repoDir(site);
  for (const rel of rels) {
    const touched = [rel, ...filesUnder(root, rel)];
    if (touched.some((r) => isServerCode(ctx, site, r))) {
      throw new UserError(
        403,
        'Ce fichier fait partie du code exécuté sur le serveur (fonctions, préparation, réglages de fabrication ou dépendances) : seul le propriétaire de la plateforme peut le modifier.',
      );
    }
  }
}

/** Fichiers contenus dans un dossier (pour une suppression ou un renommage de dossier). */
function filesUnder(root: string, rel: string): string[] {
  const abs = path.join(root, rel);
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!st?.isDirectory()) return [];
  const out: string[] = [];
  const walk = (d: string, r: string, depth: number) => {
    if (depth > 12) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const rr = `${r}/${e.name}`;
      if (e.isDirectory()) walk(path.join(d, e.name), rr, depth + 1);
      else out.push(rr);
    }
  };
  walk(abs, rel.replace(/\/+$/, ''), 0);
  return out;
}

/** Revenir à une ancienne version : refusé à un non-propriétaire si cela changerait du code serveur. */
export async function assertMayRestore(ctx: Ctx, site: SiteRow, user: UserRow, rev: string): Promise<void> {
  if (user.is_owner) return;
  const changes = await ctx.sites.repo(site).diffNameStatus(rev, 'HEAD');
  const paths = changes.flatMap((c) => (c.oldPath ? [c.oldPath, c.path] : [c.path]));
  if (paths.some((p) => isServerCode(ctx, site, p))) {
    throw new UserError(
      403,
      'Revenir à cette version modifierait le code exécuté sur le serveur (fonctions, préparation…) : seul le propriétaire de la plateforme peut le faire.',
    );
  }
}
