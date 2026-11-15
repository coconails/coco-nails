import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import { previewOrigin } from '../config.js';
import { getUser, type UserRow } from '../auth/service.js';
import { audit } from '../lib/audit.js';
import { now, UserError } from '../lib/util.js';
import { authorOf, isRole, ROLE_LABEL, ROLE_RANK } from '../sites/service.js';
import { extOf, isText, listTree, readText, resolveIn, validateText, writeChecked } from '../sites/files.js';
import { deleteMedia, listMedia, uploadMedia } from '../sites/media.js';
import { createFromTemplate, exportSite, listTemplates } from '../sites/import.js';
import { loadSchema, readEntry, saveEntry } from '../content/service.js';
import type { Entry, Field } from '../content/schema.js';
import { buildPreview } from '../publish/pipeline.js';
import { previewToken } from '../servers/sites.js';
import { body, ipOf, requireOwner, requireSudo, requireUser } from './helpers.js';

// ---------------------------------------------------------------------------
// Présence : « qui modifie quoi » (en mémoire, renouvelée toutes les 20 secondes par les navigateurs)
// ---------------------------------------------------------------------------
const presence = new Map<string, Map<string, { nom: string; userId: string; at: number }>>();
function touchPresence(siteId: string, rel: string, user: UserRow) {
  const key = `${siteId}:${rel}`;
  const m = presence.get(key) ?? new Map();
  m.set(user.id, { nom: user.name, userId: user.id, at: now() });
  presence.set(key, m);
}
export function othersEditing(siteId: string, rel: string, userId: string): string[] {
  const m = presence.get(`${siteId}:${rel}`);
  if (!m) return [];
  const limit = now() - 45_000;
  const res: string[] = [];
  for (const [id, p] of m) {
    if (p.at < limit) m.delete(id);
    else if (id !== userId) res.push(p.nom);
  }
  return res;
}

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', svg: 'image/svg+xml', pdf: 'application/pdf',
};

function siteParam(req: FastifyRequest): string {
  return (req.params as { id: string }).id;
}

function labelPath(entry: Entry | undefined, parts: string[]): string {
  const out: string[] = [];
  let fields: Field[] | undefined = entry?.fields;
  if (entry?.list && /^\d+$/.test(parts[0] ?? '')) {
    out.push(`n°${Number(parts[0]) + 1}`);
    parts = parts.slice(1);
  }
  for (const p of parts) {
    if (/^\d+$/.test(p)) {
      out.push(`n°${Number(p) + 1}`);
      continue;
    }
    const f = fields?.find((x) => x.name === p);
    out.push(f?.label ?? p);
    fields = f?.fields;
  }
  return out.join(' › ');
}

function flatten(v: unknown, prefix: string[] = [], out = new Map<string, unknown>()): Map<string, unknown> {
  if (v && typeof v === 'object') {
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v);
    if (entries.length === 0) out.set(prefix.join('\u0000'), Array.isArray(v) ? '(liste vide)' : '(vide)');
    for (const [k, x] of entries) flatten(x, [...prefix, k], out);
  } else out.set(prefix.join('\u0000'), v);
  return out;
}

