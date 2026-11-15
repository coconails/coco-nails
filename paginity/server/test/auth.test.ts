import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, setupOwner, startPaginity, stopPaginity, totpCode } from './helpers.js';

type P = Awaited<ReturnType<typeof startPaginity>>;

describe('Connexion et sécurité', () => {
  let p: P;
  let secret: string;
  let codes: string[];
  const email = 'proprio@exemple.fr';
  const password = 'une phrase de passe solide';

  beforeAll(async () => {
    p = await startPaginity();
  });
  afterAll(async () => stopPaginity(p));

  it("refuse l'installation sans le bon code", async () => {
    const c = client(p);
    c.csrf = (await c.call('GET', '/api/etat')).json.csrf;
    const r = await c.call('POST', '/api/installation', { code: 'FAUX', nom: 'X', email: 'x@exemple.fr', motDePasse: 'une phrase de passe solide' });
    expect(r.status).toBe(400);
  });

  it('refuse un mot de passe trop court', async () => {
    const c = client(p);
    c.csrf = (await c.call('GET', '/api/etat')).json.csrf;
    const r = await c.call('POST', '/api/installation', { code: p.setupCode, nom: 'X', email: 'x@exemple.fr', motDePasse: 'court' });
    expect(r.status).toBe(400);
    expect(r.json.erreur).toMatch(/12 caractères/);
  });

  it('installe le propriétaire et impose la double authentification', async () => {
    const c = client(p);
    c.csrf = (await c.call('GET', '/api/etat')).json.csrf;
    const inst = await c.call('POST', '/api/installation', { code: p.setupCode, nom: 'Propriétaire', email, motDePasse: password });
    expect(inst.status).toBe(200);
    // Tant que la double authentification n'est pas configurée, l'accès aux sites est refusé.
    const sites = await c.call('GET', '/api/sites');
    expect(sites.status).toBe(403);
    const debut = await c.call('POST', '/api/profil/2fa/totp/debut', {});
    expect(debut.json.qr).toMatch(/^data:image\/png;base64,/);
    const mauvais = await c.call('POST', '/api/profil/2fa/totp/confirmer', { code: '000000' });
    expect(mauvais.status).toBe(400);
    const conf = await c.call('POST', '/api/profil/2fa/totp/confirmer', { code: totpCode(debut.json.secret) });
    expect(conf.status).toBe(200);
    expect(conf.json.codesSecours).toHaveLength(10);
    secret = debut.json.secret;
    codes = conf.json.codesSecours;
    expect((await c.call('GET', '/api/sites')).status).toBe(200);
    // Une deuxième installation est impossible.
    expect((await c.call('POST', '/api/installation', { code: 'X', nom: 'Y', email: 'y@exemple.fr', motDePasse: password })).status).toBe(409);
  });

  it('refuse les requêtes sans jeton anti-falsification ou venant d’une autre origine', async () => {
    const c = client(p);
    c.csrf = (await c.call('GET', '/api/etat')).json.csrf;
    expect((await c.call('POST', '/api/connexion', { email, motDePasse: password }, { 'x-csrf-token': 'mauvais-jeton-xxxxxxxxxxxxxxxx' })).status).toBe(403);
    expect((await c.call('POST', '/api/connexion', { email, motDePasse: password }, { origin: 'http://pirate.exemple' })).status).toBe(403);
  });

  it('se connecte en deux étapes et refuse la réutilisation d’un code', async () => {
    const c = client(p);
    c.csrf = (await c.call('GET', '/api/etat')).json.csrf;
    const step1 = await c.call('POST', '/api/connexion', { email, motDePasse: password });
    expect(step1.json.etape).toBe('2fa');
    expect(step1.json.methodes.totp).toBe(true);
    // Avant la 2e étape : pas de session.
    expect((await c.call('GET', '/api/sites')).status).toBe(401);
    const code = totpCode(secret, 1);
    const ok = await c.call('POST', '/api/connexion/totp', { defi: step1.json.defi, code });
    expect(ok.status).toBe(200);
    expect((await c.call('GET', '/api/sites')).status).toBe(200);
    // Même code une seconde fois : refusé (protection contre le rejeu).
    const c2 = client(p);
    c2.csrf = (await c2.call('GET', '/api/etat')).json.csrf;
    const s1 = await c2.call('POST', '/api/connexion', { email, motDePasse: password });
    expect((await c2.call('POST', '/api/connexion/totp', { defi: s1.json.defi, code })).status).toBe(401);
  });

  it('accepte un code de secours une seule fois', async () => {
    const c = client(p);
    c.csrf = (await c.call('GET', '/api/etat')).json.csrf;
    const s1 = await c.call('POST', '/api/connexion', { email, motDePasse: password });
    expect((await c.call('POST', '/api/connexion/secours', { defi: s1.json.defi, code: codes[0] })).status).toBe(200);
    const c2 = client(p);
    c2.csrf = (await c2.call('GET', '/api/etat')).json.csrf;
    const s2 = await c2.call('POST', '/api/connexion', { email, motDePasse: password });
    expect((await c2.call('POST', '/api/connexion/secours', { defi: s2.json.defi, code: codes[0] })).status).toBe(401);
  });

  it('bloque après plusieurs mauvais mots de passe', async () => {
    p.ctx.db.prepare('DELETE FROM login_attempts').run();
    p.ctx.db.prepare('UPDATE users SET totp_last_step = 0').run();
    const c = client(p);
    c.csrf = (await c.call('GET', '/api/etat')).json.csrf;
    for (let i = 0; i < 5; i++) {
      const r = await c.call('POST', '/api/connexion', { email: 'autre@exemple.fr', motDePasse: 'mauvais mot de passe' });
      expect(r.status).toBe(401);
      expect(r.json.erreur).toBe('Adresse e-mail ou mot de passe incorrect.');
    }
    const blocked = await c.call('POST', '/api/connexion', { email: 'autre@exemple.fr', motDePasse: 'mauvais mot de passe' });
    expect(blocked.status).toBe(429);
  });

  it('demande une confirmation d’identité pour les actions sensibles et déconnecte partout', async () => {
    const { c } = { c: client(p) };
    c.csrf = (await c.call('GET', '/api/etat')).json.csrf;
    // Débloque l'adresse de test utilisée plus haut.
    p.ctx.db.prepare('DELETE FROM login_attempts').run();
    p.ctx.db.prepare('UPDATE users SET totp_last_step = 0').run();
    const s1 = await c.call('POST', '/api/connexion', { email, motDePasse: password });
    await c.call('POST', '/api/connexion/totp', { defi: s1.json.defi, code: totpCode(secret) });
    const r = await c.call('POST', '/api/profil/codes-secours', {});
    expect(r.status).toBe(403);
    expect(r.json.details.confirmation).toBe(true);
    expect((await c.call('POST', '/api/confirmation', { motDePasse: password, code: codes[1] })).status).toBe(200);
    const r2 = await c.call('POST', '/api/profil/codes-secours', {});
    expect(r2.status).toBe(200);
    expect(r2.json.codesSecours).toHaveLength(10);
    expect((await c.call('POST', '/api/deconnexion/partout', {})).status).toBe(200);
    expect((await c.call('GET', '/api/sites')).status).toBe(401);
  });

  it('a enregistré les opérations importantes dans le journal', () => {
    const actions = (p.ctx.db.prepare('SELECT action FROM audit').all() as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['installation', 'totp_active', 'connexion', 'code_secours_utilise', 'deconnexion_partout']));
  });

  it('crée un compte par invitation, avec double authentification obligatoire', async () => {
    const { c: owner } = await (async () => {
      p.ctx.db.prepare('DELETE FROM login_attempts').run();
    p.ctx.db.prepare('UPDATE users SET totp_last_step = 0').run();
      const c = client(p);
      c.csrf = (await c.call('GET', '/api/etat')).json.csrf;
      const s1 = await c.call('POST', '/api/connexion', { email, motDePasse: password });
      await c.call('POST', '/api/connexion/totp', { defi: s1.json.defi, code: totpCode(secret) });
      return { c };
    })();
    const inv = await owner.call('POST', '/api/invitations', { email: 'invite@exemple.fr', roles: [] });
    expect(inv.status).toBe(200);
    const token = inv.json.lien.split('/invitation/')[1];
    const g = client(p);
    g.csrf = (await g.call('GET', '/api/etat')).json.csrf;
    expect((await g.call('GET', `/api/invitations/${token}`)).json.email).toBe('invite@exemple.fr');
    expect((await g.call('POST', `/api/invitations/${token}/accepter`, { nom: 'Invité', motDePasse: 'encore une phrase solide' })).status).toBe(200);
    expect((await g.call('GET', '/api/sites')).status).toBe(403);
    // Lien à usage unique.
    expect((await g.call('GET', `/api/invitations/${token}`)).status).toBe(404);
  });
});
