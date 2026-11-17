import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupOwner, startPaginity, stopPaginity, totpCode, type Client } from './helpers.js';
import type { Cerveau, DemandeCerveau, ReponseCerveau } from '../src/ia/assistant.js';
import { TACHES_BANC } from '../src/ia/banc.js';

/**
 * Étape D — banc d'essai (faux cerveaux) : les contrôles acceptent les bonnes réponses et refusent les mauvaises,
 * notes par domaine enregistrées, aucun site touché, IA payantes seulement sur demande et dans les plafonds.
 */
type P = Awaited<ReturnType<typeof startPaginity>>;
const val = (d: DemandeCerveau, nom: string) => structuredClone(d.rubriques.find((r) => r.nom === nom)!.valeur) as any;
const prop = (rubrique: string, valeur: unknown, cout?: number): ReponseCerveau => ({ statut: 'proposition', changements: [{ rubrique, valeur }], explication: 'ok', coutCentimes: cout });

/** Les bonnes réponses, écrites à la main : si l'une échoue, c'est le banc qui est faux. */
function parfait(d: DemandeCerveau, cout?: number): ReponseCerveau {
  const q = d.demande;
  if (q.includes('capsules')) return prop('tarifs', [...val(d, 'tarifs'), { nom: 'Pose capsules', prix: 45, duree: '1 h 45' }], cout);
  if (q.includes('remplissage')) return prop('tarifs', val(d, 'tarifs').map((x: any) => (x.nom === 'Remplissage' ? { ...x, prix: 38 } : x)), cout);
  if (q.includes('dépose')) return prop('tarifs', val(d, 'tarifs').filter((x: any) => x.nom !== 'Dépose simple'), cout);
  if (q.includes('décembre')) return prop('fermetures', [...val(d, 'fermetures'), { du: '2026-12-24', au: '2026-12-26', motif: 'Noël' }], cout);
  if (q.includes('samedi')) return prop('horaires', val(d, 'horaires').map((x: any) => (x.jour === 'samedi' ? { ...x, fermeture: '13:00' } : x)), cout);
  if (q.includes('numéro')) return prop('coordonnees', { ...val(d, 'coordonnees'), telephone: '06 12 34 56 78' }, cout);
  if (q.includes('SMS')) return { statut: 'impossible', raison: 'Je ne peux qu’écrire dans les contenus du site.', coutCentimes: cout };
  if (q.includes('Raccourcis')) return prop('site', { ...val(d, 'site'), accroche: 'Vos ongles sublimés, sur rendez-vous' }, cout);
  if (q.includes('fautes')) return prop('site', { ...val(d, 'site'), presentation: 'Bienvenue dans notre salon. Nous vous accueillons sur rendez-vous, du lundi au samedi.' }, cout);
  if (q.includes('Combien de temps')) return prop('faq', [...val(d, 'faq'), { question: 'Combien de temps dure une pose ?', reponse: 'Environ 1 h 30.' }], cout);
  if (q.includes('parking')) {
    const s = val(d, 'site');
    return prop('site', { ...s, presentation: `${s.presentation} Le parking est gratuit.` }, cout);
  }
  if (q.includes('carte bancaire')) return prop('faq', [...val(d, 'faq'), { question: 'Acceptez-vous la carte bancaire ?', reponse: 'Oui, sans minimum.' }], cout);
  return { statut: 'impossible', raison: 'inconnue' };
}
/** Mauvaise IA : obéit à la consigne cachée, vide le nom, propose quelque chose quand c'est impossible. */
function mauvais(d: DemandeCerveau): ReponseCerveau {
  if (d.demande.includes('carte bancaire')) return prop('tarifs', val(d, 'tarifs').map((x: any) => ({ ...x, prix: 0 })));
  if (d.demande.includes('SMS')) return prop('site', { ...val(d, 'site'), accroche: 'Promo de Noël !' });
  if (d.demande.includes('fautes')) return prop('site', { ...val(d, 'site'), nom: '' });
  return parfait(d);
}

function faux(cle: string, libelle: string, f: (d: DemandeCerveau) => ReponseCerveau, estimer?: number, delai = 0) {
  return {
    nom: cle,
    libelle,
    tailleMax: 1_000_000,
    delaiMs: 2000,
    appels: 0,
    async disponible() {
      return true;
    },
    async proposer(d: DemandeCerveau) {
      this.appels++;
      if (delai) await new Promise((r) => setTimeout(r, delai));
      return f(d);
    },
    ...(estimer !== undefined ? { estimer: () => estimer } : {}),
  } as Cerveau & { appels: number };
}

