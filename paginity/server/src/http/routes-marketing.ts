import { limiter } from '../lib/limiteur.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { body, ipOf, requireOwner, requireSudoOwner, requireUser } from './helpers.js';
import type { Cible } from '../marketing/service.js';
import { demandeDepuisConstat, regleCorrigeable } from '../marketing/corrections.js';
import { UserError } from '../lib/util.js';

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
    const cible = (body<{ cible?: string }>(req).cible ?? 'brouillon') as Cible;
    // Le contrôle en ligne envoie des requêtes vers le site et les liens externes : rôle Éditeur, 2 par 10 minutes.
    const { site } = ctx.sites.require(user, siteParam(req), cible === 'controle' ? 'publier' : 'voir');
    if (cible === 'controle') limiter(`controle:${site.id}`, 2, 600000);
    else limiter(`audit:${site.id}`, 6, 60000);
    return ctx.referencement.lancer(site, cible, user.id);
  });
  // Correction assistée : un constat du dernier audit du brouillon → une proposition de l'assistant (pages et styles),
  // vérifiée par PAGINITY, à accepter ou refuser. Rôle « code » (comme toute modification de fichier HTML).
  app.post('/api/sites/:id/referencement/corriger', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'code');
    limiter(`seo-corriger:${site.id}`, 6, 60000);
    const c = ctx.referencement.constatDuBrouillon(site, body<{ regle?: string; page?: string | null; message?: string }>(req));
    if (!c) throw new UserError(404, 'Ce constat ne figure plus dans le dernier audit du brouillon : relancez l’audit.');
    if (!regleCorrigeable(c.regle)) throw new UserError(400, 'Ce constat ne peut pas être corrigé par l’assistant sans risque d’inventer une information : corrigez-le vous-même.');
    return ctx.ia.demander(site, user, demandeDepuisConstat(c), { portee: 'pages', seo: { regle: c.regle, page: c.page, message: c.message } });
  });
  // Rapport mensuel : aperçu du mois (rien n'est envoyé) et rapports déjà envoyés.
  app.get('/api/sites/:id/referencement/rapport', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'voir');
    return { apercu: ctx.referencement.rapport(site), envoyes: ctx.referencement.rapportsEnvoyes(site) };
  });
  app.put('/api/sites/:id/referencement/reglages', async (req) => {
    const { user } = requireUser(req);
    const { site } = ctx.sites.require(user, siteParam(req), 'reglages');
    const r = ctx.referencement.regler(site, body<{ hebdo?: boolean; mensuel?: boolean }>(req));
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
