import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import type { Ctx } from '../context.js';
import type { UserRow } from '../auth/service.js';
import { authorOf, type SiteRow } from './service.js';
import { extOf, isText, listTree, resolveIn } from './files.js';
import { slugify, UserError } from '../lib/util.js';
import { loadSchema } from '../content/service.js';

/**
 * Médiathèque : ajout, remplacement et suppression contrôlée des images et documents publics.
 * Les images sont redressées, réduites (2 560 px maximum), compressées et débarrassées de leurs
 * métadonnées (dont la position GPS). Le vrai type de fichier est vérifié, pas seulement l'extension.
 */

export const MEDIA_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'svg', 'pdf', 'ico']);
const MAX_INPUT = 25 * 1024 * 1024;
const MAX_IMAGE = 2 * 1024 * 1024;
const MAX_PDF = 10 * 1024 * 1024;
const MAX_DIM = 2560;

function publishRoot(ctx: Ctx, site: SiteRow): { rel: string; abs: string } {
  const pd = ctx.sites.manifest(site).publishDir;
  return { rel: pd === '.' ? '' : pd, abs: path.join(ctx.sites.repoDir(site), pd === '.' ? '' : pd) };
}

export function mediaDir(ctx: Ctx, site: SiteRow): string {
  const schema = loadSchema(ctx, site);
  if (schema.media?.input) return schema.media.input;
  const pr = publishRoot(ctx, site).rel;
  return pr ? `${pr}/images` : 'images';
}

/** Adresse publique d'un fichier du dépôt (ex. public/images/a.webp → /images/a.webp). */
export function publicUrlOf(ctx: Ctx, site: SiteRow, rel: string): string | null {
  const pr = publishRoot(ctx, site).rel;
  if (!pr) return `/${rel}`;
  return rel.startsWith(`${pr}/`) ? rel.slice(pr.length) : null;
}

export function listMedia(ctx: Ctx, site: SiteRow) {
  const repoDir = ctx.sites.repoDir(site);
  return listTree(repoDir)
    .filter((e) => e.type === 'fichier' && MEDIA_EXT.has(extOf(e.chemin)))
    .map((e) => ({ chemin: e.chemin, url: publicUrlOf(ctx, site, e.chemin), taille: e.taille, type: extOf(e.chemin) === 'pdf' ? 'document' : 'image' }));
}

function safeName(original: string, ext: string): string {
  const base = slugify(path.parse(original).name) || 'fichier';
  return `${base}.${ext}`;
}

async function processImage(buf: Buffer, format: string): Promise<{ data: Buffer; ext: string }> {
  if (format === 'gif') {
    if (buf.length > MAX_IMAGE) throw new UserError(400, 'Cette image animée dépasse 2 Mo. Réduisez-la avant de l’envoyer.');
    return { data: buf, ext: 'gif' };
  }
  let img = sharp(buf, { failOn: 'error', limitInputPixels: 80_000_000 }).rotate().resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true });
  let ext = format === 'jpeg' ? 'jpg' : format;
  if (format === 'jpeg') img = img.jpeg({ quality: 82, mozjpeg: true });
  else if (format === 'png') img = img.png({ compressionLevel: 9, palette: true, quality: 90 });
  else if (format === 'webp') img = img.webp({ quality: 80 });
  else if (format === 'avif') img = img.avif({ quality: 55 });
  else {
    img = img.webp({ quality: 80 });
    ext = 'webp';
  }
  let data = await img.toBuffer();
  if (data.length > MAX_IMAGE) {
    // Deuxième essai plus compressé, puis refus.
    data = await sharp(data).resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true }).toFormat(ext === 'jpg' ? 'jpeg' : (ext as any), { quality: 70 }).toBuffer();
    if (data.length > MAX_IMAGE) throw new UserError(400, 'Même compressée, cette image dépasse 2 Mo.');
  }
  return { data, ext };
}

