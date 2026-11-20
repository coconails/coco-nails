import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupOwner, startPaginity, stopPaginity, totpCode, type Client } from './helpers.js';
import type { Cerveau, DemandeCerveau, ReponseCerveau } from '../src/ia/assistant.js';
import { chiffresSensibles, verifierFichier } from '../src/ia/pages.js';

/**
 * Référencement, priorité 1 : correction assistée d'un constat de l'audit.
 * Constat → demande rédigée par PAGINITY → proposition de l'assistant (faux cerveau) → vérifications propres au
 * référencement → accord → nouvel audit du brouillon qui montre si le constat a disparu. Rien n'est publié.
 */
type P = Awaited<ReturnType<typeof startPaginity>>;
let comportement: (d: DemandeCerveau) => ReponseCerveau = () => ({ statut: 'impossible', raison: 'x' });
const recu: DemandeCerveau[] = [];
const cerveau: Cerveau = {
  nom: 'local:qwen',
  tailleMax: 10_000_000,
  delaiMs: 1000,
  async disponible() {
    return true;
  },
  async proposer(d) {
    recu.push(d);
    return comportement(d);
  },
};
const html = (d: DemandeCerveau) => String(d.rubriques.find((r) => r.nom === 'fichier:public/index.html')!.valeur);
const fichier = (valeur: string): ReponseCerveau => ({ statut: 'proposition', changements: [{ rubrique: 'fichier:public/index.html', valeur }], explication: 'Description ajoutée.' });
const DESC = '<meta name="description" content="Prestations, tarifs, horaires et contact du salon : tout ce qu’il faut savoir avant de prendre rendez-vous.">';

describe('Vérifications « référencement » des fichiers proposés par l’IA', () => {
  const page = '<html><head><title>T</title><link rel="canonical" href="https://salon.fr/"><script type="application/ld+json">{"a":1}</script></head><body><p>Pose gel 35 € — 07 00 00 00 01</p></body></html>';
  it('refuse noindex, canonical modifiée, JSON-LD cassé, téléphone ou prix inventé', () => {
    expect(verifierFichier('i.html', page, page.replace('<title>', '<meta name="robots" content="noindex"><title>'), '')).toEqual(expect.arrayContaining([expect.stringMatching(/noindex/)]));
    expect(verifierFichier('i.html', page, page.replace('https://salon.fr/', 'https://salon.fr/autre'), '')).toEqual(expect.arrayContaining([expect.stringMatching(/canonique/)]));
    expect(verifierFichier('i.html', page, page.replace('{"a":1}', '{"a":'), '')).toEqual(expect.arrayContaining([expect.stringMatching(/JSON-LD/)]));
    expect(verifierFichier('i.html', page, page.replace('35 €', '39 €'), 'Ajoute une description')).toEqual(expect.arrayContaining([expect.stringMatching(/prix absent.*39/)]));
    expect(verifierFichier('i.html', page, page.replace('07 00 00 00 01', '06 99 99 99 99'), '')).toEqual(expect.arrayContaining([expect.stringMatching(/téléphone/)]));
    // Un prix demandé explicitement est accepté ; reformuler un prix existant aussi.
    expect(verifierFichier('i.html', page, page.replace('35 €', '39 €'), 'La pose gel passe à 39 €')).toEqual([]);
    expect(verifierFichier('i.html', page, page.replace('35 €', '35 euros'), '')).toEqual([]);
    expect([...chiffresSensibles('Tél. +33 7 00 00 00 01, pose 35,50 €')]).toEqual(['tel:0700000001', 'prix:35.5']);
  });
});

