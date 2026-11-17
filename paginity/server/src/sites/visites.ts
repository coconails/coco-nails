import type http from 'node:http';
import type { Ctx } from '../context.js';
import type { SiteRow } from './service.js';
import { decalerJour, jourLocal } from '../lib/fuseau.js';

/**
 * Compteur de visites sans cookies ni données personnelles : seulement « telle page, tel jour, N fois ».
 * Aucune adresse IP, aucun identifiant, aucun traceur : rien qui permette de reconnaître une personne, donc pas de
 * bandeau de consentement nécessaire. Les robots connus et les préchargements ne sont pas comptés.
 * Les journées sont découpées à minuit, heure de Paris. Limite assumée : ce sont des pages vues, pas des visiteurs différents.
 */
const ROBOTS = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|monitor|uptime|headless|lighthouse|curl|wget|python|node-fetch|go-http/i;

export function compterVisite(ctx: Ctx, site: SiteRow, req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method !== 'GET') return;
  const ua = String(req.headers['user-agent'] ?? '');
  if (!ua || ROBOTS.test(ua)) return;
  if (req.headers['sec-purpose'] || req.headers.purpose === 'prefetch') return;
  if (!String(req.headers.accept ?? '').includes('text/html')) return;
  let chemin: string;
  try {
    chemin = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).slice(0, 200);
  } catch {
    return;
  }
  const derniere = chemin.split('/').pop() ?? '';
  if (derniere.includes('.') && !/\.html?$/i.test(derniere)) return; // un fichier (image, style…), pas une page
  res.on('finish', () => {
    if (res.statusCode !== 200) return;
    const jour = jourLocal();
    try {
      ctx.db.prepare('INSERT INTO visites (site_id, jour, chemin, vues) VALUES (?, ?, ?, 1) ON CONFLICT(site_id, jour, chemin) DO UPDATE SET vues = vues + 1').run(site.id, jour, chemin.replace(/\/index\.html$/, '/'));
    } catch {
      /* compteur facultatif : ne jamais gêner le site */
    }
  });
}

export function lireVisites(ctx: Ctx, site: SiteRow, jours = 30) {
  const aujourdhui = jourLocal();
  const depuis = decalerJour(aujourdhui, -(jours - 1));
  const parJourBrut = ctx.db.prepare('SELECT jour, SUM(vues) AS vues FROM visites WHERE site_id = ? AND jour >= ? GROUP BY jour').all(site.id, depuis) as { jour: string; vues: number }[];
  const index = new Map(parJourBrut.map((r) => [r.jour, r.vues]));
  const parJour = Array.from({ length: jours }, (_, i) => {
    const jour = decalerJour(depuis, i);
    return { jour, vues: index.get(jour) ?? 0 };
  });
  const pages = ctx.db.prepare('SELECT chemin, SUM(vues) AS vues FROM visites WHERE site_id = ? AND jour >= ? GROUP BY chemin ORDER BY vues DESC LIMIT 10').all(site.id, depuis) as { chemin: string; vues: number }[];
  return { jours, total: parJour.reduce((a, x) => a + x.vues, 0), parJour, pages };
}

export function purgerVisites(ctx: Ctx): void {
  ctx.db.prepare('DELETE FROM visites WHERE jour < ?').run(decalerJour(jourLocal(), -400));
}
