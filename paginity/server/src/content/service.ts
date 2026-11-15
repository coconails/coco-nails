import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Ctx } from '../context.js';
import type { UserRow } from '../auth/service.js';
import { authorOf, type SiteRow } from '../sites/service.js';
import { currentVersion, resolveIn, writeChecked } from '../sites/files.js';
import { contentVersion, UserError } from '../lib/util.js';
import { inferEntry, parsePagesYml, serializeLike, validateEntryValue, type Entry, type Schema } from './schema.js';

const IGNORED_JSON = /(^|\/)(package(-lock)?\.json|manifest\.json|tsconfig\.json|.*\.webmanifest|.*\.map)$/i;

/** Schéma de contenu d'un site : `.pages.yml` s'il existe, sinon déduction depuis les JSON du dossier publié. */
export function loadSchema(ctx: Ctx, site: SiteRow): Schema {
  const repoDir = ctx.sites.repoDir(site);
  const yml = path.join(repoDir, '.pages.yml');
  if (fs.existsSync(yml)) {
    const s = parsePagesYml(fs.readFileSync(yml, 'utf8'));
    // Les collections sont présentées comme une liste de fichiers JSON du dossier indiqué.
    return s;
  }
  const manifest = ctx.sites.manifest(site);
  const publishRoot = path.join(repoDir, manifest.publishDir === '.' ? '' : manifest.publishDir);
  const entries: Entry[] = [];
  const warnings: string[] = ['Aucun fichier .pages.yml : les champs ont été déduits automatiquement de vos fichiers JSON.'];
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || entries.length >= 50 || !fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.json')) {
        const rel = path.relative(repoDir, abs).split(path.sep).join('/');
        if (IGNORED_JSON.test(rel) || fs.statSync(abs).size > 512 * 1024) continue;
        try {
          const entry = inferEntry(rel, JSON.parse(fs.readFileSync(abs, 'utf8')));
          if (entry) entries.push(entry);
        } catch {
          warnings.push(`${rel} n'est pas un JSON valide : corrigez-le dans le mode code.`);
        }
      }
    }
  };
  walk(publishRoot, 0);
  const imgDir = ['images', 'img', 'assets/images', 'medias'].find((d) => fs.existsSync(path.join(publishRoot, d)));
  const prefix = manifest.publishDir === '.' ? '' : `${manifest.publishDir}/`;
  return {
    source: 'automatique',
    media: { input: `${prefix}${imgDir ?? 'images'}`, output: `/${imgDir ?? 'images'}` },
    entries,
    warnings,
  };
}

function findEntry(schema: Schema, name: string): Entry {
  const e = schema.entries.find((x) => x.name === name);
  if (!e) throw new UserError(404, 'Rubrique de contenu introuvable.');
  if (e.type === 'collection') throw new UserError(400, 'Les collections ne sont pas encore modifiables par formulaire : utilisez le mode code.');
  return e;
}

function parseValue(entry: Entry, text: string): unknown {
  try {
    return entry.format === 'yaml' ? YAML.parse(text) : JSON.parse(text);
  } catch (e) {
    throw new UserError(422, `Le fichier ${entry.path} contient une erreur et ne peut pas être affiché en formulaire : ${(e as Error).message}. Corrigez-le dans le mode code.`);
  }
}

export function readEntry(ctx: Ctx, site: SiteRow, name: string) {
  const schema = loadSchema(ctx, site);
  const entry = findEntry(schema, name);
  const repoDir = ctx.sites.repoDir(site);
  const r = resolveIn(repoDir, entry.path);
  let value: unknown = entry.list ? [] : {};
  let version: string | null = null;
  if (fs.existsSync(r.abs)) {
    const text = fs.readFileSync(r.abs, 'utf8');
    value = parseValue(entry, text);
    version = contentVersion(Buffer.from(text, 'utf8'));
  }
  return { entree: entry, valeur: value, version, media: schema.media, dossierPublie: ctx.sites.manifest(site).publishDir };
}

export async function saveEntry(ctx: Ctx, site: SiteRow, user: UserRow, name: string, value: unknown, baseVersion: unknown) {
  return ctx.sites.lock(site.id, async () => {
    const schema = loadSchema(ctx, site);
    const entry = findEntry(schema, name);
    const errors = validateEntryValue(entry, value);
    if (errors.length) throw new UserError(422, 'Certains champs sont à corriger.', { champs: errors });
    const repoDir = ctx.sites.repoDir(site);
    const r = resolveIn(repoDir, entry.path);
    const original = fs.existsSync(r.abs) ? fs.readFileSync(r.abs, 'utf8') : null;
    const base = typeof baseVersion === 'string' ? baseVersion : original === null ? null : undefined;
    if (base === undefined) throw new UserError(400, 'Version du contenu manquante : rechargez la page.');
    const text = serializeLike(original, value, entry.format);
    const w = writeChecked(repoDir, entry.path, text, base);
    const commit = await ctx.sites.repo(site).commitPaths([w.rel], `Contenus : ${entry.label}`, authorOf(user));
    return { version: w.version, enregistre: commit !== null };
  });
}

export function entryVersion(ctx: Ctx, site: SiteRow, rel: string): string | null {
  return currentVersion(resolveIn(ctx.sites.repoDir(site), rel).abs);
}
