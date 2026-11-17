import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupOwner, startPaginity, stopPaginity, totpCode, type Client } from './helpers.js';
import type { Cerveau, DemandeCerveau, ReponseCerveau } from '../src/ia/assistant.js';
import { lireReponse } from '../src/ia/fournisseurs.js';
import { TACHES_BANC } from '../src/ia/banc.js';

/**
 * Assistant, améliorations : question de précision (puis la demande repart complétée), annulation d'une proposition
 * acceptée (seulement si personne n'a touché la rubrique depuis), banc d'essai qui apprend des demandes acceptées.
 */
type P = Awaited<ReturnType<typeof startPaginity>>;
let comportement: (d: DemandeCerveau) => ReponseCerveau = () => ({ statut: 'impossible', raison: 'non réglé' });
const recu: DemandeCerveau[] = [];
const cerveau: Cerveau = {
  nom: 'local:qwen',
  libelle: 'Qwen3',
  tailleMax: 1_000_000,
  delaiMs: 1000,
  async disponible() {
    return true;
  },
  async proposer(d) {
    recu.push(d);
    return comportement(d);
  },
};
const accroche = (texte: string) => (d: DemandeCerveau): ReponseCerveau => {
  const site = d.rubriques.find((r) => r.nom === 'site')!.valeur as object;
  return { statut: 'proposition', changements: [{ rubrique: 'site', valeur: { ...site, accroche: texte } }], explication: 'ok' };
};

