import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, setupOwner, startPaginity, stopPaginity, waitJob, totpCode } from './helpers.js';
import { main } from '../src/cli/admin.js';

/** P1-8 : l'outil de secours paginity-admin (sur la machine), quand l'interface web n'est plus utilisable. */
type P = Awaited<ReturnType<typeof startPaginity>>;
const EMAIL = 'proprio@exemple.fr';
const MDP = 'une phrase de passe solide';

async function admin(dataDir: string, args: string[], saisies: string[] = []): Promise<{ code: number; sortie: string }> {
  const avant = process.env.PAGINITY_DATA_DIR;
  process.env.PAGINITY_DATA_DIR = dataDir;
  const lignes: string[] = [];
  try {
    const code = await main(args, { log: (s) => lignes.push(s), err: (s) => lignes.push(s) }, async () => saisies.shift() ?? '');
    return { code, sortie: lignes.join('\n') };
  } finally {
    if (avant === undefined) delete process.env.PAGINITY_DATA_DIR;
    else process.env.PAGINITY_DATA_DIR = avant;
  }
}

describe('Outil de secours paginity-admin', () => {
  let p: P;
  let secret: string;

  beforeAll(async () => {
    p = await startPaginity();
    ({ secret } = await setupOwner(p, EMAIL, MDP));
    const { c } = { c: client(p) };
    c.csrf = (await c.call('GET', '/api/etat')).json.csrf;
    const s1 = await c.call('POST', '/api/connexion', { email: EMAIL, motDePasse: MDP });
    await c.call('POST', '/api/connexion/totp', { defi: s1.json.defi, code: totpCode(secret, 1) });
    const s = await c.call('POST', '/api/sites', { nom: 'Secours', modele: 'vierge' });
    const j = await c.call('POST', `/api/sites/${s.json.id}/publier`, {});
    expect((await waitJob(p, j.json.id)).etat).toBe('reussie');
  });
  afterAll(async () => stopPaginity(p));

  it('affiche l’aide et refuse une commande inconnue', async () => {
    expect((await admin(p.dir, ['aide'])).sortie).toMatch(/reinitialiser-2fa/);
    expect((await admin(p.dir, ['nimporte'])).code).toBe(1);
    expect((await admin(path.join(p.dir, 'vide'), ['etat'])).code).toBe(2);
  });

  it('vérifie la base, la clé du coffre et les sites', async () => {
    const r = await admin(p.dir, ['verifier']);
    expect(r.sortie, r.sortie).toMatch(/Tout est en ordre/);
    expect(r.code).toBe(0);
    // Mauvaise clé du coffre : détectée.
    const cle = path.join(p.dir, 'coffre', 'cle-maitre');
    const vraie = fs.readFileSync(cle);
    fs.writeFileSync(cle, Buffer.alloc(32, 7).toString('base64'));
    try {
      const r2 = await admin(p.dir, ['verifier']);
      expect(r2.code).toBe(3);
      expect(r2.sortie).toMatch(/NE s’ouvrent PAS/);
    } finally {
      fs.writeFileSync(cle, vraie);
    }
  });

  it('débloque un compte bloqué par des erreurs de connexion', async () => {
    const pirate = client(p, { remoteAddress: '203.0.113.20' });
    pirate.csrf = (await pirate.call('GET', '/api/etat')).json.csrf;
    for (let i = 0; i < 6; i++) await pirate.call('POST', '/api/connexion', { email: EMAIL, motDePasse: 'faux mot de passe' });
    const nouvel = client(p, { remoteAddress: '198.51.100.20' });
    nouvel.csrf = (await nouvel.call('GET', '/api/etat')).json.csrf;
    expect((await nouvel.call('POST', '/api/connexion', { email: EMAIL, motDePasse: MDP })).status).toBe(429);
    expect((await admin(p.dir, ['etat'])).sortie).toMatch(/email:proprio@exemple.fr/);
    expect((await admin(p.dir, ['debloquer', EMAIL])).code).toBe(0);
    expect((await nouvel.call('POST', '/api/connexion', { email: EMAIL, motDePasse: MDP })).status).toBe(200);
  });

  it('change le mot de passe (saisi au clavier, jamais en clair sur la ligne de commande) et ferme les sessions', async () => {
    expect((await admin(p.dir, ['mot-de-passe', EMAIL], ['nouvelle phrase secrete', 'autre chose'])).code).toBe(1);
    expect((await admin(p.dir, ['mot-de-passe', EMAIL], ['court', 'court'])).sortie).toMatch(/12 caractères/);
    const r = await admin(p.dir, ['mot-de-passe', EMAIL], ['nouvelle phrase secrete', 'nouvelle phrase secrete']);
    expect(r.code, r.sortie).toBe(0);
    expect((p.ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(0);
    const c = client(p, { remoteAddress: '198.51.100.21' });
    c.csrf = (await c.call('GET', '/api/etat')).json.csrf;
    expect((await c.call('POST', '/api/connexion', { email: EMAIL, motDePasse: MDP })).status).toBe(401);
    expect((await c.call('POST', '/api/connexion', { email: EMAIL, motDePasse: 'nouvelle phrase secrete' })).status).toBe(200);
  });

  it('réinitialise la double authentification (téléphone perdu), seulement avec --confirmer', async () => {
    expect((await admin(p.dir, ['reinitialiser-2fa', EMAIL])).code).toBe(1);
    expect((p.ctx.db.prepare('SELECT totp_enabled AS t FROM users').get() as { t: number }).t).toBe(1);
    expect((await admin(p.dir, ['reinitialiser-2fa', EMAIL, '--confirmer'])).code).toBe(0);
    const c = client(p, { remoteAddress: '198.51.100.22' });
    c.csrf = (await c.call('GET', '/api/etat')).json.csrf;
    const r = await c.call('POST', '/api/connexion', { email: EMAIL, motDePasse: 'nouvelle phrase secrete' });
    expect(r.json.etape).toBe('configurer-2fa');
    // Session limitée : rien d'autre que la configuration de la double authentification.
    expect((await c.call('GET', '/api/sites')).status).toBe(403);
    const journal = p.ctx.db.prepare("SELECT action FROM audit WHERE action LIKE 'secours_%' ORDER BY at").all() as { action: string }[];
    expect(journal.map((j) => j.action)).toEqual(['secours_debloquer', 'secours_mot_de_passe', 'secours_reinitialiser_2fa']);
  });

  it('copie la base de façon cohérente, sans jamais écraser un fichier', async () => {
    const dest = path.join(p.dir, 'copie.db');
    expect((await admin(p.dir, ['copie-base', dest])).code).toBe(0);
    const copie = new DatabaseSync(dest, { readOnly: true });
    expect((copie.prepare('SELECT COUNT(*) AS n FROM sites').get() as { n: number }).n).toBe(1);
    copie.close();
    expect((await admin(p.dir, ['copie-base', dest])).code).toBe(1);
    expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
  });
});
