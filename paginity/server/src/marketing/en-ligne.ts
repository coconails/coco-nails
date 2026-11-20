import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../context.js';
import { siteTestOrigin } from '../config.js';
import type { SiteRow } from '../sites/service.js';
import { suivre } from '../lib/requete-sure.js';
import { adresseDe, type Constat, type Niveau, type ResultatAudit } from './audit.js';

/**
 * Contrôle du site EN LIGNE, à la demande (jamais automatique) :
 * - chaque page publiée répond-elle bien (pas d'erreur, pas de chaîne de redirections) ?
 * - une adresse inconnue renvoie-t-elle une vraie erreur 404 (sinon Google peut indexer des pages vides) ?
 * - avec un domaine : l'adresse en http redirige-t-elle vers https ?
 * - les liens vers d'AUTRES sites fonctionnent-ils encore ?
 * Requêtes de lecture seulement, une à la fois, 40 liens externes au plus, jamais vers le réseau de la maison.
 */
const MAX_PAGES = 50;
const MAX_EXTERNES = 40;
const PAUSE = 300;
/** Durée maximale d'un contrôle : au-delà, les liens restants ne sont pas vérifiés (dit dans le résultat). */
const DUREE_MAX = 3 * 60_000;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fichiersHtml(racine: string, rel = '', out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(racine, rel), { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) fichiersHtml(racine, r, out);
    else if (e.isFile() && /\.html?$/i.test(e.name)) out.push(r);
  }
  return out;
}

