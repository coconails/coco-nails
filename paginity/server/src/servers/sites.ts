import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { Ctx } from '../context.js';
import { adminOrigin } from '../config.js';
import { getUser } from '../auth/service.js';
import { now } from '../lib/util.js';
import { readRules, serveStatic, simplePage } from './static.js';
import { handleFormPost, isFormPost } from '../functions/forms.js';
import { isFunctionPath } from '../functions/routes.js';
import { hasTestSecrets } from '../functions/secrets.js';
import { realIp } from '../lib/ip.js';

export function clientIp(req: http.IncomingMessage): string {
  return realIp(req.socket.remoteAddress, req.headers);
}

function pathOf(req: http.IncomingMessage): string {
  try {
    return decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  } catch {
    return '/';
  }
}

function hostOf(req: http.IncomingMessage): string {
  return String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

/**
 * Serveur des sites publics : choisit le site d'après le nom de domaine demandé et sert sa version en ligne.
 * En production, il est placé derrière Caddy et le tunnel ; pour un essai local, adresse <identifiant>.localhost:8082.
 */
export function createSitesServer(ctx: Ctx): http.Server {
  return http.createServer((req, res) => {
    const site = ctx.sites.hostMap().get(hostOf(req));
    if (!site) return simplePage(res, 404, 'Aucun site ici', "Ce nom de domaine n'est relié à aucun site PAGINITY.");
    let root: string;
    try {
      root = fs.realpathSync(ctx.sites.liveLink(site));
    } catch {
      return simplePage(res, 503, site.name, "Ce site n'est pas encore publié.");
    }
    const rules = readRules(root);
    // Les adresses des fonctions passent en premier (comme chez Netlify) : un formulaire HTML envoyé à une
    // fonction (ex. « Confirmer le rendez-vous ») doit arriver à la fonction, pas au module formulaires.
    if (rules.functionsDir && (isFunctionPath(ctx.scheduler.catalog(site.id), pathOf(req)) || pathOf(req).startsWith('/api/'))) {
      void ctx.functions.proxy(site, 'production', req, res, clientIp(req));
      return;
    }
    if (isFormPost(req) && rules.forms?.length) {
      handleFormPost(ctx, site, rules.forms, req, res, clientIp(req)).catch((e) => {
        if (!res.headersSent) res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end((e as Error).message);
      });
      return;
    }
    serveStatic(root, req, res, {
      functionsMessage: 'Ce site n’a pas de fonction serveur à cette adresse.',
    });
  });
}

// ---------------------------------------------------------------------------
// Aperçus privés
// ---------------------------------------------------------------------------

const LINK_MS = 2 * 3_600_000;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * Lien d'aperçu : une adresse temporaire et impossible à deviner, du type <site>--<code>.<domaine d'aperçu>.
 * Pas de cookie (les navigateurs les bloquent de plus en plus dans les cadres) : c'est l'adresse elle-même qui donne l'accès,
 * pendant 2 heures, et seulement tant que la personne a toujours accès au site.
 */
export function createPreviewLink(ctx: Ctx, siteId: string, slug: string, userId: string): string {
  const bytes = crypto.randomBytes(16);
  let code = '';
  for (const b of bytes) code += ALPHABET[b % 32];
  const label = `${slug}--${code}`.slice(0, 63);
  ctx.db.prepare('DELETE FROM preview_links WHERE expires_at < ?').run(now());
  ctx.db.prepare('INSERT INTO preview_links (label, site_id, user_id, expires_at) VALUES (?, ?, ?, ?)').run(label, siteId, userId, now() + LINK_MS);
  return label;
}

function resolvePreview(ctx: Ctx, label: string) {
  const row = ctx.db.prepare('SELECT * FROM preview_links WHERE label = ?').get(label) as { site_id: string; user_id: string; expires_at: number } | undefined;
  if (!row || row.expires_at < now()) return null;
  const site = ctx.sites.get(row.site_id);
  const user = getUser(ctx, row.user_id);
  if (!site || !user || user.disabled || !ctx.sites.role(user, site.id)) return null;
  return site;
}

/**
 * Serveur des aperçus : sur une origine distincte de l'administration (D12), accessible seulement
 * par un lien temporaire. Les fonctions serveur n'y sont jamais exécutées avec les vrais secrets (D11).
 */
export function createPreviewServer(ctx: Ctx): http.Server {
  return http.createServer((req, res) => {
    const host = hostOf(req);
    const suffix = `.${ctx.config.previewBaseDomain}`;
    const label = host.endsWith(suffix) ? host.slice(0, -suffix.length) : '';
    const site = /^[a-z0-9-]{1,63}$/.test(label) ? resolvePreview(ctx, label) : null;
    if (!site) return simplePage(res, 404, 'Aperçu expiré ou introuvable', 'Ouvrez un nouvel aperçu depuis PAGINITY.');
    let root: string;
    try {
      root = fs.realpathSync(ctx.sites.previewLink(site));
    } catch {
      return simplePage(res, 404, 'Aperçu non préparé', 'Demandez un aperçu depuis PAGINITY.');
    }
    const rules = readRules(root);
    const versFonction = isFunctionPath(ctx.scheduler.catalog(site.id), pathOf(req)) || pathOf(req).startsWith('/api/');
    // Même ordre qu'en production : d'abord les fonctions, mais seulement avec des secrets de test (D11).
    if (rules.functionsDir && versFonction && hasTestSecrets(ctx, site.id)) {
      void ctx.functions.proxy(site, 'test', req, res, clientIp(req), previewHeaders(ctx));
      return;
    }
    if (isFormPost(req) && rules.forms?.length && !versFonction) {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end('<!doctype html><meta charset="utf-8"><title>Aperçu</title><p>Aperçu : le formulaire fonctionne, mais rien n’a été envoyé ni enregistré.</p>');
      return;
    }
    serveStatic(root, req, res, {
      functionsMessage: rules.functionsDir
        ? 'Aperçu : les fonctions serveur ne sont pas exécutées tant qu’aucun secret de test n’est enregistré (aucun SMS, e-mail ou paiement réel).'
        : 'Ce site n’a pas de fonction serveur à cette adresse.',
      extraHeaders: { 'Cache-Control': 'no-store' },
      enforcedHeaders: previewHeaders(ctx),
    });
  });
}

/**
 * En-têtes de toutes les réponses d'aperçu, que le site ne peut pas remplacer :
 * - la page ne peut s'afficher que dans PAGINITY (frame-ancestors) ;
 * - elle ne peut appeler que sa propre adresse (connect-src) : pas le site en ligne, pas un service extérieur ;
 * - ses formulaires ne partent que vers elle-même (form-action), où rien n'est envoyé pour de vrai.
 */
function previewHeaders(ctx: Ctx): Record<string, string> {
  return {
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `frame-ancestors ${adminOrigin(ctx.config)}; connect-src 'self'; form-action 'self'`,
  };
}