describe('Assistant : précision, annulation, banc appris', () => {
  let p: P;
  let c: Client;
  let siteId: string;
  const url = (x = '') => `/api/sites/${siteId}/assistant${x}`;
  const lireSite = async () => (await c.call('GET', `/api/sites/${siteId}/contenus/site`)).json.valeur;

  beforeAll(async () => {
    p = await startPaginity({ cerveaux: { 'local:qwen': cerveau } });
    let secret: string;
    ({ c, secret } = await setupOwner(p));
    siteId = (await c.call('POST', '/api/sites', { nom: 'Salon Plus', modele: 'vitrine' })).json.id;
    expect((await c.call('POST', '/api/confirmation', { motDePasse: 'une phrase de passe solide', code: totpCode(secret, 1) })).status).toBe(200);
    expect((await c.call('PUT', '/api/reglages/ia', { active: true, relaisExterne: 'jamais' })).status).toBe(200);
  }, 60_000);
  afterAll(async () => stopPaginity(p));

  it('lit le statut « question » renvoyé par un vrai modèle', () => {
    expect(lireReponse('{"statut":"question","changements":[],"explication":"","raison":"Quel prix pour la pose gel ?"}', 0)).toEqual({ statut: 'question', question: 'Quel prix pour la pose gel ?', coutCentimes: 0 });
    expect(() => lireReponse('{"statut":"question","changements":[],"explication":"","raison":""}', 0)).toThrow();
  });

  it('l’IA pose une question ; la réponse complète la demande, qui repart', async () => {
    comportement = () => ({ statut: 'question', question: 'Quel texte voulez-vous pour l’accroche ?' });
    const q = await c.call('POST', url(), { demande: 'Change l’accroche' });
    expect(q.json).toMatchObject({ statut: 'question', raison: 'Quel texte voulez-vous pour l’accroche ?' });
    expect((await c.call('POST', url(`/${q.json.id}/repondre`), { reponse: '' })).status).toBe(400);
    comportement = accroche('Ongles soignés, sur rendez-vous');
    const r = await c.call('POST', url(`/${q.json.id}/repondre`), { reponse: 'Ongles soignés, sur rendez-vous' });
    expect(r.json, JSON.stringify(r.json)).toMatchObject({ statut: 'proposee' });
    expect(r.json.demande).toContain('Précision demandée : Quel texte voulez-vous pour l’accroche ?\nRéponse : Ongles soignés, sur rendez-vous');
    expect(recu.at(-1)!.demande).toContain('Réponse : Ongles soignés');
    const ancienne = (await c.call('GET', url())).json.propositions.find((x: any) => x.id === q.json.id);
    expect(ancienne.statut).toBe('repondue');
    expect((await c.call('POST', url(`/${q.json.id}/repondre`), { reponse: 'encore' })).status).toBe(409);
    expect((await c.call('POST', url(`/${r.json.id}/accepter`), { empreinte: r.json.empreinte })).json.statut).toBe('acceptee');
  });

  it('annule une proposition acceptée (le brouillon revient comme avant)', async () => {
    const avant = await lireSite();
    comportement = accroche('Version à annuler');
    const pr = (await c.call('POST', url(), { demande: 'Mets « Version à annuler » en accroche' })).json;
    const ok = await c.call('POST', url(`/${pr.id}/accepter`), { empreinte: pr.empreinte });
    expect(ok.json).toMatchObject({ statut: 'acceptee', annulable: true });
    expect((await lireSite()).accroche).toBe('Version à annuler');
    const an = await c.call('POST', url(`/${pr.id}/annuler`));
    expect(an.json, JSON.stringify(an.json)).toMatchObject({ statut: 'annulee', annulable: false });
    expect(await lireSite()).toEqual(avant);
    expect((await c.call('POST', url(`/${pr.id}/annuler`))).status).toBe(409);
  });

  it('refuse d’annuler si la rubrique a été modifiée depuis (rien n’est écrasé)', async () => {
    comportement = accroche('Acceptée puis retouchée');
    const pr = (await c.call('POST', url(), { demande: 'Autre accroche' })).json;
    await c.call('POST', url(`/${pr.id}/accepter`), { empreinte: pr.empreinte });
    const e = (await c.call('GET', `/api/sites/${siteId}/contenus/site`)).json;
    expect((await c.call('PUT', `/api/sites/${siteId}/contenus/site`, { valeur: { ...e.valeur, accroche: 'Retouchée à la main' }, version: e.version })).status).toBe(200);
    const an = await c.call('POST', url(`/${pr.id}/annuler`));
    expect(an.status).toBe(409);
    expect(an.json.erreur).toMatch(/a été modifié depuis/);
    expect((await lireSite()).accroche).toBe('Retouchée à la main');
  });

  it('le banc d’essai apprend des demandes acceptées (et les oublie sur demande)', async () => {
    const e = (await c.call('GET', '/api/reglages/ia/banc')).json;
    // Acceptées et non annulées : « Change l’accroche » (après réponse) et « Autre accroche ».
    expect(e.reelles).toBe(2);
    expect(e.taches.filter((t: any) => t.reelle).map((t: any) => t.titre)).toEqual([expect.stringContaining('Change l’accroche'), 'Votre demande : « Autre accroche »']);
    // Le modèle répond juste aux demandes réelles seulement si les données sont celles acceptées.
    comportement = (d) => (d.demande === 'Autre accroche' ? accroche('Acceptée puis retouchée')(d) : d.demande.startsWith('Change') ? accroche('Autre chose')(d) : { statut: 'impossible', raison: 'x' });
    expect((await c.call('POST', '/api/reglages/ia/banc', { cles: ['local:qwen'] })).json.total).toBe(TACHES_BANC.length + 2);
    let fin;
    for (let i = 0; i < 100 && !(fin = (await c.call('GET', '/api/reglages/ia/banc')).json).dernier; i++) await new Promise((r) => setTimeout(r, 20));
    while ((fin = (await c.call('GET', '/api/reglages/ia/banc')).json).enCours) await new Promise((r) => setTimeout(r, 20));
    const d = fin.dernier.resultats['local:qwen'].details.filter((x: any) => x.tache.startsWith('reel:'));
    expect(d.map((x: any) => x.reussi)).toEqual([false, true]);
    expect(d[0].raison).toMatch(/valeur différente de celle acceptée \(accroche\)/);
    expect((await c.call('DELETE', '/api/reglages/ia/banc/reelles')).json.reelles).toBe(0);
  });
});
