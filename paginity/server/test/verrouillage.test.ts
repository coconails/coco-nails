import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { client, setupOwner, startPaginity, stopPaginity, totpCode, type Client } from './helpers.js';
import { realIp } from '../src/lib/ip.js';

/**
 * Blocage après des erreurs de connexion (P1-6).
 * Un inconnu qui connaît l'adresse e-mail de la propriétaire ne doit pas pouvoir l'empêcher de se connecter
 * depuis ses appareils habituels, tout en restant lui-même bloqué. Derrière le tunnel, l'adresse IP réelle
 * de chaque visiteur doit être lue (sinon tout le monde partage la même et se bloque mutuellement).
 */
type P = Awaited<ReturnType<typeof startPaginity>>;
const EMAIL = 'proprio@exemple.fr';
const MDP = 'une phrase de passe solide';

async function nouveau(p: P, ip: string): Promise<Client> {
  const c = client(p, { remoteAddress: ip });
  c.csrf = (await c.call('GET', '/api/etat')).json.csrf;
  return c;
}

describe('Blocage des connexions', () => {
  let p: P;
  let secret: string;
  let habituel: Client;

  beforeAll(async () => {
    p = await startPaginity();
    ({ secret } = await setupOwner(p, EMAIL, MDP));
    // La propriétaire se connecte une fois depuis son téléphone : il devient un appareil reconnu.
    habituel = await nouveau(p, '10.0.0.5');
    const s1 = await habituel.call('POST', '/api/connexion', { email: EMAIL, motDePasse: MDP });
    expect((await habituel.call('POST', '/api/connexion/totp', { defi: s1.json.defi, code: totpCode(secret, 1) })).status).toBe(200);
    expect(habituel.cookies.has('paginity_appareil')).toBe(true);
  });
  afterAll(async () => stopPaginity(p));
  beforeEach(() => {
    // Chaque essai part d'une situation propre (codes à 6 chiffres réutilisables, aucun blocage en cours).
    p.ctx.db.prepare('UPDATE users SET totp_last_step = 0').run();
    p.ctx.db.prepare('DELETE FROM login_attempts').run();
  });

  it('un inconnu qui se trompe de mot de passe est bloqué, mais la propriétaire peut toujours se connecter depuis son appareil', async () => {
    const pirate = await nouveau(p, '203.0.113.9');
    for (let i = 0; i < 6; i++) await pirate.call('POST', '/api/connexion', { email: EMAIL, motDePasse: 'mauvais mot de passe' });
    expect((await pirate.call('POST', '/api/connexion', { email: EMAIL, motDePasse: MDP })).status).toBe(429);
    // Depuis un autre inconnu : le compte reste protégé pour les nouveaux appareils.
    const autre = await nouveau(p, '198.51.100.7');
    expect((await autre.call('POST', '/api/connexion', { email: EMAIL, motDePasse: MDP })).status).toBe(429);
    // Depuis l'appareil reconnu : la connexion fonctionne.
    const r = await habituel.call('POST', '/api/connexion', { email: EMAIL, motDePasse: MDP });
    expect(r.status, r.body).toBe(200);
    expect(r.json.etape).toBe('2fa');
    expect((await habituel.call('POST', '/api/connexion/totp', { defi: r.json.defi, code: totpCode(secret) })).status).toBe(200);
    // La propriétaire est prévenue.
    const alertes = await habituel.call('GET', '/api/alertes');
    expect(alertes.json.some((a: any) => /nouvel appareil/i.test(a.message))).toBe(true);
  });

  it('la confirmation d’identité d’une personne connectée n’est pas bloquée par les erreurs d’un inconnu', async () => {
    const pirate = await nouveau(p, '203.0.113.10');
    for (let i = 0; i < 6; i++) await pirate.call('POST', '/api/connexion', { email: EMAIL, motDePasse: 'mauvais mot de passe' });
    const r = await habituel.call('POST', '/api/confirmation', { motDePasse: MDP, code: totpCode(secret) });
    expect(r.status, r.body).toBe(200);
  });

  it('un appareil reconnu reste limité s’il enchaîne les erreurs', async () => {
    for (let i = 0; i < 5; i++) expect((await habituel.call('POST', '/api/connexion', { email: EMAIL, motDePasse: 'faux' })).status).toBe(401);
    expect((await habituel.call('POST', '/api/connexion', { email: EMAIL, motDePasse: MDP })).status).toBe(429);
  });

  it('un cookie d’appareil falsifié ou d’un autre compte ne donne aucun passe-droit', async () => {
    const pirate = await nouveau(p, '203.0.113.12');
    for (let i = 0; i < 6; i++) await pirate.call('POST', '/api/connexion', { email: EMAIL, motDePasse: 'mauvais mot de passe' });
    const faux = await nouveau(p, '203.0.113.11');
    faux.cookies.set('paginity_appareil', 'v1.inconnu.abc.1.signature-fausse');
    expect((await faux.call('POST', '/api/connexion', { email: EMAIL, motDePasse: MDP })).status).toBe(429);
    // Le vrai cookie, recopié avec une signature modifiée : refusé aussi.
    const vrai = habituel.cookies.get('paginity_appareil')!;
    faux.cookies.set('paginity_appareil', vrai.slice(0, -2) + (vrai.endsWith('AA') ? 'BB' : 'AA'));
    expect((await faux.call('POST', '/api/connexion', { email: EMAIL, motDePasse: MDP })).status).toBe(429);
  });

  it('lit l’adresse réelle derrière le tunnel, sans se laisser tromper', () => {
    const avant = process.env.PAGINITY_TRUST_PROXY;
    try {
      delete process.env.PAGINITY_TRUST_PROXY;
      expect(realIp('127.0.0.1', { 'cf-connecting-ip': '1.2.3.4' })).toBe('127.0.0.1');
      process.env.PAGINITY_TRUST_PROXY = 'true';
      // Tunnel local : l'adresse fournie par Cloudflare fait foi.
      expect(realIp('127.0.0.1', { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9, 1.2.3.4' })).toBe('1.2.3.4');
      // Sans en-tête Cloudflare : la dernière adresse ajoutée (celle que le visiteur ne peut pas choisir).
      expect(realIp('::1', { 'x-forwarded-for': '9.9.9.9, 5.6.7.8' })).toBe('5.6.7.8');
      // Une connexion qui ne vient pas du tunnel local ne peut pas imposer son adresse.
      expect(realIp('203.0.113.50', { 'cf-connecting-ip': '1.2.3.4' })).toBe('203.0.113.50');
      expect(realIp('::ffff:127.0.0.1', { 'cf-connecting-ip': 'pas une adresse' })).toBe('::ffff:127.0.0.1');
    } finally {
      if (avant === undefined) delete process.env.PAGINITY_TRUST_PROXY;
      else process.env.PAGINITY_TRUST_PROXY = avant;
    }
  });
});