describe('Correction assistée depuis l’audit', () => {
  let p: P;
  let c: Client;
  let id: string;
  let constat: { regle: string; page: string | null; message: string };

  beforeAll(async () => {
    p = await startPaginity({ cerveaux: { 'local:qwen': cerveau } });
    let secret: string;
    ({ c, secret } = await setupOwner(p));
    id = (await c.call('POST', '/api/sites', { nom: 'Salon Correction', modele: 'vitrine' })).json.id;
    expect((await c.call('POST', '/api/confirmation', { motDePasse: 'une phrase de passe solide', code: totpCode(secret, 1) })).status).toBe(200);
    expect((await c.call('PUT', '/api/reglages/ia', { active: true, relaisExterne: 'jamais' })).status).toBe(200);
    // On retire la description de l'accueil : l'audit doit le voir.
    const f = (await c.call('GET', `/api/sites/${id}/fichier?chemin=public/index.html`)).json;
    await c.call('PUT', `/api/sites/${id}/fichier`, { chemin: 'public/index.html', contenu: f.contenu.replace(/<meta name="description"[^>]*>/, ''), version: f.version });
    const a = (await c.call('POST', `/api/sites/${id}/referencement/audit`, { cible: 'brouillon' })).json;
    constat = a.brouillon.constats.find((x: any) => x.regle === 'description-absente');
    expect(constat).toMatchObject({ page: '/', corrigeable: true });
    expect(a.brouillon.constats.find((x: any) => x.regle === 'sitemap-absent').corrigeable).toBe(false);
  }, 60_000);
  afterAll(async () => stopPaginity(p));

  it('refuse un constat inconnu ou non corrigeable sans inventer', async () => {
    expect((await c.call('POST', `/api/sites/${id}/referencement/corriger`, { ...constat, message: 'inventé' })).status).toBe(404);
    const a = (await c.call('GET', `/api/sites/${id}/referencement`)).json;
    const sitemap = a.brouillon.constats.find((x: any) => x.regle === 'sitemap-absent');
    expect((await c.call('POST', `/api/sites/${id}/referencement/corriger`, sitemap)).status).toBe(400);
  });

  it('une proposition qui ajoute un prix inventé ou un noindex est refusée par PAGINITY', async () => {
    comportement = (d) => fichier(html(d).replace('</head>', `${DESC}<meta name="robots" content="noindex"></head>`).replace('</main>', '<p>Pose gel 99 €</p></main>'));
    const r = (await c.call('POST', `/api/sites/${id}/referencement/corriger`, constat)).json;
    expect(r.statut).toBe('impossible');
    expect(JSON.stringify(r.journal)).toMatch(/noindex/);
    expect(JSON.stringify(r.journal)).toMatch(/prix absent du site et de la demande \(99\)/);
  });

  it('constat → proposition → accord → nouvel audit : le constat a disparu, rien n’est publié', async () => {
    comportement = (d) => fichier(html(d).replace('</head>', `${DESC}</head>`));
    const pr = (await c.call('POST', `/api/sites/${id}/referencement/corriger`, constat)).json;
    expect(pr, JSON.stringify(pr.journal)).toMatchObject({ statut: 'proposee', portee: 'pages', seo: { regle: 'description-absente', page: '/' } });
    const d = recu.at(-1)!;
    expect(d.demande).toContain('Constat : Pas de description');
    expect(d.demande).toContain('N’invente aucune information');
    const ok = (await c.call('POST', `/api/sites/${id}/assistant/${pr.id}/accepter`, { empreinte: pr.empreinte })).json;
    expect(ok.statut).toBe('acceptee');
    expect(ok.verificationSeo).toMatchObject({ corrige: true });
    expect(ok.verificationSeo.message).toMatch(/le constat a disparu/);
    const a = (await c.call('GET', `/api/sites/${id}/referencement`)).json;
    expect(a.brouillon.constats.some((x: any) => x.regle === 'description-absente')).toBe(false);
    expect(a.brouillon.corriges.map((x: any) => x.regle)).toContain('description-absente');
    expect(p.ctx.sites.get(id)!.live_publication).toBeNull(); // jamais publié automatiquement
  });
});