export async function uploadMedia(ctx: Ctx, site: SiteRow, user: UserRow, file: { buffer: Buffer; filename: string }, replace?: string) {
  if (file.buffer.length > MAX_INPUT) throw new UserError(413, 'Fichier trop lourd (25 Mo maximum à l’envoi).');
  const head = file.buffer.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (extOf(file.filename) === 'svg' || head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    throw new UserError(400, 'Les images SVG peuvent contenir du code caché : elles ne sont pas acceptées dans la médiathèque. Utilisez le mode code si nécessaire.');
  }
  const type = await fileTypeFromBuffer(file.buffer);
  if (!type) throw new UserError(400, 'Type de fichier non reconnu. Formats acceptés : JPEG, PNG, WebP, GIF, AVIF, PDF.');
  if (type.ext === 'heic' || type.mime === 'image/heic' || type.mime === 'image/heif') {
    throw new UserError(
      400,
      'Format HEIC (photo d’iPhone) pas encore pris en charge. Sur l’iPhone : Réglages › Appareil photo › Formats › « Le plus compatible », ou partagez la photo en JPEG.',
    );
  }
  let out: { data: Buffer; ext: string };
  if (type.ext === 'pdf') {
    if (file.buffer.length > MAX_PDF) throw new UserError(400, 'Ce PDF dépasse 10 Mo.');
    out = { data: file.buffer, ext: 'pdf' };
  } else if (['jpg', 'png', 'webp', 'gif', 'avif'].includes(type.ext)) {
    try {
      out = await processImage(file.buffer, type.ext === 'jpg' ? 'jpeg' : type.ext);
    } catch (e) {
      if (e instanceof UserError) throw e;
      throw new UserError(400, 'Cette image est endommagée ou illisible.');
    }
  } else {
    throw new UserError(400, `Le type « ${type.ext} » n’est pas accepté. Formats acceptés : JPEG, PNG, WebP, GIF, AVIF, PDF.`);
  }

  return ctx.sites.lock(site.id, async () => {
    const repoDir = ctx.sites.repoDir(site);
    let rel: string;
    if (replace) {
      const r = resolveIn(repoDir, replace);
      if (!fs.existsSync(r.abs) || !MEDIA_EXT.has(extOf(r.rel))) throw new UserError(404, 'Fichier à remplacer introuvable.');
      const targetExt = extOf(r.rel).replace('jpeg', 'jpg');
      if (targetExt !== out.ext) {
        if (out.ext === 'pdf' || targetExt === 'pdf' || targetExt === 'gif') throw new UserError(400, `Le remplacement doit être du même type (${targetExt}).`);
        out = { data: await sharp(out.data).toFormat(targetExt === 'jpg' ? 'jpeg' : (targetExt as any), { quality: 82 }).toBuffer(), ext: targetExt };
      }
      rel = r.rel;
    } else {
      const dir = mediaDir(ctx, site);
      let name = safeName(file.filename, out.ext);
      let i = 2;
      while (fs.existsSync(path.join(repoDir, dir, name))) name = safeName(`${path.parse(file.filename).name}-${i++}`, out.ext);
      rel = resolveIn(repoDir, `${dir}/${name}`).rel;
    }
    const abs = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, out.data);
    await ctx.sites.repo(site).commitPaths([rel], replace ? `Médias : remplacement de ${path.basename(rel)}` : `Médias : ajout de ${path.basename(rel)}`, authorOf(user));
    return { chemin: rel, url: publicUrlOf(ctx, site, rel), taille: out.data.length };
  });
}

/** Pages et contenus qui mentionnent un fichier (pour éviter de casser le site en le supprimant). */
export function findReferences(ctx: Ctx, site: SiteRow, rel: string): string[] {
  const repoDir = ctx.sites.repoDir(site);
  const url = publicUrlOf(ctx, site, rel);
  const needles = [path.posix.basename(rel)];
  if (url) needles.push(url);
  const refs: string[] = [];
  for (const e of listTree(repoDir)) {
    if (e.type !== 'fichier' || !isText(e.chemin) || e.chemin === rel || e.taille > 2 * 1024 * 1024) continue;
    const text = fs.readFileSync(path.join(repoDir, e.chemin), 'utf8');
    if (needles.some((n) => text.includes(n))) refs.push(e.chemin);
  }
  return refs;
}

export async function deleteMedia(ctx: Ctx, site: SiteRow, user: UserRow, relInput: unknown, force: boolean) {
  return ctx.sites.lock(site.id, async () => {
    const repoDir = ctx.sites.repoDir(site);
    const r = resolveIn(repoDir, relInput);
    if (!fs.existsSync(r.abs) || !MEDIA_EXT.has(extOf(r.rel))) throw new UserError(404, 'Fichier introuvable.');
    const refs = findReferences(ctx, site, r.rel);
    if (refs.length && !force) {
      throw new UserError(409, 'Ce fichier est encore utilisé. Le supprimer pourrait laisser une image manquante sur le site.', { utilisations: refs });
    }
    fs.rmSync(r.abs);
    await ctx.sites.repo(site).commitPaths([r.rel], `Médias : suppression de ${path.basename(r.rel)}`, authorOf(user));
    return { supprime: r.rel };
  });
}
