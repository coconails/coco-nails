import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupOwner, startPaginity, stopPaginity, waitJob, type Client } from './helpers.js';
import { auditer } from '../src/marketing/audit.js';
import { adresseInterne, adresseRefusee } from '../src/lib/requete-sure.js';

/**
 * Référencement, priorité 1 : nouvelles règles de l'audit local (intertitres, pages orphelines, adresses,
 * fichiers lourds) et contrôle du site EN LIGNE (réponses des pages, vraie 404, liens externes), avec un faux
 * site extérieur local. Aucune requête vers un vrai service.
 */
function site(fichiers: Record<string, string | Buffer>): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-p1-'));
  for (const [f, c] of Object.entries(fichiers)) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), c);
  }
  return d;
}
const page = (corps: string, tete = '') =>
  `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Une page du salon de beauté</title><meta name="description" content="Une description suffisamment longue pour ne pas être signalée par l’audit, avec le lieu.">${tete}</head><body>${corps}</body></html>`;

describe('Référencement P1 — nouvelles règles locales', () => {
  it('intertitres sautés ou vides, page orpheline, adresse peu lisible, fichier lourd', () => {
    const d = site({
      'index.html': page('<h1>Salon</h1><h3>Tarifs</h3><h2></h2><a href="/Mes_Tarifs.html">Tarifs</a><script src="/gros.js"></script>'),
      'Mes_Tarifs.html': page('<h1>Tarifs</h1><h2>Pose</h2><a href="/">Accueil</a>'),
      'oubliee.html': page('<h1>Oubliée</h1><a href="/">Accueil</a>'),
      'gros.js': Buffer.alloc(300 * 1024),
    });
    const r = auditer(d);
    const par = (regle: string) => r.constats.filter((c) => c.regle === regle);
    expect(par('intertitres-hierarchie')[0]).toMatchObject({ niveau: 'attention', page: '/' });
    expect(par('intertitres-hierarchie')[0].message).toContain('<h1> suivi de <h3>');
    expect(par('intertitre-vide')[0]).toMatchObject({ page: '/' });
    expect(par('page-orpheline').map((c) => c.page)).toEqual(['/oubliee.html']); // l'accueil n'est jamais « orpheline »
    expect(par('adresse-page')[0].message).toMatch(/majuscules.*tirets bas/);
    expect(par('ressource-lourde')[0].message).toContain('gros.js (300 Ko)');
  });

  it('un site soigné ne déclenche aucune de ces nouvelles règles', () => {
    const d = site({
      'index.html': page('<h1>Salon</h1><h2>Soins</h2><h3>Pose gel</h3><a href="/tarifs.html">Tarifs</a>'),
      'tarifs.html': page('<h1>Tarifs</h1><h2>Pose</h2><a href="/">Accueil</a>'),
    });
    const r = auditer(d);
    expect(r.constats.map((c) => c.regle)).not.toEqual(expect.arrayContaining(['intertitres-hierarchie']));
    for (const regle of ['intertitres-hierarchie', 'intertitre-vide', 'page-orpheline', 'adresse-page', 'ressource-lourde']) expect(r.constats.some((c) => c.regle === regle)).toBe(false);
    expect(r.verifie).toEqual(expect.arrayContaining(['chaque page reçoit au moins un lien d’une autre page', 'intertitres dans l’ordre (h1, h2, h3…) et non vides']));
  });
});

describe('Référencement P1 — requêtes sûres', () => {
  it('adresses internes reconnues (IPv4, IPv6, adresses réservées)', () => {
    for (const ip of ['127.0.0.1', '10.0.0.8', '192.168.1.1', '172.20.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.1.10', '0.0.0.0']) expect(adresseInterne(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '151.101.1.1', '2a00:1450:4007::1']) expect(adresseInterne(ip), ip).toBe(false);
  });

  it('hors test : la machine, la maison, les ports et protocoles inhabituels sont refusés', () => {
    const avant = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(adresseRefusee(new URL('http://localhost/'))).toBe('adresse locale');
      expect(adresseRefusee(new URL('http://box.local/'))).toBe('adresse locale');
      expect(adresseRefusee(new URL('http://192.168.1.1/'))).toBe('adresse du réseau local');
      expect(adresseRefusee(new URL('http://[::1]/'))).toBe('adresse locale');
      expect(adresseRefusee(new URL('https://exemple.fr:8443/'))).toBe('port inhabituel');
      expect(adresseRefusee(new URL('ftp://exemple.fr/'))).toBe('adresse non web');
      expect(adresseRefusee(new URL('https://moi:mdp@exemple.fr/'))).toBe('adresse avec identifiants');
      expect(adresseRefusee(new URL('https://www.exemple.fr/page'))).toBeNull();
    } finally {
      process.env.NODE_ENV = avant;
    }
  });
});

