import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, setupOwner, startPaginity, stopPaginity, totpCode, type Client } from './helpers.js';
import { main } from '../src/cli/admin.js';
import { Vault } from '../src/lib/vault.js';
import { secretValues } from '../src/functions/secrets.js';
import { listSubmissions } from '../src/functions/forms.js';

/**
 * Changement de la clé du coffre (rotation) : toutes les données chiffrées sont rechiffrées, l'ancienne clé
 * n'ouvre plus rien, PAGINITY redémarre normalement ; une coupure au milieu se termine ou s'annule proprement.
 */
type P = Awaited<ReturnType<typeof startPaginity>>;
const EMAIL = 'proprio@exemple.fr';
const MDP = 'une phrase de passe solide';

async function admin(dataDir: string, args: string[], adminPort?: number) {
  const env = { ...process.env };
  process.env.PAGINITY_DATA_DIR = dataDir;
  if (adminPort) process.env.PAGINITY_ADMIN_PORT = String(adminPort);
  const lignes: string[] = [];
  try {
    const code = await main(args, { log: (s) => lignes.push(s), err: (s) => lignes.push(s) }, async () => '');
    return { code, sortie: lignes.join('\n') };
  } finally {
    process.env = env;
  }
}

/** Toutes les valeurs chiffrées de la base, lues directement dans le fichier. */
function chiffrees(dataDir: string): string[] {
  const db = new DatabaseSync(path.join(dataDir, 'plateforme', 'paginity.db'), { readOnly: true });
  try {
    return [
      ...(db.prepare('SELECT totp_secret_enc AS v FROM users WHERE totp_secret_enc IS NOT NULL').all() as { v: string }[]),
      ...(db.prepare('SELECT value_enc AS v FROM site_secrets').all() as { v: string }[]),
      ...(db.prepare('SELECT data_enc AS v FROM form_submissions').all() as { v: string }[]),
      ...(db.prepare("SELECT value AS v FROM settings WHERE key = 'smtp_mdp'").all() as { v: string }[]),
    ].map((r) => r.v);
  } finally {
    db.close();
  }
}
const ouvre = (cle: string, v: string) => {
  try {
    Vault.fromKey(Buffer.from(cle, 'base64')).decrypt(v);
    return true;
  } catch {
    return false;
  }
};

