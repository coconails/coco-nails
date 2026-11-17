import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupOwner, startPaginity, stopPaginity, waitJob, type Client } from './helpers.js';
import { adresseDe, auditer, fichierPour } from '../src/marketing/audit.js';

/**
 * M1 — audit de référencement local : règles déterministes sur un site sans défaut et sur un site plein de défauts,
 * puis un vrai site PAGINITY (brouillon, en ligne), historique, comparaison, audit hebdomadaire et alerte.
 * Lecture seule : on vérifie aussi que rien n'est modifié.
 */
function site(fichiers: Record<string, string | Buffer>): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-'));
  for (const [f, c] of Object.entries(fichiers)) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), c);
  }
  return d;
}
const JSONLD = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const page = (o: { titre?: string; desc?: string; corps?: string; tete?: string; lang?: boolean } = {}) =>
  `<!doctype html><html${o.lang === false ? '' : ' lang="fr"'}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `${o.titre === undefined ? '<title>Prothésiste ongulaire à Saint-Jean | Salon</title>' : o.titre ? `<title>${o.titre}</title>` : ''}` +
  `${o.desc === undefined ? '<meta name="description" content="Pose gel, remplissage et vernis semi-permanent sur rendez-vous, à Saint-Jean-du-Bois, entre Noyen et La Suze.">' : ''}` +
  `${o.tete ?? ''}</head><body>${o.corps ?? '<h1>Salon</h1>'}</body></html>`;

describe('Audit de référencement — règles', () => {
  it('adresses et fichiers servis', () => {
    expect(adresseDe('index.html')).toBe('/');
    expect(adresseDe('tarifs/index.html')).toBe('/tarifs/');
    expect(adresseDe('merci.html')).toBe('/merci.html');
    const d = site({ 'index.html': 'x', 'merci.html': 'x', 'a/index.html': 'x' });
    expect(fichierPour(d, '/')).toBe('index.html');
    expect(fichierPour(d, '/merci')).toBe('merci.html');
    expect(fichierPour(d, '/a')).toBe('a/index.html');
    expect(fichierPour(d, '/../../etc/passwd')).toBeNull();
  });

  it('un site soigné : aucun problème ni point d’attention, et ce qui est correct est listé', () => {
    const local = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'NailSalon', name: 'Salon', telephone: '+33 7 00 00 00 01', address: { '@type': 'PostalAddress', addressLocality: 'Saint-Jean' }, openingHours: 'Mo 09:00-19:00' },
        { '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Sur rendez-vous ?', acceptedAnswer: { '@type': 'Answer', text: 'Oui.' } }] },
      ],
    };
    const og = '<meta property="og:title" content="Salon"><meta property="og:description" content="Ongles"><meta property="og:image" content="https://salon.fr/i.webp"><link rel="canonical" href="https://salon.fr/">';
    const d = site({
      'index.html': page({ tete: og + JSONLD(local), corps: '<h1>Salon</h1><a href="tel:0700000001">07 00 00 00 01</a><a href="/tarifs.html">Tarifs</a><img src="/i.webp" alt="Mains" width="10" height="10">' }),
      'tarifs.html': page({ titre: 'Tarifs des soins des ongles | Salon', desc: undefined, tete: '<link rel="canonical" href="https://salon.fr/tarifs.html">', corps: '<h1>Tarifs</h1><a href="/">Accueil</a>' }).replace('Pose gel, remplissage', 'Tous les tarifs : pose'),
      '404.html': page({ titre: 'Introuvable', tete: '<meta name="robots" content="noindex">' }),
      'i.webp': Buffer.alloc(10),
      'robots.txt': 'User-agent: *\nAllow: /\nSitemap: https://salon.fr/sitemap.xml\n',
      'sitemap.xml': '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://salon.fr/</loc><lastmod>2026-11-17</lastmod></url><url><loc>https://salon.fr/tarifs.html</loc></url></urlset>',
    });
    const r = auditer(d, ['salon.fr']);
    expect(r.constats.filter((c) => c.niveau !== 'info'), JSON.stringify(r.constats, null, 1)).toEqual([]);
    expect(r.pagesIndexables).toBe(2);
    expect(r.verifie).toEqual(
      expect.arrayContaining([
        'robots.txt n’interdit pas le site',
        'sitemap.xml valide (2 adresse(s), toutes présentes)',
        'FAQ structurée valide (1 questions)',
        'téléphone identique sur le site et dans les données structurées (07 00 00 00 01)',
        'aucun lien interne cassé',
      ]),
    );
  });

  it('un site plein de défauts : chacun est repéré, au bon niveau', () => {
    const d = site({
      'index.html': page({
        titre: '{{NOM_DU_SITE}}',
        lang: false,
        tete: '<link rel="canonical" href="https://autre-site.fr/">' + JSONLD({ '@context': 'https://schema.org', '@type': 'BeautySalon', name: 'X', telephone: '06 11 22 33 44' }) + '<script type="application/ld+json">{ "oubli": </script>',
        corps: '<h1>A</h1><h1>B</h1><a href="/contact.html">Contact</a><a href="tel:0700000001">Appeler</a><img src="/lourde.jpg">',
      }),
      'a.html': page({ titre: 'Même titre partout ici', desc: '' }).replace('<meta name="viewport" content="width=device-width, initial-scale=1">', ''),
      'b.html': page({ titre: 'Même titre partout ici', corps: '<p>sans h1</p>' }),
      'lourde.jpg': Buffer.alloc(400 * 1024),
      'robots.txt': 'User-agent: *\nDisallow: /\n',
      'sitemap.xml': '<urlset><url><loc>https://salon.fr/disparue.html</loc></url><url><loc>https://salon.fr/a.html</loc><lastmod>17/11/2026</lastmod></url></urlset>',
    });
    const r = auditer(d, ['salon.fr']);
    const regles = (niveau: string) => r.constats.filter((c) => c.niveau === niveau).map((c) => c.regle).sort();
    expect(regles('probleme')).toEqual(['canonical-domaine', 'jsonld-illisible', 'lien-casse', 'robots-tout-bloque', 'sitemap-page-absente', 'telephone-incoherent', 'titre-modele', 'viewport']);
    expect(regles('attention')).toEqual(
      expect.arrayContaining(['description-absente', 'h1-absent', 'hors-sitemap', 'image-lourde', 'image-sans-alt', 'jsonld-local-incomplet', 'langue', 'sitemap-date', 'titre-double']),
    );
    expect(r.constats.find((c) => c.regle === 'telephone-incoherent')!.message).toContain('06 11 22 33 44');
    expect(r.constats[0].niveau).toBe('probleme'); // les problèmes d'abord
  });

  it('noindex : grave sur l’accueil ou dans le sitemap, simple information ailleurs', () => {
    const d = site({
      'index.html': page({ tete: '<meta name="robots" content="noindex, nofollow">' }),
      'merci.html': page({ tete: '<meta name="robots" content="noindex">' }),
      'prive.html': page({ tete: '<meta name="robots" content="noindex">' }),
      'sitemap.xml': '<urlset><url><loc>https://salon.fr/prive.html</loc></url></urlset>',
    });
    const r = auditer(d, ['salon.fr']);
    const n = Object.fromEntries(r.constats.map((c) => [`${c.regle}${c.page}`, c.niveau]));
    expect(n['accueil-noindex/']).toBe('probleme');
    expect(n['noindex-dans-sitemap/prive.html']).toBe('probleme');
    expect(n['noindex/merci.html']).toBe('info');
  });
});

type P = Awaited<ReturnType<typeof startPaginity>>;
describe('Audit de référencement — dans PAGINITY', () => {
  let p: P;
  let c: Client;
  let id: string;
  beforeAll(async () => {
    p = await startPaginity();
    ({ c } = await setupOwner(p));
    id = (await c.call('POST', '/api/sites', { nom: 'Salon Référencement', modele: 'vitrine' })).json.id;
  }, 60_000);
  afterAll(async () => stopPaginity(p));

  it('audite le brouillon sans rien modifier ni toucher à l’aperçu', async () => {
    const avant = (await c.call('GET', `/api/sites/${id}/fichier?chemin=public/index.html`)).json.version;
    const r = await c.call('POST', `/api/sites/${id}/referencement/audit`, { cible: 'brouillon' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.brouillon.pages).toBeGreaterThan(0);
    const regles = r.json.brouillon.constats.map((x: any) => x.regle);
    expect(regles).toContain('sitemap-absent'); // le modèle vitrine n'a pas de sitemap : c'est vrai
    expect((await c.call('GET', `/api/sites/${id}/fichier?chemin=public/index.html`)).json.version).toBe(avant);
    expect(fs.existsSync(p.ctx.sites.previewLink(p.ctx.sites.get(id)!))).toBe(false); // l'aperçu n'a pas été créé
    expect((await c.call('POST', `/api/sites/${id}/referencement/audit`, { cible: 'en-ligne' })).json.erreur).toMatch(/pas encore publié/);
  });

  it('compare avec l’audit précédent : nouveaux constats et constats corrigés', async () => {
    const f = (await c.call('GET', `/api/sites/${id}/fichier?chemin=public/index.html`)).json;
    await c.call('PUT', `/api/sites/${id}/fichier`, { chemin: 'public/index.html', contenu: f.contenu.replace('</main>', '<a href="/oubliee.html">x</a></main>'), version: f.version });
    const r = (await c.call('POST', `/api/sites/${id}/referencement/audit`, { cible: 'brouillon' })).json;
    const lien = r.brouillon.constats.find((x: any) => x.regle === 'lien-casse');
    expect(lien).toMatchObject({ niveau: 'probleme', nouveau: true, page: '/' });
    expect(r.brouillon.constats.filter((x: any) => x.nouveau)).toHaveLength(1);
    const g = (await c.call('GET', `/api/sites/${id}/fichier?chemin=public/index.html`)).json;
    await c.call('PUT', `/api/sites/${id}/fichier`, { chemin: 'public/index.html', contenu: g.contenu.replace('<a href="/oubliee.html">x</a>', ''), version: g.version });
    const r2 = (await c.call('POST', `/api/sites/${id}/referencement/audit`, { cible: 'brouillon' })).json;
    expect(r2.brouillon.corriges.map((x: any) => x.regle)).toEqual(['lien-casse']);
    expect(r2.historique).toHaveLength(3);
  });

  it('audit de la version en ligne après publication', async () => {
    const j = await c.call('POST', `/api/sites/${id}/publier`, {});
    expect((await waitJob(p, j.json.id)).etat).toBe('reussie');
    const r = (await c.call('POST', `/api/sites/${id}/referencement/audit`, { cible: 'en-ligne' })).json;
    expect(r.enLigne.pages).toBeGreaterThan(0);
  });

  it('audit hebdomadaire (si activé) : alerte seulement pour les NOUVEAUX problèmes', async () => {
    const s = () => p.ctx.sites.get(id)!;
    await p.ctx.referencement.tic();
    const nb = () => (p.ctx.db.prepare('SELECT COUNT(*) AS n FROM seo_audits WHERE site_id = ?').get(id) as { n: number }).n;
    const n0 = nb();
    expect(nb()).toBe(n0); // désactivé par défaut : rien
    expect((await c.call('PUT', `/api/sites/${id}/referencement/reglages`, { hebdo: true })).json.reglages.hebdo).toBe(true);
    await p.ctx.referencement.tic();
    expect(nb()).toBe(n0); // audit en ligne de moins d'une semaine : rien
    // Une semaine plus tard, un lien cassé est apparu… dans la version en ligne (republiée).
    const f = (await c.call('GET', `/api/sites/${id}/fichier?chemin=public/index.html`)).json;
    await c.call('PUT', `/api/sites/${id}/fichier`, { chemin: 'public/index.html', contenu: f.contenu.replace('</main>', '<a href="/perdue.html">x</a></main>'), version: f.version });
    const j = await c.call('POST', `/api/sites/${id}/publier`, {});
    await waitJob(p, j.json.id);
    p.ctx.db.prepare('UPDATE seo_audits SET le = le - ? WHERE site_id = ?').run(8 * 86_400_000, id);
    await p.ctx.referencement.tic();
    expect(nb()).toBe(n0 + 1);
    const al = p.ctx.db.prepare("SELECT message FROM alerts WHERE site_id = ? ORDER BY id DESC LIMIT 1").get(id) as { message: string };
    expect(al.message).toMatch(/Référencement de « Salon Référencement » : 1 nouveau\(x\) problème\(s\), dont « Lien vers une page qui n’existe pas : \/perdue\.html\. »/);
    expect(s().live_publication).not.toBeNull();
  });
});