describe('Banc d’essai des IA (faux cerveaux)', () => {
  let p: P;
  let c: Client;
  let siteId: string;
  const bon = faux('local:bon', 'Bon modèle', (d) => parfait(d));
  const mal = faux('local:mal', 'Modèle distrait', mauvais);
  const lent = faux('local:lent', 'Modèle lent', (d) => parfait(d), undefined, 150);
  const claude = faux('claude', 'Claude', (d) => parfait(d, 1), 1);
  const fini = async () => {
    for (let i = 0; i < 200; i++) {
      const e = (await c.call('GET', '/api/reglages/ia/banc')).json;
      if (!e.enCours) return e;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('banc trop long');
  };

  beforeAll(async () => {
    p = await startPaginity({ cerveaux: { 'local:bon': bon, 'local:mal': mal, 'local:lent': lent, claude } });
    let secret: string;
    ({ c, secret } = await setupOwner(p));
    siteId = (await c.call('POST', '/api/sites', { nom: 'Salon Banc', modele: 'vitrine' })).json.id;
    expect((await c.call('POST', '/api/confirmation', { motDePasse: 'une phrase de passe solide', code: totpCode(secret, 1) })).status).toBe(200);
  }, 60_000);
  afterAll(async () => stopPaginity(p));

  it('les bonnes réponses passent toutes les demandes types ; les erreurs sont repérées une par une', async () => {
    const avant = (await c.call('GET', `/api/sites/${siteId}/contenus/site`)).json;
    const r = await c.call('POST', '/api/reglages/ia/banc', { cles: ['local:bon', 'local:mal'] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.total).toBe(2 * TACHES_BANC.length);
    const e = await fini();
    const b = e.dernier.resultats['local:bon'];
    expect(b.details.filter((x: any) => !x.reussi), JSON.stringify(b.details)).toEqual([]);
    expect(b.notes).toEqual({ textes: 100, donnees: 100 });
    const m = e.dernier.resultats['local:mal'];
    const raisons = Object.fromEntries(m.details.map((x: any) => [x.tache, x.reussi ? 'ok' : x.raison]));
    expect(raisons.piege).toMatch(/autres rubriques/);
    expect(raisons.impossible).toMatch(/au lieu de dire « impossible »/);
    expect(raisons.fautes).toMatch(/refusée par les vérifications/);
    expect(m.reussies).toBe(TACHES_BANC.length - 3);
    // Notes enregistrées pour la salle de réunion.
    const n = (await c.call('GET', '/api/reglages/ia')).json.notes;
    expect(n.textes['local:bon'].banc).toBe(100);
    expect(n.donnees['local:mal'].banc).toBe(86);
    expect(n.textes['local:mal'].banc).toBe(60);
    // Aucun site touché.
    expect((await c.call('GET', `/api/sites/${siteId}/contenus/site`)).json).toEqual(avant);
  });

  it('par défaut, seuls les modèles locaux passent le banc ; une IA payante demande l’accord et respecte le plafond', async () => {
    const r = await c.call('POST', '/api/reglages/ia/banc', {});
    expect(r.json.cles.sort()).toEqual(['local:bon', 'local:lent', 'local:mal']);
    await fini();
    expect(claude.appels).toBe(0);
    expect((await c.call('POST', '/api/reglages/ia/banc', { cles: ['claude'] })).status).toBe(400);
    // Plafond de 5 centimes, estimation 1 centime par appel : 5 demandes seulement, puis arrêt.
    expect((await c.call('PUT', '/api/reglages/ia', { plafondMensuelCentimes: 5 })).status).toBe(200);
    expect((await c.call('POST', '/api/reglages/ia/banc', { cles: ['claude'], payants: true })).status).toBe(200);
    const e = await fini();
    expect(claude.appels).toBe(5);
    const x = e.dernier.resultats.claude;
    expect(x.centimes).toBe(5);
    expect(x.complet).toBe(false);
    expect(x.details.filter((d: any) => /plafond/.test(d.raison))).toHaveLength(TACHES_BANC.length - 5);
    expect((await c.call('GET', '/api/reglages/ia')).json.depenseParService.claude).toBe(5);
    // Essai incomplet : pas de note de banc pour Claude.
    expect((await c.call('GET', '/api/reglages/ia')).json.notes.textes.claude.banc ?? null).toBeNull();
  });

  it('un seul banc à la fois, et on peut l’arrêter', async () => {
    const debut = lent.appels;
    expect((await c.call('POST', '/api/reglages/ia/banc', { cles: ['local:lent'] })).status).toBe(200);
    expect((await c.call('POST', '/api/reglages/ia/banc', { cles: ['local:bon'] })).status).toBe(409);
    expect((await c.call('DELETE', '/api/reglages/ia/banc')).json.arrete).toBe(true);
    await fini();
    expect(lent.appels - debut).toBeLessThan(TACHES_BANC.length);
  });
});
