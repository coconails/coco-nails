import crypto from 'node:crypto';
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
