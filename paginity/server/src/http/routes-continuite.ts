import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { body, ipOf, requireOwner, requireSudoOwner, requireUser } from './helpers.js';
import { enregistrerFiche, lireFiche, pageSecours } from '../sites/secours.js';
import { lireVisites } from '../sites/visites.js';

/** Continuité de service : sauvegarde automatique hors machine (propriétaire seulement). */
export function registerContinuiteRoutes(app: FastifyInstance, ctx: Ctx): void {
  const sudoProprio = requireSudoOwner;
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

  // Visites (sans cookies) : pages vues par jour.
  app.get('/api/sites/:id/visites', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'voir');
    const j = Number((req.query as { jours?: string }).jours ?? 30);
    return lireVisites(ctx, site, [7, 30, 90].includes(j) ? j : 30);
  });

  // Failles connues dans les composants de PAGINITY.
  app.get('/api/reglages/mises-a-jour', async (req) => {
    requireOwner(req);
    return ctx.misesAJour.etat();
  });
  app.put('/api/reglages/mises-a-jour', async (req) => {
    const { user } = sudoProprio(req);
    const e = ctx.misesAJour.regler(body<{ hebdo?: boolean }>(req).hebdo);
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'maj_reglages', details: { hebdo: e.hebdo } });
    return e;
  });
  app.post('/api/reglages/mises-a-jour/verifier', async (req) => {
    requireOwner(req);
    return ctx.misesAJour.verifier();
  });

  // Notifications sur le téléphone : chaque personne abonne ses propres appareils.
  app.get('/api/push', async (req) => {
    const { user } = requireUser(req);
    return { cle: ctx.push.clePublique(), appareils: ctx.push.nombre(user.id) };
  });
  app.post('/api/push/abonnement', async (req) => {
    const { user } = requireUser(req);
    ctx.push.abonner(user.id, body<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>(req));
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'push_abonnement' });
    return { appareils: ctx.push.nombre(user.id) };
  });
  app.delete('/api/push/abonnement', async (req) => {
    const { user } = requireUser(req);
    ctx.push.desabonner(user.id, body<{ endpoint?: string }>(req).endpoint);
    return { appareils: ctx.push.nombre(user.id) };
  });
  app.post('/api/push/essai', async (req) => {
    const { user } = requireUser(req);
    return { envoyes: await ctx.push.envoyer(user.id, { titre: 'PAGINITY', texte: 'Notification d’essai : tout fonctionne.', url: '/' }) };
  });
}
