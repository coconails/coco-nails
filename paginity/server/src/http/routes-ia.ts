import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { body, ipOf, requireOwner, requireSudo, requireUser } from './helpers.js';

/** PAGINITY AI — assistant contenus (étape 1). */
export function registerIaRoutes(app: FastifyInstance, ctx: Ctx): void {
  const siteParam = (req: FastifyRequest) => (req.params as { id: string }).id;
  const pid = (req: FastifyRequest) => (req.params as { pid: string }).pid;

  // Réglages : propriétaire seulement (activer, relais vers Claude, plafond mensuel).
  app.get('/api/reglages/ia', async (req) => {
    requireOwner(req);
    return ctx.ia.etat();
  });
  app.put('/api/reglages/ia', async (req) => {
    const { user } = requireSudo(req);
    if (!user.is_owner) requireOwner(req);
    const b = body<{ active?: boolean; relaisClaude?: 'jamais' | 'demander' | 'auto'; plafondMensuelCentimes?: number }>(req);
    const r = ctx.ia.modifierReglages(b);
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'ia_reglages', details: { ...r } });
    return ctx.ia.etat();
  });

  // Demandes : même droit que modifier les contenus à la main.
  app.get('/api/sites/:id/assistant', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'voir');
    return { etat: { active: ctx.ia.reglages().active }, propositions: ctx.ia.liste(site) };
  });
  app.post('/api/sites/:id/assistant', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'contenus');
    const b = body<{ demande?: string; cerveau?: string }>(req);
    return ctx.ia.demander(site, user, b.demande, { forcerClaude: b.cerveau === 'claude' });
  });
  // Accepter de passer à Claude (payant, contenus publics envoyés à Anthropic) : à partir du rôle Éditeur.
  app.post('/api/sites/:id/assistant/:pid/relais', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'publier');
    return ctx.ia.relayer(site, user, pid(req));
  });
  app.post('/api/sites/:id/assistant/:pid/accepter', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'contenus');
    return ctx.ia.accepter(site, user, pid(req), body<{ empreinte?: string }>(req).empreinte);
  });
  app.post('/api/sites/:id/assistant/:pid/refuser', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'contenus');
    return ctx.ia.refuser(site, user, pid(req));
  });
}
