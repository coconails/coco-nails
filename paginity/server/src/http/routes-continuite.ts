import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { body, ipOf, requireOwner, requireSudo, requireUser } from './helpers.js';
import { enregistrerFiche, lireFiche, pageSecours } from '../sites/secours.js';

/** Continuité de service : sauvegarde automatique hors machine (propriétaire seulement). */
export function registerContinuiteRoutes(app: FastifyInstance, ctx: Ctx): void {
  const sudoProprio = (req: Parameters<typeof requireSudo>[0]) => {
    const a = requireSudo(req);
    if (!a.user.is_owner) requireOwner(req);
    return a;
  };
  app.get('/api/reglages/sauvegarde', async (req) => {
    requireOwner(req);
    return ctx.sauvegardeAuto.resume();
  });
  app.put('/api/reglages/sauvegarde', async (req) => {
    const { user } = sudoProprio(req);
    const r = ctx.sauvegardeAuto.modifier(body<Record<string, unknown>>(req));
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'sauvegarde_reglages', details: { active: r.reglages.active, heure: r.reglages.heure, garder: r.reglages.garder } });
    return r;
  });
  app.post('/api/reglages/sauvegarde/phrase', async (req) => {
    const { user } = sudoProprio(req);
    const r = ctx.sauvegardeAuto.definirPhrase(body<{ phrase?: string }>(req).phrase);
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'sauvegarde_phrase' });
    return r;
  });
  app.post('/api/reglages/sauvegarde/maintenant', async (req) => {
    requireOwner(req);
    await ctx.sauvegardeAuto.sauvegarder();
    return ctx.sauvegardeAuto.resume();
  });
  app.post('/api/reglages/sauvegarde/essai', async (req) => {
    requireOwner(req);
    await ctx.sauvegardeAuto.essayerRestauration();
    return ctx.sauvegardeAuto.resume();
  });

  // Alerte de panne : battement de cœur vers un service de surveillance extérieur.
  app.get('/api/reglages/battement', async (req) => {
    requireOwner(req);
    return { ...ctx.battement.resume(), panne: ctx.battement.panne() };
  });
  app.put('/api/reglages/battement', async (req) => {
    const { user } = sudoProprio(req);
    const r = ctx.battement.modifier(body<Record<string, unknown>>(req));
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'battement_reglages', details: { active: r.reglages.active, minutes: r.reglages.minutes } });
    return { ...r, panne: ctx.battement.panne() };
  });
  app.post('/api/reglages/battement/essai', async (req) => {
    requireOwner(req);
    await ctx.battement.envoyer();
    return { ...ctx.battement.resume(), panne: ctx.battement.panne() };
  });

  // Page de secours d'un site : fiche (pré-remplie depuis les contenus) et page HTML à déposer chez un hébergeur gratuit.
  const siteParam = (req: { params: unknown }) => (req.params as { id: string }).id;
  app.get('/api/sites/:id/secours', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'voir');
    const r = lireFiche(ctx, site);
    return { ...r, page: pageSecours(r.fiche) };
  });
  app.put('/api/sites/:id/secours', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'publier');
    const fiche = enregistrerFiche(ctx, site, body<Record<string, unknown>>(req));
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'secours_fiche', siteId: site.id });
    return { fiche, enregistree: true, page: pageSecours(fiche) };
  });
  app.get('/api/sites/:id/secours/index.html', async (req, reply) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'voir');
    reply.header('content-type', 'text/html; charset=utf-8').header('content-disposition', 'attachment; filename="index.html"');
    return pageSecours(lireFiche(ctx, site).fiche);
  });
}
