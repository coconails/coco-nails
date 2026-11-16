import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, setupOwner, startPaginity, stopPaginity, totpCode, type Client } from './helpers.js';
import { Authentificateur } from './authentificateur.js';

/** Passkeys côté serveur : enregistrement, connexion, et tout ce qui doit être refusé. */
type P = Awaited<ReturnType<typeof startPaginity>>;
const EMAIL = 'proprio@exemple.fr';
const MDP = 'une phrase de passe solide';

describe('Passkeys (vérification par le serveur)', () => {
  let p: P;
  let c: Client;
  let secret: string;
  const tel = new Authentificateur();

  async function debutConnexion(email = EMAIL, mdp = MDP) {
    const n = client(p, { remoteAddress: `10.9.0.${Math.floor(Math.random() * 200) + 1}` });
    n.csrf = (await n.call('GET', '/api/etat')).json.csrf;
    const s1 = await n.call('POST', '/api/connexion', { email, motDePasse: mdp });
    const opts = await n.call('POST', '/api/connexion/passkey/options', { defi: s1.json.defi });
    return { n, defi: s1.json.defi as string, opts: opts.json, etape: s1.json };
  }

  beforeAll(async () => {
    p = await startPaginity();
    ({ c, secret } = await setupOwner(p, EMAIL, MDP));
  });
  afterAll(async () => stopPaginity(p));

  it('enregistre une passkey seulement après confirmation d’identité', async () => {
    expect((await c.call('POST', '/api/profil/passkeys/options', {})).status).toBe(403);
    expect((await c.call('POST', '/api/confirmation', { motDePasse: MDP, code: totpCode(secret, 1) })).status).toBe(200);
    const opts = await c.call('POST', '/api/profil/passkeys/options', {});
    expect(opts.status).toBe(200);
    // Réponse fabriquée pour un faux site (hameçonnage) : refusée.
    expect((await c.call('POST', '/api/profil/passkeys', { reponse: tel.enregistrer(opts.json, 'https://faux-paginity.exemple'), nom: 'Pirate' })).status).toBe(400);
    const opts2 = await c.call('POST', '/api/profil/passkeys/options', {});
    const r = await c.call('POST', '/api/profil/passkeys', { reponse: tel.enregistrer(opts2.json), nom: 'Téléphone' });
    expect(r.status, r.body).toBe(200);
    const prof = await c.call('GET', '/api/profil');
    expect(prof.json.passkeys.map((x: any) => x.nom)).toEqual(['Téléphone']);
    // Le défi ne sert qu'une fois.
    expect((await c.call('POST', '/api/profil/passkeys', { reponse: tel.enregistrer(opts2.json), nom: 'Bis' })).status).toBe(400);
  });

  it('connexion par passkey après le mot de passe', async () => {
    const { n, defi, opts } = await debutConnexion();
    expect(opts.allowCredentials.map((x: any) => x.id)).toEqual([tel.credId.toString('base64url')]);
    const r = await n.call('POST', '/api/connexion/passkey', { defi, reponse: tel.signer(opts) });
    expect(r.status, r.body).toBe(200);
    expect((await n.call('GET', '/api/sites')).status).toBe(200);
  });

  it('refuse : rejeu, faux site, mauvaise clé, compteur qui recule (passkey copiée)', async () => {
    // Rejeu d'une réponse déjà utilisée sur un nouveau défi.
    const a = await debutConnexion();
    const ok = tel.signer(a.opts);
    expect((await a.n.call('POST', '/api/connexion/passkey', { defi: a.defi, reponse: ok })).status).toBe(200);
    const b = await debutConnexion();
    expect((await b.n.call('POST', '/api/connexion/passkey', { defi: b.defi, reponse: ok })).status).toBe(401);
    // Réponse signée pour un autre site (hameçonnage).
    const c2 = await debutConnexion();
    expect((await c2.n.call('POST', '/api/connexion/passkey', { defi: c2.defi, reponse: tel.signer(c2.opts, { origine: 'https://faux-paginity.exemple' }) })).status).toBe(401);
    // Signature faite avec une autre clé.
    const d = await debutConnexion();
    const autre = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    expect((await d.n.call('POST', '/api/connexion/passkey', { defi: d.defi, reponse: tel.signer(d.opts, { cle: autre }) })).status).toBe(401);
    // Compteur inférieur au dernier vu : signe d'une passkey clonée.
    const e = await debutConnexion();
    expect((await e.n.call('POST', '/api/connexion/passkey', { defi: e.defi, reponse: tel.signer(e.opts, { compteur: 1 }) })).status).toBe(401);
    // Après 5 échecs, le défi est épuisé : il faut recommencer depuis le mot de passe.
    const f = await debutConnexion();
    for (let i = 0; i < 5; i++) await f.n.call('POST', '/api/connexion/passkey', { defi: f.defi, reponse: tel.signer(f.opts, { cle: autre }) });
    expect((await f.n.call('POST', '/api/connexion/passkey', { defi: f.defi, reponse: tel.signer(f.opts) })).status).toBe(429);
  });

  it('la passkey d’une personne ne connecte jamais une autre personne', async () => {
    const inv = await c.call('POST', '/api/invitations', { email: 'autre@exemple.fr', roles: [] });
    const token = inv.json.lien.split('/invitation/')[1];
    const o = client(p);
    o.csrf = (await o.call('GET', '/api/etat')).json.csrf;
    const acc = await o.call('POST', `/api/invitations/${token}/accepter`, { nom: 'Autre', motDePasse: 'des vacances au bord de la mer' });
    const d = await o.call('POST', '/api/profil/2fa/totp/debut', {});
    expect(d.status, `${inv.body} | ${acc.body} | ${d.body}`).toBe(200);
    await o.call('POST', '/api/profil/2fa/totp/confirmer', { code: totpCode(d.json.secret) });
    const n = client(p, { remoteAddress: '10.9.9.9' });
    n.csrf = (await n.call('GET', '/api/etat')).json.csrf;
    const s1 = await n.call('POST', '/api/connexion', { email: 'autre@exemple.fr', motDePasse: 'des vacances au bord de la mer' });
    // L'autre personne n'a pas de passkey : pas d'options, et la passkey de la propriétaire est refusée.
    expect((await n.call('POST', '/api/connexion/passkey/options', { defi: s1.json.defi })).status).toBe(400);
    expect((await n.call('POST', '/api/connexion/passkey', { defi: s1.json.defi, reponse: tel.signer({ challenge: 'x' }) })).status).toBe(401);
  });

  it('confirmation d’identité par passkey (mot de passe + passkey)', async () => {
    const opts = await c.call('POST', '/api/confirmation/passkey/options', {});
    expect(opts.status).toBe(200);
    expect((await c.call('POST', '/api/confirmation/passkey', { motDePasse: 'faux mot de passe', reponse: tel.signer(opts.json) })).status).toBe(401);
    const opts2 = await c.call('POST', '/api/confirmation/passkey/options', {});
    expect((await c.call('POST', '/api/confirmation/passkey', { motDePasse: MDP, reponse: tel.signer(opts2.json) })).status).toBe(200);
  });
});
