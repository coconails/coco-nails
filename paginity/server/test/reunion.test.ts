import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupOwner, startPaginity, stopPaginity, totpCode, type Client } from './helpers.js';
import { domaineDe, type Cerveau, type DemandeCerveau, type ReponseCerveau } from '../src/ia/assistant.js';
import { messageUtilisateur } from '../src/ia/fournisseurs.js';

/**
 * Étape C — salle de réunion (faux cerveaux) : un tour par IA, le plus fort du domaine vérifie en dernier,
 * repli sur la meilleure proposition valable, IA payantes seulement en relais automatique et dans les plafonds,
 * notes qui évoluent avec vos décisions.
 */
type P = Awaited<ReturnType<typeof startPaginity>>;
type Comportement = (d: DemandeCerveau) => ReponseCerveau;

function faux(cle: string, libelle: string) {
  const recu: DemandeCerveau[] = [];
  const c = {
    nom: cle,
    libelle,
    tailleMax: 1_000_000,
    delaiMs: 500,
    recu,
    comportement: ((_d) => ({ statut: 'impossible', raison: 'non réglé' })) as Comportement,
    async disponible() {
      return true;
    },
    async proposer(d: DemandeCerveau) {
      recu.push(d);
      return c.comportement(d);
    },
  };
  return c as typeof c & Cerveau;
}
const accroche = (texte: string, cout?: number): Comportement => (d) => {
  const site = d.rubriques.find((r) => r.nom === 'site')!.valeur as object;
  return { statut: 'proposition', changements: [{ rubrique: 'site', valeur: { ...site, accroche: texte } }], explication: `Accroche : ${texte}`, coutCentimes: cout };
};
const invalide: Comportement = (d) => {
  const site = d.rubriques.find((r) => r.nom === 'site')!.valeur as object;
  return { statut: 'proposition', changements: [{ rubrique: 'site', valeur: { ...site, nom: '' } }], explication: 'nom vidé' };
};
const impossible: Comportement = () => ({ statut: 'impossible', raison: 'je ne sais pas' });