export async function controlerEnLigne(ctx: Ctx, site: SiteRow, racine: string, opts: { pause?: number } = {}): Promise<ResultatAudit> {
  const constats: Constat[] = [];
  const verifie: string[] = [];
  const ajouter = (regle: string, niveau: Niveau, page: string | null, message: string, conseil: string) => constats.push({ regle, niveau, page, message, conseil });
  const attente = opts.pause ?? PAUSE;
  const fin = Date.now() + DUREE_MAX;
  const domaines = ctx.sites.domains(site).map((d) => d.toLowerCase());
  // Avec un domaine : le vrai site public. Sans domaine (essai) : le serveur des sites de PAGINITY, en direct.
  const origine = domaines.length ? `https://${domaines[0]}` : siteTestOrigin(ctx.config, site.slug);
  const interne = domaines.length ? undefined : { port: ctx.config.sitesPort, hote: new URL(origine).host, origine };

  const pages = fichiersHtml(racine)
    .filter((f) => !/(^|\/)404\.html?$/i.test(f))
    .map((f) => ({ f, html: fs.readFileSync(path.join(racine, f), 'utf8') }))
    .filter((p) => !/<meta[^>]+name=["']robots["'][^>]+noindex/i.test(p.html))
    .slice(0, MAX_PAGES);

  // ---- pages publiées
  let correctes = 0;
  for (const p of pages) {
    const url = adresseDe(p.f);
    try {
      const r = await suivre(origine + url, { methode: 'GET', interne });
      if (r.statut >= 400) ajouter('en-ligne-erreur', 'probleme', url, `La page répond par une erreur ${r.statut} sur le site en ligne.`, 'Vérifiez que la dernière publication a réussi et que la page existe toujours.');
      else if (r.etapes.length >= 2) ajouter('redirection-chaine', 'attention', url, `${r.etapes.length} redirections avant d’arriver sur la page (${new URL(r.finale).pathname}).`, 'Une chaîne de redirections ralentit la page et dilue les liens : faites pointer directement vers l’adresse finale.');
      else if (r.etapes.length === 1) ajouter('redirection', 'info', url, `Cette adresse redirige vers ${new URL(r.finale).pathname}.`, 'Si le sitemap ou vos liens utilisent cette adresse, remplacez-la par l’adresse finale.');
      else correctes++;
    } catch (e) {
      ajouter('en-ligne-injoignable', 'probleme', url, `Page injoignable sur le site en ligne (${(e as Error).message}).`, 'Vérifiez que le site est en ligne et que le domaine pointe bien vers le serveur.');
    }
    await pause(attente);
  }
  if (pages.length && correctes === pages.length) verifie.push(pages.length === 1 ? 'la page publiée répond directement, sans erreur ni redirection' : `les ${pages.length} pages publiées répondent directement, sans erreur ni redirection`);

  // ---- vraie erreur 404 pour une adresse inconnue
  try {
    const inconnue = `/paginity-verification-${crypto.randomBytes(4).toString('hex')}`;
    const r = await suivre(origine + inconnue, { methode: 'GET', interne });
    if (r.statut === 404 || r.statut === 410) verifie.push('une adresse inconnue renvoie bien une erreur 404');
    else if (r.statut < 400) ajouter('fausse-404', 'attention', null, `Une adresse qui n’existe pas répond « ${r.statut} » au lieu d’une erreur 404.`, 'Google risque d’indexer des pages vides ou en double. La page « introuvable » doit renvoyer le code 404.');
  } catch {
    /* déjà signalé si le site est injoignable */
  }

  // ---- http → https (seulement avec un vrai domaine)
  if (domaines.length) {
    try {
      const r = await suivre(`http://${domaines[0]}/`, { methode: 'GET' });
      if (r.etapes.length && r.finale.startsWith('https://')) verifie.push('l’adresse en http redirige vers https');
      else ajouter('https-redirection', 'attention', '/', 'L’adresse en http (non sécurisée) ne redirige pas vers https.', 'Les visiteurs et Google doivent toujours arriver sur la version sécurisée (https).');
    } catch {
      /* http fermé : acceptable */
    }
  }

  // ---- liens vers d'autres sites
  const externes = new Map<string, string>();
  for (const p of pages) {
    for (const m of p.html.matchAll(/<a\b[^>]*\bhref\s*=\s*["'](https?:\/\/[^"'#\s]+)[^"']*["']/gi)) {
      let u: URL;
      try {
        u = new URL(m[1].replace(/&amp;/g, '&'));
      } catch {
        continue;
      }
      const hote = u.hostname.toLowerCase();
      if (domaines.includes(hote) || domaines.includes(hote.replace(/^www\./, ''))) continue;
      if (!externes.has(u.toString())) externes.set(u.toString(), adresseDe(p.f));
    }
  }
  const aVerifier = [...externes].slice(0, MAX_EXTERNES);
  let casses = 0;
  let nonVerifies = 0;
  for (const [lien, page] of aVerifier) {
    if (Date.now() > fin) {
      nonVerifies++;
      continue;
    }
    try {
      let r = await suivre(lien, { methode: 'HEAD' });
      if ([403, 405, 501].includes(r.statut)) r = await suivre(lien, { methode: 'GET' });
      if (r.statut === 404 || r.statut === 410) {
        casses++;
        ajouter('lien-externe-casse', 'attention', page, `Lien vers une page qui n’existe plus : ${lien.slice(0, 120)} (erreur ${r.statut}).`, 'Corrigez le lien ou retirez-le : un lien mort gêne les visiteurs.');
      } else if (r.statut >= 500) ajouter('lien-externe-erreur', 'info', page, `L’autre site répond par une erreur ${r.statut} : ${lien.slice(0, 120)}.`, 'Peut-être temporaire : revérifiez plus tard avant de changer le lien.');
      else if ([401, 403, 429].includes(r.statut)) ajouter('lien-externe-refuse', 'info', page, `L’autre site refuse les vérifications automatiques (${r.statut}) : ${lien.slice(0, 120)}.`, 'Impossible de savoir s’il fonctionne ; ouvrez-le vous-même une fois.');
    } catch (e) {
      ajouter('lien-externe-injoignable', 'info', page, `Lien impossible à vérifier : ${lien.slice(0, 120)} (${(e as Error).message}).`, 'Ouvrez-le vous-même : si le site n’existe plus, retirez le lien.');
    }
    await pause(attente);
  }
  if (nonVerifies) ajouter('controle-interrompu', 'info', null, `${nonVerifies} lien(s) externe(s) non vérifié(s) : le contrôle a atteint sa durée maximale (3 minutes).`, 'Relancez le contrôle plus tard.');
  if (aVerifier.length && !casses && !nonVerifies) verifie.push(`aucun lien externe cassé (${aVerifier.length} vérifié(s))`);
  if (externes.size > MAX_EXTERNES) ajouter('liens-externes-nombreux', 'info', null, `${externes.size} liens externes : seuls les ${MAX_EXTERNES} premiers ont été vérifiés.`, 'Relancez le contrôle plus tard pour en vérifier d’autres.');

  const ordre: Record<Niveau, number> = { probleme: 0, attention: 1, info: 2 };
  constats.sort((a, b) => ordre[a.niveau] - ordre[b.niveau] || (a.page ?? '').localeCompare(b.page ?? ''));
  return { pages: pages.length, pagesIndexables: pages.length, constats, verifie };
}