export function registerSiteRoutes(app: FastifyInstance, ctx: Ctx): void {
  // ------------------------------------------------------------------ tableau de bord et liste
  app.get('/api/sites', async (req) => {
    const { user } = requireUser(req);
    return Promise.all(ctx.sites.accessibleSites(user).map((s) => ctx.sites.summary(s, ctx.sites.role(user, s.id)!)));
  });

  app.get('/api/modeles', async (req) => {
    requireUser(req);
    return listTemplates(ctx);
  });

  app.post('/api/sites', async (req) => {
    const { user } = requireUser(req);
    if (!user.is_owner) throw new UserError(403, 'Seul le propriétaire peut créer des sites.');
    const b = body<{ nom?: string; modele?: string }>(req);
    const site = await createFromTemplate(ctx, user, String(b.nom ?? ''), String(b.modele ?? 'vitrine'));
    return ctx.sites.summary(site, 'proprietaire');
  });

  app.post('/api/sites/import', async (req) => {
    const { user } = requireUser(req);
    if (!user.is_owner) throw new UserError(403, 'Seul le propriétaire peut importer des sites.');
    if (req.isMultipart()) {
      let nom = '';
      let zipPath: string | null = null;
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (zipPath) throw new UserError(400, 'Un seul fichier à la fois.');
          zipPath = path.join(ctx.config.dataDir, 'temporaire', `envoi-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
          fs.mkdirSync(path.dirname(zipPath), { recursive: true });
          await new Promise<void>((resolve, reject) => {
            const out = fs.createWriteStream(zipPath!);
            part.file.on('limit', () => reject(new UserError(413, 'Archive trop lourde (200 Mo maximum).')));
            part.file.pipe(out).on('finish', resolve).on('error', reject);
          });
          if (part.file.truncated) throw new UserError(413, 'Archive trop lourde (200 Mo maximum).');
        } else if (part.fieldname === 'nom') nom = String(part.value);
      }
      if (!zipPath) throw new UserError(400, 'Choisissez une archive ZIP.');
      if (!nom.trim()) throw new UserError(400, 'Donnez un nom au site.');
      return ctx.jobs.enqueue({ type: 'import', label: `Import de « ${nom.trim()} »`, userId: user.id, payload: { nom: nom.trim(), zip: zipPath } });
    }
    const b = body<{ nom?: string; git?: string }>(req);
    if (!b.nom?.trim()) throw new UserError(400, 'Donnez un nom au site.');
    if (!b.git?.trim()) throw new UserError(400, 'Indiquez l’adresse du dépôt.');
    return ctx.jobs.enqueue({ type: 'import', label: `Import de « ${b.nom.trim()} »`, userId: user.id, payload: { nom: b.nom.trim(), git: b.git.trim() } });
  });

  app.get('/api/sites/:id', async (req) => {
    const { user } = requireUser(req);
    const { site, role } = ctx.sites.require(user, siteParam(req), 'voir');
    const m = ctx.sites.manifest(site);
    const schema = loadSchema(ctx, site);
    return {
      ...(await ctx.sites.summary(site, role)),
      domainesConfigures: ctx.sites.domains(site),
      fiche: { dossierPublie: m.publishDir, preparation: m.build, fonctions: m.functionsDir, source: m.source, remarques: m.warnings },
      contenus: { source: schema.source, nombre: schema.entries.length },
      droits: {
        publier: ROLE_RANK[role] >= ROLE_RANK.editeur,
        code: ROLE_RANK[role] >= ROLE_RANK.admin_site,
        reglages: ROLE_RANK[role] >= ROLE_RANK.admin_site,
        supprimer: role === 'proprietaire',
      },
    };
  });

  app.patch('/api/sites/:id', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'reglages');
    const b = body<{ nom?: string; domaines?: string[] }>(req);
    if (b.domaines !== undefined) requireSudo(req);
    const updated = ctx.sites.updateSettings(site, { name: b.nom, domains: b.domaines });
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'reglages_site', siteId: site.id, details: { nom: b.nom, domaines: b.domaines } });
    return ctx.sites.summary(updated, ctx.sites.role(user, site.id)!);
  });

  app.delete('/api/sites/:id', async (req) => {
    const { user } = requireSudo(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'supprimer');
    if (ctx.jobs.hasActive(site.id)) throw new UserError(409, 'Une opération est en cours sur ce site. Réessayez dans un instant.');
    await ctx.sites.deleteSite(site);
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'suppression_site', siteId: site.id, details: { nom: site.name } });
    return { ok: true };
  });

  app.get('/api/sites/:id/export', async (req, reply) => {
    const { user } = requireSudo(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'exporter');
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'export_site', siteId: site.id });
    const stream = await exportSite(ctx, site);
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="${site.slug}-export-${new Date().toISOString().slice(0, 10)}.zip"`);
    return reply.send(stream);
  });

  // ------------------------------------------------------------------ membres
  app.get('/api/sites/:id/membres', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'membres');
    const rows = ctx.db
      .prepare('SELECT u.id, u.name, u.email, m.role FROM site_members m JOIN users u ON u.id = m.user_id WHERE m.site_id = ? ORDER BY u.name')
      .all(site.id) as { id: string; name: string; email: string; role: keyof typeof ROLE_LABEL }[];
    return rows.map((r) => ({ id: r.id, nom: r.name, email: r.email, role: r.role, roleLibelle: ROLE_LABEL[r.role] }));
  });

  app.put('/api/sites/:id/membres/:userId', async (req) => {
    const { user } = requireUser(req);
    const { site, role } = ctx.sites.require(user, siteParam(req), 'membres');
    const target = getUser(ctx, (req.params as { userId: string }).userId);
    if (!target || target.is_owner) throw new UserError(404, 'Utilisateur introuvable.');
    const b = body<{ role?: string }>(req);
    if (!isRole(b.role)) throw new UserError(400, 'Rôle invalide.');
    if (role !== 'proprietaire' && ROLE_RANK[b.role] > ROLE_RANK.editeur) throw new UserError(403, 'Seul le propriétaire peut nommer un administrateur de site.');
    ctx.db.prepare('INSERT OR REPLACE INTO site_members (site_id, user_id, role) VALUES (?, ?, ?)').run(site.id, target.id, b.role);
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'role_modifie', siteId: site.id, details: { utilisateur: target.email, role: b.role } });
    return { ok: true };
  });

  app.delete('/api/sites/:id/membres/:userId', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'membres');
    const targetId = (req.params as { userId: string }).userId;
    ctx.db.prepare('DELETE FROM site_members WHERE site_id = ? AND user_id = ?').run(site.id, targetId);
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'acces_retire', siteId: site.id, details: { utilisateur: targetId } });
    return { ok: true };
  });

  // ------------------------------------------------------------------ fichiers (mode code)
  app.get('/api/sites/:id/fichiers', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'voir');
    return listTree(ctx.sites.repoDir(site));
  });

  app.get('/api/sites/:id/fichier', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'voir');
    const q = req.query as { chemin?: string };
    const f = readText(ctx.sites.repoDir(site), q.chemin);
    return { chemin: f.rel, contenu: f.content, version: f.version, autres: othersEditing(site.id, f.rel, user.id) };
  });

  app.put('/api/sites/:id/fichier', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'code');
    const b = body<{ chemin?: string; contenu?: string; version?: string | null; forcerJson?: boolean }>(req);
    if (typeof b.contenu !== 'string') throw new UserError(400, 'Contenu manquant.');
    const rel = resolveIn(ctx.sites.repoDir(site), b.chemin).rel;
    if (!isText(rel)) throw new UserError(400, 'Seuls les fichiers texte peuvent être modifiés ici.');
    const errors = validateText(rel, b.contenu);
    if (errors.length && !b.forcerJson) throw new UserError(422, errors.join(' '), { erreurs: errors });
    return ctx.sites.lock(site.id, async () => {
      const w = writeChecked(ctx.sites.repoDir(site), rel, b.contenu!, b.version === undefined ? undefined : b.version);
      const commit = await ctx.sites.repo(site).commitPaths([w.rel], `Code : ${w.rel}`, authorOf(user));
      return { chemin: w.rel, version: w.version, enregistre: commit !== null };
    });
  });

  app.post('/api/sites/:id/fichiers/nouveau', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'code');
    const b = body<{ chemin?: string; dossier?: boolean }>(req);
    return ctx.sites.lock(site.id, async () => {
      const r = resolveIn(ctx.sites.repoDir(site), b.chemin);
      if (fs.existsSync(r.abs)) throw new UserError(409, 'Un fichier ou dossier porte déjà ce nom.');
      if (b.dossier) {
        fs.mkdirSync(r.abs, { recursive: true });
        fs.writeFileSync(path.join(r.abs, '.gitkeep'), '');
        await ctx.sites.repo(site).commitPaths([`${r.rel}/.gitkeep`], `Code : nouveau dossier ${r.rel}`, authorOf(user));
      } else {
        if (!isText(r.rel)) throw new UserError(400, 'Créez ici des fichiers texte (html, css, js, json…). Les images passent par la médiathèque.');
        writeChecked(ctx.sites.repoDir(site), r.rel, extOf(r.rel) === 'json' ? '{}\n' : '', null);
        await ctx.sites.repo(site).commitPaths([r.rel], `Code : nouveau fichier ${r.rel}`, authorOf(user));
      }
      return { chemin: r.rel };
    });
  });

  app.post('/api/sites/:id/fichiers/renommer', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'code');
    const b = body<{ de?: string; vers?: string }>(req);
    return ctx.sites.lock(site.id, async () => {
      const root = ctx.sites.repoDir(site);
      const from = resolveIn(root, b.de);
      const to = resolveIn(root, b.vers);
      if (!fs.existsSync(from.abs)) throw new UserError(404, 'Fichier introuvable.');
      if (fs.existsSync(to.abs)) throw new UserError(409, 'Un fichier porte déjà ce nom.');
      fs.mkdirSync(path.dirname(to.abs), { recursive: true });
      fs.renameSync(from.abs, to.abs);
      await ctx.sites.repo(site).commitPaths([from.rel, to.rel], `Code : ${from.rel} renommé en ${to.rel}`, authorOf(user));
      return { chemin: to.rel };
    });
  });

  app.delete('/api/sites/:id/fichier', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'code');
    const q = req.query as { chemin?: string };
    return ctx.sites.lock(site.id, async () => {
      const r = resolveIn(ctx.sites.repoDir(site), q.chemin);
      if (!fs.existsSync(r.abs)) throw new UserError(404, 'Fichier introuvable.');
      if (r.rel === 'paginity.yml') throw new UserError(400, 'La fiche du site ne peut pas être supprimée.');
      fs.rmSync(r.abs, { recursive: true });
      await ctx.sites.repo(site).commitPaths([r.rel], `Code : suppression de ${r.rel}`, authorOf(user));
      return { ok: true };
    });
  });

  app.get('/api/sites/:id/brut', async (req, reply) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'voir');
    const q = req.query as { chemin?: string; version?: string };
    const root = ctx.sites.repoDir(site);
    const r = resolveIn(root, q.chemin);
    let data: Buffer | null;
    if (q.version) {
      if (!/^\d+$/.test(q.version)) throw new UserError(400, 'Version invalide.');
      data = await ctx.sites.repo(site).show(`pub-${q.version}`, r.rel);
    } else data = fs.existsSync(r.abs) && fs.statSync(r.abs).isFile() ? fs.readFileSync(r.abs) : null;
    if (!data) throw new UserError(404, 'Fichier introuvable.');
    const ext = extOf(r.rel);
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    reply.header('Cache-Control', 'private, no-cache');
    if (MEDIA_TYPES[ext]) {
      reply.header('Content-Type', MEDIA_TYPES[ext]);
      reply.header('Content-Disposition', 'inline');
    } else {
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="${path.basename(r.rel).replace(/"/g, '')}"`);
    }
    return reply.send(data);
  });

  app.post('/api/sites/:id/presence', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'voir');
    const b = body<{ chemin?: string }>(req);
    const rel = resolveIn(ctx.sites.repoDir(site), b.chemin).rel;
    touchPresence(site.id, rel, user);
    return { autres: othersEditing(site.id, rel, user.id) };
  });

  // ------------------------------------------------------------------ contenus (formulaires)
  app.get('/api/sites/:id/contenus', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'contenus');
    const s = loadSchema(ctx, site);
    return {
      source: s.source,
      remarques: s.warnings,
      media: s.media,
      rubriques: s.entries.map((e) => ({ nom: e.name, libelle: e.label, description: e.description, type: e.type, chemin: e.path })),
    };
  });

  app.get('/api/sites/:id/contenus/:nom', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'contenus');
    const r = readEntry(ctx, site, (req.params as { nom: string }).nom);
    return { ...r, autres: othersEditing(site.id, r.entree.path, user.id) };
  });

  app.put('/api/sites/:id/contenus/:nom', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'contenus');
    const b = body<{ valeur?: unknown; version?: string | null }>(req);
    return saveEntry(ctx, site, user, (req.params as { nom: string }).nom, b.valeur, b.version);
  });

  // ------------------------------------------------------------------ médias
  app.get('/api/sites/:id/medias', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'contenus');
    return listMedia(ctx, site);
  });

  app.post('/api/sites/:id/medias', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'contenus');
    const q = req.query as { remplacer?: string };
    const file = await req.file({ limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
    if (!file) throw new UserError(400, 'Aucun fichier reçu.');
    const buffer = await file.toBuffer().catch(() => {
      throw new UserError(413, 'Fichier trop lourd (25 Mo maximum à l’envoi).');
    });
    if (file.file.truncated) throw new UserError(413, 'Fichier trop lourd (25 Mo maximum à l’envoi).');
    return uploadMedia(ctx, site, user, { buffer, filename: file.filename }, q.remplacer);
  });

  app.delete('/api/sites/:id/medias', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'publier');
    const q = req.query as { chemin?: string; forcer?: string };
    return deleteMedia(ctx, site, user, q.chemin, q.forcer === '1');
  });

  // ------------------------------------------------------------------ modifications, aperçu, publication
  app.get('/api/sites/:id/modifications', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'voir');
    const repo = ctx.sites.repo(site);
    const files = await ctx.sites.pendingFiles(site);
    const liveTag = ctx.sites.liveTag(site);
    const schema = loadSchema(ctx, site);
    const result = [];
    for (const f of files.slice(0, 200)) {
      const log = await repo.log({ range: liveTag ? `${liveTag}..HEAD` : undefined, path: f.path, limit: 20 });
      const auteurs = [...new Set(log.map((l) => l.author))];
      const entry = schema.entries.find((e) => e.path === f.path);
      let champs: { champ: string; avant: unknown; apres: unknown }[] | undefined;
      if (entry && entry.format === 'json') {
        try {
          const before = liveTag ? JSON.parse((await repo.show(liveTag, f.path))?.toString('utf8') ?? 'null') : null;
          const after = fs.existsSync(path.join(ctx.sites.repoDir(site), f.path)) ? JSON.parse(fs.readFileSync(path.join(ctx.sites.repoDir(site), f.path), 'utf8')) : null;
          const a = flatten(before);
          const b = flatten(after);
          champs = [];
          for (const k of new Set([...a.keys(), ...b.keys()])) {
            if (JSON.stringify(a.get(k)) !== JSON.stringify(b.get(k))) champs.push({ champ: labelPath(entry, k.split('\u0000')), avant: a.get(k) ?? null, apres: b.get(k) ?? null });
            if (champs.length >= 50) break;
          }
        } catch {
          champs = undefined;
        }
      }
      result.push({
        chemin: f.path,
        ancienChemin: f.oldPath,
        statut: ({ A: 'ajouté', M: 'modifié', D: 'supprimé', R: 'renommé' } as Record<string, string>)[f.status] ?? 'modifié',
        auteurs,
        rubrique: entry?.label,
        champs,
      });
    }
    return { reference: site.live_publication, fichiers: result };
  });

  app.get('/api/sites/:id/diff', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'voir');
    const q = req.query as { chemin?: string };
    const r = resolveIn(ctx.sites.repoDir(site), q.chemin);
    const liveTag = ctx.sites.liveTag(site);
    const before = liveTag ? await ctx.sites.repo(site).show(liveTag, r.rel) : null;
    const after = fs.existsSync(r.abs) && fs.statSync(r.abs).isFile() ? fs.readFileSync(r.abs) : null;
    if (!isText(r.rel)) return { chemin: r.rel, binaire: true, avantExiste: !!before, apresExiste: !!after };
    return { chemin: r.rel, binaire: false, avant: before?.toString('utf8') ?? null, apres: after?.toString('utf8') ?? null };
  });

  app.post('/api/sites/:id/annuler', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'publier');
    const b = body<{ chemin?: string }>(req);
    const liveTag = ctx.sites.liveTag(site);
    if (!liveTag) throw new UserError(400, 'Le site n’a jamais été publié : il n’y a pas de version à laquelle revenir.');
    return ctx.sites.lock(site.id, async () => {
      const repo = ctx.sites.repo(site);
      if (b.chemin) {
        const rel = resolveIn(ctx.sites.repoDir(site), b.chemin).rel;
        await repo.restorePath(liveTag, rel);
        await repo.commitAll(`Modifications annulées : ${rel}`, authorOf(user));
      } else {
        await repo.resetTreeTo(liveTag);
        await repo.commitAll('Toutes les modifications non publiées ont été annulées', authorOf(user));
      }
      audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'annulation_modifications', siteId: site.id, details: { chemin: b.chemin ?? 'tout' } });
      return { ok: true };
    });
  });

  app.post('/api/sites/:id/apercu', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'voir');
    const r = await buildPreview(ctx, site);
    return { ...r, url: `${previewOrigin(ctx.config, site.slug)}/?jeton=${encodeURIComponent(previewToken(ctx, site.id, user.id))}` };
  });

  app.post('/api/sites/:id/publier', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'publier');
    if (ctx.jobs.hasActive(site.id, 'publication')) throw new UserError(409, 'Une publication est déjà en cours pour ce site.');
    const b = body<{ message?: string }>(req);
    return ctx.jobs.enqueue({ type: 'publication', label: `Publication de « ${site.name} »`, siteId: site.id, userId: user.id, payload: { message: b.message ?? '' } });
  });

  app.get('/api/sites/:id/publications', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'voir');
    const rows = ctx.db
      .prepare('SELECT p.*, u.name AS author FROM publications p LEFT JOIN users u ON u.id = p.created_by WHERE p.site_id = ? ORDER BY p.number DESC LIMIT 200')
      .all(site.id) as { number: number; commit_hash: string; message: string; created_at: number; status: string; duration_ms: number | null; warnings: string; author: string | null }[];
    const versionsDir = ctx.sites.versionsDir(site);
    return rows.map((r) => ({
      numero: r.number,
      commit: r.commit_hash?.slice(0, 8),
      message: r.message,
      le: r.created_at,
      etat: r.status,
      dureeMs: r.duration_ms,
      avertissements: JSON.parse(r.warnings),
      auteur: r.author,
      enLigne: site.live_publication === r.number,
      disponible: fs.existsSync(path.join(versionsDir, `v${String(r.number).padStart(4, '0')}`)),
    }));
  });

  app.post('/api/sites/:id/publications/:numero/remettre', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'publier');
    const numero = Number((req.params as { numero: string }).numero);
    if (ctx.jobs.hasActive(site.id)) throw new UserError(409, 'Une opération est déjà en cours pour ce site.');
    return ctx.jobs.enqueue({ type: 'remise-en-ligne', label: `Remise en ligne de la publication n°${numero} (« ${site.name} »)`, siteId: site.id, userId: user.id, payload: { numero } });
  });

  app.post('/api/sites/:id/publications/:numero/reprendre', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'publier');
    const numero = Number((req.params as { numero: string }).numero);
    return ctx.sites.lock(site.id, async () => {
      const repo = ctx.sites.repo(site);
      if (!(await repo.resolve(`pub-${numero}`))) throw new UserError(404, 'Publication introuvable.');
      await repo.resetTreeTo(`pub-${numero}`);
      await repo.commitAll(`Brouillon repris depuis la publication n°${numero}`, authorOf(user));
      audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'brouillon_repris', siteId: site.id, details: { numero } });
      return { ok: true };
    });
  });

  app.get('/api/sites/:id/historique', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'voir');
    const q = req.query as { chemin?: string };
    const rel = q.chemin ? resolveIn(ctx.sites.repoDir(site), q.chemin).rel : undefined;
    const log = await ctx.sites.repo(site).log({ limit: 100, path: rel });
    return log.map((l) => ({ id: l.hash.slice(0, 8), le: l.at, auteur: l.author, message: l.message }));
  });

  // ------------------------------------------------------------------ utilisateurs (propriétaire)
  app.get('/api/utilisateurs', async (req) => {
    requireOwner(req);
    const users = ctx.db.prepare('SELECT id, email, name, is_owner, disabled, created_at, totp_enabled FROM users ORDER BY name').all() as {
      id: string;
      email: string;
      name: string;
      is_owner: number;
      disabled: number;
      created_at: number;
      totp_enabled: number;
    }[];
    const members = ctx.db.prepare('SELECT m.user_id, m.role, s.id, s.name FROM site_members m JOIN sites s ON s.id = m.site_id').all() as {
      user_id: string;
      role: keyof typeof ROLE_LABEL;
      id: string;
      name: string;
    }[];
    const invitations = ctx.db.prepare('SELECT email, created_at, expires_at FROM invitations WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC').all(now());
    return {
      utilisateurs: users.map((u) => ({
        id: u.id,
        email: u.email,
        nom: u.name,
        proprietaire: !!u.is_owner,
        desactive: !!u.disabled,
        creeLe: u.created_at,
        sites: members.filter((m) => m.user_id === u.id).map((m) => ({ id: m.id, nom: m.name, role: m.role, roleLibelle: ROLE_LABEL[m.role] })),
      })),
      invitations,
    };
  });

  app.patch('/api/utilisateurs/:id', async (req) => {
    const { user } = requireSudo(req);
    if (!user.is_owner) throw new UserError(403, 'Réservé au propriétaire de la plateforme.');
    const target = getUser(ctx, (req.params as { id: string }).id);
    if (!target) throw new UserError(404, 'Utilisateur introuvable.');
    if (target.is_owner) throw new UserError(400, 'Le compte propriétaire ne peut pas être désactivé.');
    const b = body<{ desactive?: boolean }>(req);
    ctx.db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(b.desactive ? 1 : 0, target.id);
    if (b.desactive) ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: b.desactive ? 'utilisateur_desactive' : 'utilisateur_reactive', details: { utilisateur: target.email } });
    return { ok: true };
  });

}
