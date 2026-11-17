import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { body, ipOf, requireOwner, requireSudo, requireUser } from './helpers.js';
import { UserError } from '../lib/util.js';
import type { NomExterne } from '../ia/assistant.js';

/** PAGINITY AI — assistant contenus (étape 1). */
export function registerIaRoutes(app: FastifyInstance, ctx: Ctx): void {
  const siteParam = (req: FastifyRequest) => (req.params as { id: string }).id;
  const pid = (req: FastifyRequest) => (req.params as { pid: string }).pid;
  const externe = (req: FastifyRequest): NomExterne => {
    const n = (req.params as { nom: string }).nom;
    if (n !== 'claude' && n !== 'chatgpt') throw new UserError(404, 'Service inconnu.');
    return n;
  };

  // Réglages : propriétaire seulement (activer, relais vers Claude, plafond mensuel).
  app.get('/api/reglages/ia', async (req) => {
    requireOwner(req);
    return ctx.ia.etat();
  });
  app.put('/api/reglages/ia', async (req) => {
    const { user } = requireSudo(req);
    if (!user.is_owner) requireOwner(req);
    const r = ctx.ia.modifierReglages(body<Record<string, unknown>>(req));
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'ia_reglages', details: { active: r.active, relais: r.relaisExterne, plafond: r.plafondMensuelCentimes } });
    return ctx.ia.etat();
  });
  // Clés d'API (Claude, ChatGPT) : saisies par le propriétaire, chiffrées, jamais réaffichées.
  app.put('/api/reglages/ia/cle/:nom', async (req) => {
    const { user } = requireSudo(req);
    if (!user.is_owner) requireOwner(req);
    const nom = externe(req);
    ctx.ia.definirCle(nom, body<{ cle?: string }>(req).cle);
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'ia_cle_enregistree', details: { service: nom } });
    return ctx.ia.etat();
  });
  app.delete('/api/reglages/ia/cle/:nom', async (req) => {
    const { user } = requireSudo(req);
    if (!user.is_owner) requireOwner(req);
    const nom = externe(req);
    ctx.ia.effacerCle(nom);
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'ia_cle_effacee', details: { service: nom } });
    return ctx.ia.etat();
  });
  // Essai du modèle local (gratuit) : répond-il ?
  app.post('/api/reglages/ia/essai-local', async (req) => {
    requireOwner(req);
    const id = body<{ id?: string }>(req).id;
    const actifs = ctx.ia.cerveauxActifs();
    const cle = id ? `local:${id}` : Object.keys(actifs).find((k) => k.startsWith('local'));
    const local = cle ? actifs[cle] : undefined;
    return { repond: local ? await local.disponible() : false, enService: !!local };
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
    return ctx.ia.demander(site, user, b.demande, { forcer: b.cerveau === 'claude' || b.cerveau === 'chatgpt' ? b.cerveau : undefined });
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
