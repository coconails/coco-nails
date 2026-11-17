import { limiter } from '../lib/limiteur.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { body, ipOf, requireOwner, requireSudoOwner, requireUser } from './helpers.js';
import type { Cible } from '../marketing/service.js';

/** PAGINITY Marketing — M1 : audit de référencement local (lecture seule, aucun compte extérieur). */
export function registerMarketingRoutes(app: FastifyInstance, ctx: Ctx): void {
  const siteParam = (req: FastifyRequest) => (req.params as { id: string }).id;
  app.get('/api/sites/:id/referencement', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'voir');
    return ctx.referencement.lire(site);
  });
  app.post('/api/sites/:id/referencement/audit', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'voir');
    limiter(`audit:${site.id}`, 6, 60000);
    return ctx.referencement.lancer(site, (body<{ cible?: string }>(req).cible ?? 'brouillon') as Cible, user.id);
  });
  app.put('/api/sites/:id/referencement/reglages', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'reglages');
    const r = ctx.referencement.regler(site, body<{ hebdo?: boolean }>(req));
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'seo_reglages', siteId: site.id, details: r });
    return ctx.referencement.lire(site);
  });

  // ---- M2 : Search Console (lecture seule). Compte : propriétaire + confirmation d'identité.
  const sudoProprio = requireSudoOwner;
  app.get('/api/reglages/search-console', async (req) => {
    requireOwner(req);
    return ctx.searchConsole.compte();
  });
  app.post('/api/reglages/search-console', async (req) => {
    const { user } = sudoProprio(req);
    return ctx.searchConsole.connecter(body<{ cle?: string }>(req).cle, user.id);
  });
  app.delete('/api/reglages/search-console', async (req) => {
    const { user } = sudoProprio(req);
    return ctx.searchConsole.deconnecter(user.id);
  });
  app.get('/api/reglages/search-console/proprietes', async (req) => {
    requireOwner(req);
    return ctx.searchConsole.proprietes();
  });
  app.get('/api/sites/:id/search-console', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'voir');
    return ctx.searchConsole.lire(site);
  });
  // Relier un site à une propriété : propriétaire seulement (la clé est celle de la plateforme).
  app.put('/api/sites/:id/search-console', async (req) => {
    const { user } = requireOwner(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'voir');
    const p = body<{ propriete?: string | null }>(req).propriete;
    if (p) await ctx.searchConsole.lier(site, p, user.id);
    else ctx.searchConsole.delier(site, user.id);
    return ctx.searchConsole.lire(site);
  });
  app.post('/api/sites/:id/search-console/releve', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'voir');
    limiter(`gsc-releve:${site.id}`, 4, 60000);
    await ctx.searchConsole.collecter(site);
    return ctx.searchConsole.lire(site);
  });
  app.post('/api/sites/:id/search-console/inspection', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'voir');
    limiter(`gsc-inspection:${site.id}`, 3, 600000);
    await ctx.searchConsole.inspecter(site);
    return ctx.searchConsole.lire(site);
  });
  app.put('/api/sites/:id/indexnow', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'reglages');
    const r = ctx.searchConsole.reglerIndexNow(site, body<{ actif?: boolean }>(req).actif);
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'indexnow_reglage', siteId: site.id, details: { actif: r.actif } });
    return ctx.searchConsole.lire(site);
  });
}