describe('Changement de la clé du coffre', () => {
  let p: P;
  let dir: string;
  let secret: string;
  let siteId: string;
  let ancienne: string;
  const cleF = () => path.join(dir, 'coffre', 'cle-maitre');

  beforeAll(async () => {
    p = await startPaginity();
    dir = p.dir;
    let c: Client;
    ({ c, secret } = await setupOwner(p, EMAIL, MDP));
    expect((await c.call('POST', '/api/confirmation', { motDePasse: MDP, code: totpCode(secret, 1) })).status).toBe(200);
    siteId = (await c.call('POST', '/api/sites', { nom: 'Rotation', modele: 'vierge' })).json.id;
    expect((await c.call('PUT', `/api/sites/${siteId}/secrets/production/CLE_API`, { valeur: 'valeur-a-proteger-77' })).status).toBe(200);
    expect((await c.call('PUT', '/api/reglages/messagerie', { hote: 'smtp.exemple.fr', port: 587, securise: false, utilisateur: 'moi', motDePasse: 'mot-de-passe-smtp-55', expediteur: 'a@exemple.fr', destinataireAlertes: 'b@exemple.fr' })).status).toBe(200);
    p.ctx.db.prepare('INSERT INTO form_submissions (id, site_id, form, at, data_enc) VALUES (?, ?, ?, ?, ?)').run('f1', siteId, 'contact', Date.now(), p.ctx.vault.encrypt('{"nom":"Julie"}'));
    ancienne = fs.readFileSync(cleF(), 'utf8').trim();
    expect(chiffrees(dir).length).toBe(4);
  });
  afterAll(async () => {
    await stopPaginity(p);
  });

  it('refuse sans --confirmer, et pendant que PAGINITY tourne', async () => {
    expect((await admin(dir, ['changer-cle'])).code).toBe(1);
    await p.admin.listen({ port: 0, host: '127.0.0.1' });
    const port = (p.admin.server.address() as { port: number }).port;
    const r = await admin(dir, ['changer-cle', '--confirmer'], port);
    expect(r.code).toBe(1);
    expect(r.sortie).toMatch(/en marche/);
    expect(fs.readFileSync(cleF(), 'utf8').trim()).toBe(ancienne);
    await p.close();
  });

  it('rechiffre tout : l’ancienne clé n’ouvre plus rien, la nouvelle ouvre tout', async () => {
    const r = await admin(dir, ['changer-cle', '--confirmer'], 1);
    expect(r.code, r.sortie).toBe(0);
    expect(r.sortie).toMatch(/4 valeur\(s\) rechiffrée/);
    const nouvelle = fs.readFileSync(cleF(), 'utf8').trim();
    expect(nouvelle).not.toBe(ancienne);
    expect(fs.statSync(cleF()).mode & 0o777).toBe(0o600);
    for (const v of chiffrees(dir)) {
      expect(ouvre(ancienne, v)).toBe(false);
      expect(ouvre(nouvelle, v)).toBe(true);
    }
    expect((await admin(dir, ['verifier'])).code).toBe(0);
  });

  it('PAGINITY redémarre : connexion avec le même code, secrets, messages et messagerie intacts', async () => {
    p = await startPaginity({ dataDir: dir });
    p.ctx.db.prepare('UPDATE users SET totp_last_step = 0').run();
    const n = client(p);
    n.csrf = (await n.call('GET', '/api/etat')).json.csrf;
    const s1 = await n.call('POST', '/api/connexion', { email: EMAIL, motDePasse: MDP });
    expect((await n.call('POST', '/api/connexion/totp', { defi: s1.json.defi, code: totpCode(secret) })).status).toBe(200);
    expect(secretValues(p.ctx, siteId, 'production')).toEqual({ CLE_API: 'valeur-a-proteger-77' });
    expect(JSON.stringify(listSubmissions(p.ctx, siteId))).toContain('Julie');
    const smtp = p.ctx.db.prepare("SELECT value FROM settings WHERE key = 'smtp_mdp'").get() as { value: string };
    expect(p.ctx.vault.decrypt(smtp.value)).toBe('mot-de-passe-smtp-55');
    await p.close();
  });

  it('coupure APRÈS le rechiffrement : PAGINITY refuse de démarrer, puis la commande termine le changement', async () => {
    // État simulé : base rechiffrée avec une clé encore rangée en « .nouvelle ».
    const enService = fs.readFileSync(cleF(), 'utf8').trim();
    const r = await admin(dir, ['changer-cle', '--confirmer'], 1);
    expect(r.code).toBe(0);
    const apres = fs.readFileSync(cleF(), 'utf8').trim();
    fs.writeFileSync(path.join(dir, 'coffre', 'cle-maitre.nouvelle'), apres, { mode: 0o600 });
    fs.writeFileSync(cleF(), enService, { mode: 0o600 });
    await expect(startPaginity({ dataDir: dir })).rejects.toThrow(/changement de la clé du coffre a été interrompu/);
    expect((await admin(dir, ['sauvegarder', path.join(dir, '..', 'jamais')])).code).toBe(1);
    const fin = await admin(dir, ['changer-cle', '--confirmer'], 1);
    expect(fin.sortie).toMatch(/terminé/);
    expect(fs.readFileSync(cleF(), 'utf8').trim()).toBe(apres);
    expect(fs.existsSync(path.join(dir, 'coffre', 'cle-maitre.nouvelle'))).toBe(false);
    expect((await admin(dir, ['verifier'])).code).toBe(0);
  });

  it('coupure AVANT le rechiffrement : le changement est annulé, l’ancienne clé reste', async () => {
    const enService = fs.readFileSync(cleF(), 'utf8').trim();
    fs.writeFileSync(path.join(dir, 'coffre', 'cle-maitre.nouvelle'), Buffer.alloc(32, 3).toString('base64'), { mode: 0o600 });
    const r = await admin(dir, ['changer-cle', '--confirmer'], 1);
    expect(r.sortie).toMatch(/annulé/);
    expect(fs.readFileSync(cleF(), 'utf8').trim()).toBe(enService);
    expect((await admin(dir, ['verifier'])).code).toBe(0);
    p = await startPaginity({ dataDir: dir }); // pour le nettoyage final
  });
});
