import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { body, ipOf, requireUser } from './helpers.js';
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
    return ctx.referencement.lancer(site, (body<{ cible?: string }>(req).cible ?? 'brouillon') as Cible, user.id);
  });
  app.put('/api/sites/:id/referencement/reglages', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'reglages');
    const r = ctx.referencement.regler(site, body<{ hebdo?: boolean }>(req));
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'seo_reglages', siteId: site.id, details: r });
    return ctx.referencement.lire(site);
  });
}
