import fs from 'node:fs';
import http from 'node:http';
import type { Ctx } from '../context.js';
import { adminOrigin } from '../config.js';
import { getUser } from '../auth/service.js';
import { now } from '../lib/util.js';
import { serveStatic, simplePage } from './static.js';

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
    serveStatic(root, req, res, {
      functionsMessage: 'Les fonctions serveur de ce site ne sont pas encore actives sur PAGINITY (prévu en phase 3).',
    });
  });
}

// ---------------------------------------------------------------------------
// Aperçus privés
// ---------------------------------------------------------------------------

const COOKIE = 'paginity_apercu';
const TOKEN_MS = 2 * 3_600_000;

export function previewToken(ctx: Ctx, siteId: string, userId: string): string {
  const payload = `${siteId}.${userId}.${now() + TOKEN_MS}`;
  return `${Buffer.from(payload).toString('base64url')}.${ctx.vault.sign(`apercu:${payload}`)}`;
}

function checkToken(ctx: Ctx, token: string | undefined, siteId: string): boolean {
  if (!token) return false;
  const [b64, sig] = token.split('.');
  if (!b64 || !sig) return false;
  const payload = Buffer.from(b64, 'base64url').toString('utf8');
  if (ctx.vault.sign(`apercu:${payload}`) !== sig) return false;
  const [sid, uid, exp] = payload.split('.');
  if (sid !== siteId || Number(exp) < now()) return false;
  const user = getUser(ctx, uid);
  return !!user && !user.disabled && !!ctx.sites.role(user, siteId);
}

function readCookie(req: http.IncomingMessage, name: string): string | undefined {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? '');
  return m ? decodeURIComponent(m[1]) : undefined;
}

/**
 * Serveur des aperçus : sur une origine distincte de l'administration (D12), accessible seulement
 * avec un lien signé et temporaire. Les fonctions serveur n'y sont jamais exécutées avec les vrais secrets (D11).
 */
export function createPreviewServer(ctx: Ctx): http.Server {
  return http.createServer((req, res) => {
    const host = hostOf(req);
    const suffix = `.${ctx.config.previewBaseDomain}`;
    const slug = host.endsWith(suffix) ? host.slice(0, -suffix.length) : '';
    const site = slug ? ctx.sites.all().find((s) => s.slug === slug) : undefined;
    if (!site) return simplePage(res, 404, 'Aperçu introuvable', "Cet aperçu n'existe pas.");
    const url = new URL(req.url ?? '/', 'http://apercu.invalid');
    const fromQuery = url.searchParams.get('jeton');
    if (fromQuery) {
      if (!checkToken(ctx, fromQuery, site.id)) return simplePage(res, 403, 'Lien expiré', "Ce lien d'aperçu a expiré. Ouvrez-en un nouveau depuis PAGINITY.");
      url.searchParams.delete('jeton');
      res.writeHead(303, {
        Location: url.pathname + (url.search || ''),
        'Set-Cookie': `${COOKIE}=${encodeURIComponent(fromQuery)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TOKEN_MS / 1000}${ctx.config.previewProtocol === 'https' ? '; Secure' : ''}`,
        'Cache-Control': 'no-store',
      });
      return res.end();
    }
    if (!checkToken(ctx, readCookie(req, COOKIE), site.id)) {
      return simplePage(res, 403, 'Aperçu privé', 'Cet aperçu est réservé aux personnes connectées à PAGINITY. Ouvrez-le depuis l’administration.');
    }
    let root: string;
    try {
      root = fs.realpathSync(ctx.sites.previewLink(site));
    } catch {
      return simplePage(res, 404, 'Aperçu non préparé', 'Demandez un aperçu depuis PAGINITY.');
    }
    serveStatic(root, req, res, {
      functionsMessage: 'Aperçu : les fonctions serveur ne sont pas exécutées (aucun SMS, e-mail ou paiement réel).',
      extraHeaders: {
        'X-Robots-Tag': 'noindex, nofollow',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': `frame-ancestors ${adminOrigin(ctx.config)}`,
      },
    });
  });
}
