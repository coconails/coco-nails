import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { client, getSite, setupOwner, startPaginity, stopPaginity, totpCode, waitJob, type Client } from './helpers.js';
import type { Cerveau, DemandeCerveau, ReponseCerveau } from '../src/ia/assistant.js';

/**
 * PAGINITY AI, étape 1 : cœur de l'agent et aiguilleur, avec deux FAUX cerveaux (aucune IA réelle, aucun appel extérieur).
 * On prouve : rien n'est écrit sans accord, vérifications identiques aux formulaires, relais vers Claude décidé par des
 * règles (et non par le modèle), accord humain, plafond de dépense, arrêt d'urgence, cloisonnement des données.
 */
type P = Awaited<ReturnType<typeof startPaginity>>;

/** Faux cerveau : son comportement se règle dans chaque test ; il garde tout ce qu'il a reçu. */
function fauxCerveau(nom: 'local' | 'claude') {
  const recu: DemandeCerveau[] = [];
  const c = {
    nom,
    tailleMax: 1_000_000,
    delaiMs: 500,
    dispo: true,
    comportement: (_d: DemandeCerveau): ReponseCerveau | Promise<ReponseCerveau> => ({ statut: 'impossible', raison: 'non réglé' }),
    recu,
    async disponible() {
      return c.dispo;
    },
    async proposer(d: DemandeCerveau) {
      recu.push(d);
      return c.comportement(d);
    },
  };
  return c as typeof c & Cerveau;
}

/** Proposition type : changer l'accroche de la rubrique « site ». */
const accroche = (texte: string, cout?: number) => (d: DemandeCerveau): ReponseCerveau => {
  const site = d.rubriques.find((r) => r.nom === 'site')!;
  return { statut: 'proposition', changements: [{ rubrique: 'site', valeur: { ...(site.valeur as object), accroche: texte } }], explication: 'Accroche modifiée.', coutCentimes: cout };
};