type P = Awaited<ReturnType<typeof startPaginity>>;
describe('Référencement P1 — contrôle du site en ligne', () => {
  let p: P;
  let c: Client;
  let id: string;
  let exterieur: http.Server;
  let ext = '';
  const vus: string[] = [];
  beforeAll(async () => {
    // Faux site extérieur : une page qui marche, une page disparue, un site qui refuse HEAD.
    exterieur = http.createServer((req, res) => {
      vus.push(`${req.method} ${req.url}`);
      if (req.url === '/mort') return res.writeHead(404).end();
      if (req.url === '/sans-head' && req.method === 'HEAD') return res.writeHead(405).end();
      if (req.url === '/ancienne') return res.writeHead(301, { location: '/ok' }).end();
      res.writeHead(200, { 'content-type': 'text/html' }).end('<p>ok</p>');
    });
    await new Promise<void>((r) => exterieur.listen(0, '127.0.0.1', () => r()));
    ext = `http://127.0.0.1:${(exterieur.address() as AddressInfo).port}`;
    p = await startPaginity();
    p.ctx.referencement.pauseControle = 0;
    ({ c } = await setupOwner(p));
    id = (await c.call('POST', '/api/sites', { nom: 'Salon En Ligne', modele: 'vitrine' })).json.id;
  }, 60_000);
  afterAll(async () => {
    await stopPaginity(p);
    exterieur.close();
  });

  it('refusé tant que le site n’est pas publié', async () => {
    expect((await c.call('POST', `/api/sites/${id}/referencement/audit`, { cible: 'controle' })).json.erreur).toMatch(/pas encore publié/);
  });

  it('pages publiées, vraie 404, liens externes : seuls les vrais liens morts sont signalés', async () => {
    const f = (await c.call('GET', `/api/sites/${id}/fichier?chemin=public/index.html`)).json;
    const liens = ['/ok', '/mort', '/sans-head', '/ancienne'].map((x) => `<a href="${ext}${x}">lien</a>`).join('');
    await c.call('PUT', `/api/sites/${id}/fichier`, { chemin: 'public/index.html', contenu: f.contenu.replace('</main>', `${liens}</main>`), version: f.version });
    const j = await c.call('POST', `/api/sites/${id}/publier`, {});
    expect((await waitJob(p, j.json.id)).etat).toBe('reussie');

    const r = await c.call('POST', `/api/sites/${id}/referencement/audit`, { cible: 'controle' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const ctl = r.json.controle;
    const casses = ctl.constats.filter((x: any) => x.regle === 'lien-externe-casse');
    expect(casses).toHaveLength(1);
    expect(casses[0].message).toContain(`${ext}/mort`);
    expect(ctl.constats.some((x: any) => x.regle === 'en-ligne-erreur' || x.regle === 'en-ligne-injoignable')).toBe(false);
    expect(ctl.verifie.join(' | ')).toMatch(/publiées? répond(ent)? directement/);
    expect(ctl.verifie.join(' | ')).toMatch(/adresse inconnue renvoie bien une erreur 404/);
    // HEAD refusé → nouvel essai en GET, sans signaler de faux lien mort.
    expect(vus).toEqual(expect.arrayContaining(['HEAD /sans-head', 'GET /sans-head']));
    // Lecture seule : rien n'a changé dans le site.
    expect((await c.call('GET', `/api/sites/${id}/fichier?chemin=public/index.html`)).json.contenu).toContain(`${ext}/mort`);
    // Historique : le contrôle est rangé à part de l'audit des fichiers.
    expect(r.json.historique.some((h: any) => h.cible === 'controle')).toBe(true);
  });

  it('rapport mensuel : aperçu à la demande, envoi une seule fois le 1er du mois (heure de Paris) si activé', async () => {
    const a = (await c.call('GET', `/api/sites/${id}/referencement/rapport`)).json;
    const titres = a.apercu.sections.map((x: any) => x.titre);
    expect(titres).toEqual(['Audit du site', 'Contrôle du site en ligne', 'Dans Google (Search Console)', 'Visites (30 derniers jours, sans cookies)', 'Ce que je vous conseille ce mois-ci']);
    expect(JSON.stringify(a.apercu)).toMatch(/1 lien\(s\) vers d’autres sites cassé\(s\)/);
    expect(JSON.stringify(a.apercu)).toMatch(/non relié à Search Console/);
    expect(a.envoyes).toEqual([]);
    const premier = Date.UTC(2026, 11, 1, 8, 30); // 1er décembre, 9 h 30 à Paris
    expect(await p.ctx.referencement.envoyerRapports(premier)).toBe(0); // pas demandé : rien
    expect((await c.call('PUT', `/api/sites/${id}/referencement/reglages`, { mensuel: true })).json.reglages).toEqual({ hebdo: false, mensuel: true });
    expect(await p.ctx.referencement.envoyerRapports(Date.UTC(2026, 11, 1, 5, 0))).toBe(0); // 6 h à Paris : trop tôt
    expect(await p.ctx.referencement.envoyerRapports(Date.UTC(2026, 11, 2, 9, 0))).toBe(0); // pas le 1er
    expect(await p.ctx.referencement.envoyerRapports(premier)).toBe(1);
    expect(await p.ctx.referencement.envoyerRapports(premier + 3_600_000)).toBe(0); // une seule fois par mois
    const b = (await c.call('GET', `/api/sites/${id}/referencement/rapport`)).json;
    expect(b.envoyes).toHaveLength(1);
    expect(b.envoyes[0].mois).toBe('2026-11');
    const al = p.ctx.db.prepare("SELECT message FROM alerts WHERE site_id = ? ORDER BY id DESC LIMIT 1").get(id) as { message: string };
    expect(al.message).toMatch(/Rapport de référencement de « Salon En Ligne » disponible \(2026-11\)/);
  });

  it('limité à 2 contrôles par 10 minutes et par site', async () => {
    await c.call('POST', `/api/sites/${id}/referencement/audit`, { cible: 'controle' });
    expect((await c.call('POST', `/api/sites/${id}/referencement/audit`, { cible: 'controle' })).status).toBe(429);
  });
});
