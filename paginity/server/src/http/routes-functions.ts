import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { now, UserError } from '../lib/util.js';
import { deleteSecret, isSecretEnv, listSecrets, setSecret } from '../functions/secrets.js';
import { listSubmissions } from '../functions/forms.js';
import { listAlerts, markAlertRead } from '../lib/alerts.js';
import { body, ipOf, requireOwner, requireSudo, requireUser } from './helpers.js';

function siteParam(req: FastifyRequest): string {
  return (req.params as { id: string }).id;
}

export function registerFunctionRoutes(app: FastifyInstance, ctx: Ctx): void {
  // ------------------------------------------------------------------ fonctions et tâches planifiées
  app.get('/api/sites/:id/fonctions', async (req) => {
    const { user } = requireUser(req);
    const { site, role } = ctx.sites.require(user, siteParam(req), 'voir');
    const s = ctx.sites.get(site.id)!;
    return {
      isolation: ctx.functions.isolation.mode,
      fonctions: ctx.scheduler.catalog(site.id),
      statistiques: ctx.functions.stats(site.id),
      executeurs: ctx.functions.status(site.id),
      planificationActive: s.schedules_enabled === 1,
      taches: ctx.scheduler.overview(s),
      peutModifier: role === 'proprietaire' || role === 'admin_site',
    };
  });

  app.get('/api/sites/:id/fonctions/journal', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'reglages');
    return { lignes: ctx.functions.recentLogs(site.id, 300) };
  });

  app.post('/api/sites/:id/fonctions/redemarrer', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'reglages');
    await ctx.functions.stopSite(site.id);
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'fonctions_redemarrees', siteId: site.id });
    return { ok: true };
  });

  app.post('/api/sites/:id/planification', async (req) => {
    const { user } = requireSudo(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'reglages');
    const b = body<{ active?: boolean }>(req);
    ctx.db.prepare('UPDATE sites SET schedules_enabled = ? WHERE id = ?').run(b.active ? 1 : 0, site.id);
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: b.active ? 'taches_activees' : 'taches_desactivees', siteId: site.id });
    return { ok: true };
  });

  app.put('/api/sites/:id/taches/:fn', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'reglages');
    const fn = (req.params as { fn: string }).fn;
    const b = body<{ active?: boolean; rattrapage?: boolean }>(req);
    const cur = ctx.scheduler.settings(site.id, fn);
    ctx.db
      .prepare('INSERT INTO schedule_settings (site_id, fn, active, catch_up) VALUES (?, ?, ?, ?) ON CONFLICT(site_id, fn) DO UPDATE SET active = excluded.active, catch_up = excluded.catch_up')
      .run(site.id, fn, (b.active ?? cur.active) ? 1 : 0, (b.rattrapage ?? cur.catchUp) ? 1 : 0);
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'tache_reglee', siteId: site.id, details: { fn, ...b } });
    return { ok: true };
  });

  app.post('/api/sites/:id/taches/:fn/lancer', async (req) => {
    const { user } = requireSudo(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'publier');
    const fn = (req.params as { fn: string }).fn;
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'tache_lancee', siteId: site.id, details: { fn } });
    try {
      await ctx.scheduler.runNow(site, fn);
    } catch (e) {
      throw e instanceof UserError ? e : new UserError(409, (e as Error).message);
    }
    return { ok: true, taches: ctx.scheduler.overview(ctx.sites.get(site.id)!) };
  });

  // ------------------------------------------------------------------ secrets
  app.get('/api/sites/:id/secrets', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'reglages');
    return listSecrets(ctx, site);
  });

  app.put('/api/sites/:id/secrets/:env/:nom', async (req) => {
    const { user } = requireSudo(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'reglages');
    const { env, nom } = req.params as { env: string; nom: string };
    if (!isSecretEnv(env)) throw new UserError(400, 'Environnement inconnu.');
    setSecret(ctx, site, env, nom, body<{ valeur?: string }>(req).valeur, user.id);
    await ctx.functions.stopSite(site.id, env);
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'secret_enregistre', siteId: site.id, details: { nom, env } });
    return { ok: true };
  });

  app.delete('/api/sites/:id/secrets/:env/:nom', async (req) => {
    const { user } = requireSudo(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'reglages');
    const { env, nom } = req.params as { env: string; nom: string };
    if (!isSecretEnv(env)) throw new UserError(400, 'Environnement inconnu.');
    deleteSecret(ctx, site, env, nom);
    await ctx.functions.stopSite(site.id, env);
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'secret_supprime', siteId: site.id, details: { nom, env } });
    return { ok: true };
  });

  // ------------------------------------------------------------------ formulaires
  app.get('/api/sites/:id/formulaires', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'publier');
    const s = ctx.sites.get(site.id)!;
    return { notification: s.notify_email ?? '', messagerieConfiguree: ctx.mailer.configured(), messages: listSubmissions(ctx, site.id) };
  });

  app.post('/api/sites/:id/formulaires/:fid/lu', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'publier');
    ctx.db.prepare('UPDATE form_submissions SET read_at = ? WHERE id = ? AND site_id = ?').run(now(), (req.params as { fid: string }).fid, site.id);
    return { ok: true };
  });

  app.delete('/api/sites/:id/formulaires/:fid', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'publier');
    const r = ctx.db.prepare('DELETE FROM form_submissions WHERE id = ? AND site_id = ?').run((req.params as { fid: string }).fid, site.id);
    if (!r.changes) throw new UserError(404, 'Message introuvable.');
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'message_supprime', siteId: site.id });
    return { ok: true };
  });

  app.get('/api/sites/:id/formulaires.csv', async (req, reply) => {
    const { user } = requireSudo(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'publier');
    const msgs = listSubmissions(ctx, site.id);
    const keys = [...new Set(msgs.flatMap((m) => Object.keys(m.donnees)))];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""').replace(/^[=+\-@]/, "'$&")}"`;
    const lines = [['date', 'formulaire', ...keys].map(esc).join(';'), ...msgs.map((m) => [new Date(m.le).toISOString(), m.formulaire, ...keys.map((k) => m.donnees[k])].map(esc).join(';'))];
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'messages_exportes', siteId: site.id });
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${site.slug}-messages.csv"`);
    return reply.send('﻿' + lines.join('\r\n'));
  });

  app.patch('/api/sites/:id/notification', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'reglages');
    const email = String(body<{ email?: string }>(req).email ?? '').trim();
    if (email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new UserError(400, 'Adresse e-mail invalide.');
    ctx.db.prepare('UPDATE sites SET notify_email = ? WHERE id = ?').run(email || null, site.id);
    return { ok: true };
  });

  // ------------------------------------------------------------------ alertes
  app.get('/api/alertes', async (req) => {
    const { user } = requireUser(req);
    return listAlerts(ctx, user.is_owner ? null : ctx.sites.accessibleSites(user).map((s) => s.id));
  });

  app.post('/api/alertes/:id/lue', async (req) => {
    const { user } = requireUser(req);
    const id = (req.params as { id: string }).id;
    if (id === 'toutes') {
      if (!user.is_owner) throw new UserError(403, 'Réservé au propriétaire.');
      markAlertRead(ctx, 'toutes');
    } else {
      const a = ctx.db.prepare('SELECT site_id FROM alerts WHERE id = ?').get(Number(id)) as { site_id: string | null } | undefined;
      if (!a) throw new UserError(404, 'Alerte introuvable.');
      if (!user.is_owner && (!a.site_id || !ctx.sites.role(user, a.site_id))) throw new UserError(404, 'Alerte introuvable.');
      markAlertRead(ctx, Number(id));
    }
    return { ok: true };
  });

  // ------------------------------------------------------------------ messagerie (envoi d'e-mails)
  app.get('/api/reglages/messagerie', async (req) => {
    requireOwner(req);
    return ctx.mailer.settings();
  });

  app.put('/api/reglages/messagerie', async (req) => {
    const { user } = requireSudo(req);
    if (!user.is_owner) throw new UserError(403, 'Réservé au propriétaire.');
    ctx.mailer.save(body(req));
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'messagerie_reglee' });
    return ctx.mailer.settings();
  });

  app.post('/api/reglages/messagerie/test', async (req) => {
    const { user } = requireOwner(req);
    const to = ctx.mailer.settings().destinataireAlertes || user.email;
    try {
      await ctx.mailer.send(to, 'PAGINITY — e-mail de test', 'Si vous lisez ce message, l’envoi des alertes fonctionne.');
    } catch (e) {
      throw e instanceof UserError ? e : new UserError(502, `Envoi impossible : ${(e as Error).message}`);
    }
    return { ok: true, destinataire: to };
  });
}