describe('PAGINITY AI — assistant contenus (faux cerveaux)', () => {
  let p: P;
  let c: Client;
  let siteId: string;
  let slug: string;
  let autreSite: string;
  const local = fauxCerveau('local');
  const claude = fauxCerveau('claude');
  const lireFichier = () => JSON.parse(fs.readFileSync(path.join(p.ctx.sites.repoDir(p.ctx.sites.get(siteId)!), 'public/contenu/site.json'), 'utf8'));
  const reglages = (r: Record<string, unknown>) => c.call('PUT', '/api/reglages/ia', r);
  const demander = (demande: string, extra: Record<string, unknown> = {}, qui: Client = c) => qui.call('POST', `/api/sites/${siteId}/assistant`, { demande, ...extra });

  beforeAll(async () => {
    p = await startPaginity({ cerveaux: { local, claude } });
    let secret: string;
    ({ c, secret } = await setupOwner(p));
    expect((await c.call('POST', '/api/confirmation', { motDePasse: 'une phrase de passe solide', code: totpCode(secret, 1) })).status).toBe(200);
    const s = await c.call('POST', '/api/sites', { nom: 'Salon IA', modele: 'vitrine' });
    siteId = s.json.id;
    slug = s.json.slug;
    expect((await waitJob(p, (await c.call('POST', `/api/sites/${siteId}/publier`, {})).json.id)).etat).toBe('reussie');
    // Données qui ne doivent JAMAIS partir vers un cerveau.
    expect((await c.call('PUT', `/api/sites/${siteId}/secrets/production/CLE_API`, { valeur: 'cle-secrete-ne-pas-envoyer' })).status).toBe(200);
    p.ctx.db.prepare('INSERT INTO form_submissions (id, site_id, form, at, data_enc) VALUES (?, ?, ?, ?, ?)').run('f1', siteId, 'contact', Date.now(), p.ctx.vault.encrypt('{"nom":"Cliente Confidentielle"}'));
    autreSite = (await c.call('POST', '/api/sites', { nom: 'Autre Salon', modele: 'vitrine' })).json.id;
    const e = await c.call('GET', `/api/sites/${autreSite}/contenus/site`);
    await c.call('PUT', `/api/sites/${autreSite}/contenus/site`, { valeur: { ...e.json.valeur, accroche: 'Texte privé de l’autre salon' }, version: e.json.version });
  }, 60_000);
  afterAll(async () => stopPaginity(p));
  beforeEach(() => {
    local.recu.length = 0;
    claude.recu.length = 0;
    local.dispo = true;
    local.tailleMax = 1_000_000;
    local.delaiMs = 500;
  });

  it('est désactivé par défaut ; seul le propriétaire, identité confirmée, peut l’activer', async () => {
    expect((await demander('Change l’accroche')).status).toBe(409);
    expect((await c.call('GET', '/api/reglages/ia')).json.reglages).toEqual({ active: false, relaisClaude: 'demander', plafondMensuelCentimes: 0 });
    expect((await reglages({ active: true })).status).toBe(200);
  });

  it('le modèle local propose ; rien n’est écrit avant l’accord, puis seulement dans le brouillon', async () => {
    local.comportement = accroche('Le soin de vos mains, près de chez vous');
    const avant = fs.readFileSync(path.join(p.ctx.sites.repoDir(p.ctx.sites.get(siteId)!), 'public/contenu/site.json'), 'utf8');
    const headAvant = await p.ctx.sites.repo(p.ctx.sites.get(siteId)!).head();
    const r = await demander('Change l’accroche');
    expect(r.status, r.body).toBe(200);
    expect(r.json).toMatchObject({ statut: 'proposee', cerveau: 'local', coutCentimes: 0 });
    expect(r.json.changements[0].apres.accroche).toBe('Le soin de vos mains, près de chez vous');
    expect(r.json.changements[0].avant.accroche).not.toBe('Le soin de vos mains, près de chez vous');
    // Rien d'écrit pour l'instant.
    expect(fs.readFileSync(path.join(p.ctx.sites.repoDir(p.ctx.sites.get(siteId)!), 'public/contenu/site.json'), 'utf8')).toBe(avant);
    expect(await p.ctx.sites.repo(p.ctx.sites.get(siteId)!).head()).toBe(headAvant);
    // Un accord qui ne correspond pas à la proposition affichée est refusé.
    expect((await c.call('POST', `/api/sites/${siteId}/assistant/${r.json.id}/accepter`, { empreinte: 'autre' })).status).toBe(409);
    const ok = await c.call('POST', `/api/sites/${siteId}/assistant/${r.json.id}/accepter`, { empreinte: r.json.empreinte });
    expect(ok.status, ok.body).toBe(200);
    expect(ok.json.statut).toBe('acceptee');
    expect(lireFichier().accroche).toBe('Le soin de vos mains, près de chez vous');
    // Pas publié : le site en ligne n'a pas changé.
    expect((await getSite(p, `${slug}.localhost`)).body).not.toContain('Le soin de vos mains, près de chez vous');
    // Une seconde acceptation est impossible.
    expect((await c.call('POST', `/api/sites/${siteId}/assistant/${r.json.id}/accepter`, { empreinte: r.json.empreinte })).status).toBe(409);
  });

  it('le cerveau ne reçoit que les contenus publics de ce site : ni secret, ni message, ni autre site, ni code serveur', async () => {
    local.comportement = accroche('Encore une accroche');
    await demander('Change l’accroche');
    const tout = JSON.stringify(local.recu);
    expect(local.recu).toHaveLength(1);
    expect(tout).not.toContain('cle-secrete-ne-pas-envoyer');
    expect(tout).not.toContain('Cliente Confidentielle');
    expect(tout).not.toContain('Texte privé de l’autre salon');
    expect(local.recu[0].rubriques.map((r) => r.nom).sort()).toEqual(['faq', 'horaires', 'prestations', 'site']);
  });

  it('une proposition invalide est refusée par les mêmes règles que les formulaires, avec un 2ᵉ essai corrigé', async () => {
    let essai = 0;
    local.comportement = (d) => {
      essai++;
      const site = d.rubriques.find((r) => r.nom === 'site')!.valeur as Record<string, unknown>;
      if (essai === 1) return { statut: 'proposition', changements: [{ rubrique: 'site', valeur: { ...site, nom: '', telephone: 'appelez-moi' } }], explication: 'raté' };
      expect(d.corrections?.join(' ')).toMatch(/obligatoire/);
      return { statut: 'proposition', changements: [{ rubrique: 'site', valeur: { ...site, telephone: '02 43 00 00 00' } }], explication: 'Téléphone corrigé.' };
    };
    const r = await demander('Mets le téléphone 02 43 00 00 00');
    expect(r.json.statut, JSON.stringify(r.json.journal)).toBe('proposee');
    expect(essai).toBe(2);
    expect(r.json.journal.map((j: any) => j.texte).join(' ')).toMatch(/essai 1 : proposition refusée/);
    expect(claude.recu).toHaveLength(0);
  });

  it('le cerveau ne peut viser qu’une rubrique de contenu proposée : tout le reste est refusé', async () => {
    local.comportement = () => ({ statut: 'proposition', changements: [{ rubrique: 'netlify/functions/piege', valeur: 'export default 1' }], explication: 'piège' });
    await reglages({ relaisClaude: 'jamais' });
    const r = await demander('Fais quelque chose');
    expect(r.json.statut).toBe('impossible');
    expect(r.json.journal.map((j: any) => j.texte).join(' ')).toMatch(/rubrique inconnue/);
    expect(fs.existsSync(path.join(p.ctx.sites.repoDir(p.ctx.sites.get(siteId)!), 'netlify/functions/piege'))).toBe(false);
  });

  it('relais vers Claude : décidé par les règles, sur accord par défaut, et bloqué par le plafond de 0 €', async () => {
    await reglages({ relaisClaude: 'demander', plafondMensuelCentimes: 0 });
    local.comportement = () => ({ statut: 'impossible', raison: 'trop compliqué pour moi' });
    claude.comportement = accroche('Accroche par Claude', 40);
    const r = await demander('Réécris l’accroche avec élégance');
    expect(r.json.statut, r.json.raison).toBe('impossible');
    expect(r.json.raison).toMatch(/plafond mensuel/);
    expect(claude.recu).toHaveLength(0);
    // Plafond fixé : il faut encore l'accord d'une personne (rôle Éditeur ou plus).
    await reglages({ plafondMensuelCentimes: 100 });
    const r2 = await demander('Réécris l’accroche avec élégance');
    expect(r2.json.statut).toBe('accord_requis');
    expect(claude.recu).toHaveLength(0);
    const ok = await c.call('POST', `/api/sites/${siteId}/assistant/${r2.json.id}/relais`, {});
    expect(ok.json).toMatchObject({ statut: 'proposee', cerveau: 'claude', coutCentimes: 40 });
    expect(claude.recu).toHaveLength(1);
    expect((await c.call('GET', '/api/reglages/ia')).json.depenseDuMoisCentimes).toBe(40);
  });

  it('mode automatique : relais direct, jusqu’au plafond, puis arrêt', async () => {
    await reglages({ relaisClaude: 'auto', plafondMensuelCentimes: 100 });
    local.comportement = () => ({ statut: 'impossible', raison: 'non' });
    claude.comportement = accroche('Accroche auto', 70);
    const r = await demander('Accroche plus chaleureuse');
    expect(r.json).toMatchObject({ statut: 'proposee', cerveau: 'claude' }); // 40 + 70 = 110 centimes dépensés
    const r2 = await demander('Encore une autre accroche');
    expect(r2.json.statut).toBe('impossible');
    expect(r2.json.raison).toMatch(/plafond mensuel/);
  });

  it('modèle local trop lent, absent ou dépassé par la taille : relais ; Claude peut aussi répondre « je ne sais pas »', async () => {
    await reglages({ relaisClaude: 'auto', plafondMensuelCentimes: 10_000 });
    claude.comportement = () => ({ statut: 'impossible', raison: 'la demande est ambiguë : quel soin ?', coutCentimes: 5 });
    local.comportement = () => new Promise((r) => setTimeout(() => r({ statut: 'impossible', raison: 'x' }), 2000));
    local.delaiMs = 100;
    const lent = await demander('Change le prix');
    expect(lent.json.journal.map((j: any) => j.texte).join(' ')).toMatch(/temps de réponse dépassé/);
    expect(lent.json.statut).toBe('impossible');
    expect(lent.json.raison).toMatch(/Claude ne sait pas faire.*ambiguë/);
    local.tailleMax = 10;
    const gros = await demander('Change le prix');
    expect(gros.json.journal.map((j: any) => j.texte).join(' ')).toMatch(/trop volumineuse pour le modèle local/);
    local.tailleMax = 1_000_000;
    local.dispo = false;
    const absent = await demander('Change le prix');
    expect(absent.json.journal.map((j: any) => j.texte).join(' ')).toMatch(/ne répond pas/);
  });

  it('une proposition devient périmée si le contenu a changé entre-temps', async () => {
    local.comportement = accroche('Accroche périmée');
    const r = await demander('Change l’accroche');
    const e = await c.call('GET', `/api/sites/${siteId}/contenus/site`);
    await c.call('PUT', `/api/sites/${siteId}/contenus/site`, { valeur: { ...e.json.valeur, presentation: 'Modifié à la main' }, version: e.json.version });
    const a = await c.call('POST', `/api/sites/${siteId}/assistant/${r.json.id}/accepter`, { empreinte: r.json.empreinte });
    expect(a.status).toBe(409);
    expect(lireFichier().presentation).toBe('Modifié à la main');
    expect(lireFichier().accroche).not.toBe('Accroche périmée');
  });

  it('arrêt d’urgence : plus aucune acceptation possible, demandes refusées', async () => {
    local.comportement = accroche('Avant l’arrêt');
    const r = await demander('Change l’accroche');
    expect(r.json.statut).toBe('proposee');
    await reglages({ active: false });
    expect((await c.call('POST', `/api/sites/${siteId}/assistant/${r.json.id}/accepter`, { empreinte: r.json.empreinte })).status).toBe(409);
    expect((await demander('Autre chose')).status).toBe(409);
    await reglages({ active: true });
  });

  it('droits : une contributrice demande et accepte, mais ne peut pas engager de dépense Claude ; un autre site est invisible', async () => {
    await reglages({ relaisClaude: 'demander', plafondMensuelCentimes: 10_000 });
    const inv = await c.call('POST', '/api/invitations', { email: 'camille@exemple.fr', roles: [{ siteId, role: 'contributeur' }] });
    const camille = client(p, { remoteAddress: '10.3.3.3' });
    camille.csrf = (await camille.call('GET', '/api/etat')).json.csrf;
    await camille.call('POST', `/api/invitations/${inv.json.lien.split('/invitation/')[1]}/accepter`, { nom: 'Camille', motDePasse: 'des vacances au bord de la mer' });
    const d = await camille.call('POST', '/api/profil/2fa/totp/debut', {});
    await camille.call('POST', '/api/profil/2fa/totp/confirmer', { code: totpCode(d.json.secret) });
    local.comportement = accroche('Accroche de Camille');
    const r = await demander('Change l’accroche', {}, camille);
    expect(r.json.statut).toBe('proposee');
    expect((await camille.call('POST', `/api/sites/${siteId}/assistant/${r.json.id}/accepter`, { empreinte: r.json.empreinte })).status).toBe(200);
    local.comportement = () => ({ statut: 'impossible', raison: 'non' });
    const r2 = await demander('Accroche difficile', {}, camille);
    expect(r2.json.statut).toBe('accord_requis');
    expect((await camille.call('POST', `/api/sites/${siteId}/assistant/${r2.json.id}/relais`, {})).status).toBe(403);
    expect((await camille.call('GET', `/api/sites/${autreSite}/assistant`)).status).toBe(404);
    expect((await camille.call('POST', `/api/sites/${autreSite}/assistant/${r.json.id}/accepter`, { empreinte: r.json.empreinte })).status).toBe(404);
    expect((await camille.call('PUT', '/api/reglages/ia', { active: true })).status).toBe(403);
  });

  it('tout est noté dans le journal de PAGINITY', () => {
    const actions = (p.ctx.db.prepare("SELECT action FROM audit WHERE action LIKE 'ia_%'").all() as { action: string }[]).map((a) => a.action);
    for (const a of ['ia_reglages', 'ia_demande', 'ia_acceptee', 'ia_relais_accepte']) expect(actions).toContain(a);
  });
});