describe('Salle de réunion des IA (faux cerveaux)', () => {
  let p: P;
  let c: Client;
  let siteId: string;
  const glm = faux('local:glm', 'GLM');
  const qwen = faux('local:qwen', 'Qwen3-Coder');
  const kimi = faux('local:kimi', 'Kimi');
  const claude = faux('claude', 'Claude');
  const tous = [glm, qwen, kimi, claude];
  const reglages = (r: Record<string, unknown>) => c.call('PUT', '/api/reglages/ia', r);
  const demander = (demande: string, extra: Record<string, unknown> = {}) => c.call('POST', `/api/sites/${siteId}/assistant`, { demande, ...extra });

  beforeAll(async () => {
    p = await startPaginity({ cerveaux: { 'local:glm': glm, 'local:qwen': qwen, 'local:kimi': kimi, claude } });
    let secret: string;
    ({ c, secret } = await setupOwner(p));
    expect((await c.call('POST', '/api/confirmation', { motDePasse: 'une phrase de passe solide', code: totpCode(secret, 1) })).status).toBe(200);
    siteId = (await c.call('POST', '/api/sites', { nom: 'Salon Réunion', modele: 'vitrine' })).json.id;
    expect((await reglages({ active: true, relaisExterne: 'jamais', reunion: { active: true, maxParticipants: 3 } })).status).toBe(200);
  }, 60_000);
  afterAll(async () => stopPaginity(p));
  beforeEach(() => {
    for (const x of tous) x.recu.length = 0;
  });

  it('classe la demande par domaine (données ou textes)', () => {
    expect(domaineDe('Mets la pose gel à 45 €')).toBe('donnees');
    expect(domaineDe('Nous sommes fermés le lundi')).toBe('donnees');
    expect(domaineDe('Rends l’accroche plus chaleureuse')).toBe('textes');
  });

  it('un tour par IA ; sans notes, le premier de la liste vérifie en dernier et voit les propositions, anonymes', async () => {
    glm.comportement = accroche('Version finale du vérificateur');
    qwen.comportement = accroche('Une autre accroche');
    kimi.comportement = invalide;
    const r = await demander('Rends l’accroche plus chaleureuse');
    expect(r.json, JSON.stringify(r.json.journal)).toMatchObject({ statut: 'proposee', cerveau: 'local:glm' });
    expect(r.json.changements[0].apres.accroche).toBe('Version finale du vérificateur');
    // Chaque IA n'a parlé qu'une fois ; Claude (payant) n'a pas participé (relais « jamais »).
    expect([glm.recu.length, qwen.recu.length, kimi.recu.length, claude.recu.length]).toEqual([1, 1, 1, 0]);
    // Le vérificateur a reçu les propositions des autres, sans leur nom, avec les remarques de PAGINITY.
    const vues = glm.recu[0].propositionsAutres!;
    expect(vues.map((v) => v.auteur)).toEqual(['Proposition A', 'Proposition B']);
    expect(JSON.stringify(vues)).not.toMatch(/Qwen|Kimi|GLM/);
    expect(vues.find((v) => !v.valide)!.remarques.join(' ')).toMatch(/obligatoire/);
    expect(qwen.recu[0].propositionsAutres).toBeUndefined(); // les proposants travaillent seuls
    expect(messageUtilisateur(glm.recu[0])).toMatch(/VÉRIFICATEUR FINAL/);
    expect(r.json.reunion).toMatchObject({ domaine: 'textes', verificateur: 'GLM', choixVerificateur: expect.stringMatching(/premier de la liste/) });
    expect(r.json.reunion.participants.map((x: any) => [x.libelle, x.statut])).toEqual([
      ['Qwen3-Coder', 'valable'],
      ['Kimi', 'refusée par les vérifications'],
    ]);
  });

  it('le plus fort du domaine (notes du banc d’essai) vérifie en dernier ; le domaine peut être imposé', async () => {
    p.ctx.ia.noterBanc('local:kimi', 'donnees', 92);
    p.ctx.ia.noterBanc('local:glm', 'donnees', 60);
    p.ctx.ia.noterBanc('local:qwen', 'textes', 88);
    p.ctx.ia.noterBanc('local:glm', 'textes', 40);
    for (const x of [glm, qwen, kimi]) x.comportement = accroche(`par ${x.libelle}`);
    const d = await demander('Mets la pose gel à 45 €');
    expect(d.json.reunion).toMatchObject({ domaine: 'donnees', verificateur: 'Kimi', choixVerificateur: 'meilleure note dans ce domaine (92/100)' });
    expect(d.json.cerveau).toBe('local:kimi');
    const t = await demander('Accroche plus douce');
    expect(t.json.reunion).toMatchObject({ domaine: 'textes', verificateur: 'Qwen3-Coder' });
    // Domaine imposé par la personne : « textes » malgré les chiffres.
    const f = await demander('Écris 3 phrases d’accroche', { domaine: 'textes' });
    expect(f.json.reunion).toMatchObject({ domaine: 'textes', choixDomaine: 'vous', verificateur: 'Qwen3-Coder' });
  });

  it('vérificateur désigné dans les réglages pour un domaine', async () => {
    expect((await reglages({ reunion: { verificateurs: { textes: 'local:glm' } } })).status).toBe(200);
    const r = await demander('Accroche plus douce');
    expect(r.json.reunion).toMatchObject({ verificateur: 'GLM', choixVerificateur: 'désigné dans les réglages' });
    await reglages({ reunion: { verificateurs: { textes: 'auto' } } });
  });

  it('si le vérificateur échoue, la meilleure proposition valable des autres est retenue', async () => {
    qwen.comportement = invalide; // vérificateur « textes » (88)
    glm.comportement = accroche('Proposition valable de GLM');
    kimi.comportement = impossible;
    const r = await demander('Accroche plus douce');
    expect(r.json, JSON.stringify(r.json.journal)).toMatchObject({ statut: 'proposee', cerveau: 'local:glm' });
    expect(r.json.journal.map((j: any) => j.texte).join(' ')).toMatch(/Le vérificateur final n’a pas abouti : la proposition .* \(GLM\), valable, est retenue/);
    expect(r.json.reunion.statutVerificateur).toMatch(/refusée par les vérifications/);
  });

  it('aucune proposition valable : rien n’est modifié, et les IA payantes restent hors de la réunion sans relais automatique', async () => {
    for (const x of [glm, qwen, kimi]) x.comportement = impossible;
    const r = await demander('Accroche plus douce');
    expect(r.json.statut).toBe('impossible');
    expect(r.json.raison).toMatch(/la réunion n’a produit aucune proposition valable/i);
    expect(claude.recu).toHaveLength(0);
  });

  it('relais automatique : l’IA payante rejoint la réunion comme proposante, dans les plafonds, et n’est vérificateur que si autorisé', async () => {
    await reglages({ relaisExterne: 'auto', plafondMensuelCentimes: 500 });
    p.ctx.ia.noterBanc('claude', 'textes', 99);
    claude.comportement = accroche('Proposition de Claude', 30);
    qwen.comportement = accroche('Finale de Qwen');
    glm.comportement = impossible;
    kimi.comportement = impossible;
    const r = await demander('Accroche plus douce');
    expect(r.json.reunion.verificateur).toBe('Qwen3-Coder'); // payant non autorisé comme vérificateur
    expect(r.json.reunion.participants.map((x: any) => x.libelle)).toContain('Claude');
    expect(r.json.coutCentimes).toBe(30);
    // Autorisé : Claude (meilleure note) devient le vérificateur final.
    await reglages({ reunion: { payantVerificateur: true } });
    claude.comportement = accroche('Finale de Claude', 40);
    const r2 = await demander('Accroche plus douce');
    expect(r2.json.reunion.verificateur).toBe('Claude');
    expect(r2.json.cerveau).toBe('claude');
    // Plafond atteint : Claude n'est plus sollicité du tout.
    await reglages({ plafondMensuelCentimes: 70 });
    claude.recu.length = 0;
    const r3 = await demander('Accroche plus douce');
    expect(claude.recu).toHaveLength(0);
    expect(r3.json.reunion.verificateur).toBe('Qwen3-Coder');
    await reglages({ relaisExterne: 'jamais', reunion: { payantVerificateur: false } });
  });

  it('vos décisions font évoluer les notes (à partir de 5 décisions)', async () => {
    for (const x of [glm, qwen, kimi]) x.comportement = accroche(`${x.libelle} ${Math.random()}`);
    const avant = (await c.call('GET', '/api/reglages/ia')).json.notes.textes['local:qwen'];
    for (let i = 0; i < 5; i++) {
      const r = await demander('Accroche plus douce');
      expect(r.json.cerveau).toBe('local:qwen');
      await c.call('POST', `/api/sites/${siteId}/assistant/${r.json.id}/refuser`, {});
    }
    const apres = (await c.call('GET', '/api/reglages/ia')).json.notes.textes['local:qwen'];
    expect(apres.refuses).toBe(avant.refuses + 5);
    expect(apres.note).toBe(Math.round(0.7 * 88)); // 0,7 × banc (88) + 0,3 × 0 % d'acceptation
    expect(apres.note).toBeLessThan(avant.note);
  });

  it('réunion désactivée : retour au fonctionnement simple (modèles locaux dans l’ordre)', async () => {
    await reglages({ reunion: { active: false } });
    glm.comportement = accroche('GLM seul');
    const r = await demander('Accroche plus douce');
    expect(r.json).toMatchObject({ statut: 'proposee', cerveau: 'local:glm' });
    expect(qwen.recu).toHaveLength(0);
  });
});
