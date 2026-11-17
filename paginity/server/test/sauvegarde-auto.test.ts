import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupOwner, startPaginity, stopPaginity, totpCode, type Client } from './helpers.js';
import { main } from '../src/cli/admin.js';
import { restaurer } from '../src/cli/sauvegarde.js';

/**
 * Sauvegarde automatique chiffrée hors machine : phrase obligatoire, dossier hors des données, fichier illisible sans
 * la phrase, essai de restauration réussi, fichier abîmé détecté (alerte critique), nombre de fichiers gardés,
 * déclenchement à l'heure choisie, ouverture avec l'outil de secours puis restauration complète.
 */
type P = Awaited<ReturnType<typeof startPaginity>>;
const PHRASE = 'girafe cassis tambour lanterne';

async function admin(dataDir: string, args: string[], saisie: string) {
  const avant = process.env.PAGINITY_DATA_DIR;
  process.env.PAGINITY_DATA_DIR = dataDir;
  const lignes: string[] = [];
  try {
    const code = await main(args, { log: (s) => lignes.push(s), err: (s) => lignes.push(s) }, async () => saisie);
    return { code, sortie: lignes.join('\n') };
  } finally {
    if (avant === undefined) delete process.env.PAGINITY_DATA_DIR;
    else process.env.PAGINITY_DATA_DIR = avant;
  }
}

describe('Sauvegarde automatique chiffrée', () => {
  let p: P;
  let c: Client;
  let dossier: string;
  let racine: string;
  const put = (x: Record<string, unknown>) => c.call('PUT', '/api/reglages/sauvegarde', x);
  const fichiers = () => fs.readdirSync(dossier).filter((n) => n.endsWith('.paginity')).sort();

  beforeAll(async () => {
    p = await startPaginity();
    let secret: string;
    ({ c, secret } = await setupOwner(p));
    expect((await c.call('POST', '/api/sites', { nom: 'Salon Coffre-fort', modele: 'vitrine' })).status).toBe(200);
    expect((await c.call('POST', '/api/confirmation', { motDePasse: 'une phrase de passe solide', code: totpCode(secret, 1) })).status).toBe(200);
    racine = fs.mkdtempSync(path.join(os.tmpdir(), 'paginity-auto-'));
    dossier = path.join(racine, 'Google Drive', 'Sauvegardes PAGINITY');
    fs.mkdirSync(dossier, { recursive: true });
  }, 60_000);
  afterAll(async () => {
    await stopPaginity(p);
    fs.rmSync(racine, { recursive: true, force: true });
  });

  it('refuse de s’activer sans phrase, avec une phrase faible ou un dossier mal choisi', async () => {
    expect((await put({ active: true, dossier })).json.erreur).toMatch(/phrase de sauvegarde/);
    expect((await c.call('POST', '/api/reglages/sauvegarde/phrase', { phrase: 'trop court' })).status).toBe(400);
    expect((await c.call('POST', '/api/reglages/sauvegarde/phrase', { phrase: PHRASE })).json.phrase).toBe(true);
    expect((await put({ active: true, dossier: 'sauvegardes' })).json.erreur).toMatch(/chemin complet/);
    expect((await put({ active: true, dossier: path.join(p.dir, 'espaces') })).json.erreur).toMatch(/HORS des données/);
    expect((await put({ active: true, dossier: path.join(racine, 'absent') })).json.erreur).toMatch(/introuvable/);
    const r = await put({ active: true, dossier, heure: 3, garder: 2 });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ dossierOk: true, phrase: true, reglages: { active: true, garder: 2 } });
    expect(JSON.stringify(r.json)).not.toContain(PHRASE);
  });

  it('crée un fichier chiffré, illisible sans la phrase, et l’essai de restauration réussit', async () => {
    const r = await c.call('POST', '/api/reglages/sauvegarde/maintenant');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.derniere).toMatchObject({ ok: true });
    expect(fichiers()).toHaveLength(1);
    const brut = fs.readFileSync(path.join(dossier, fichiers()[0]));
    expect(brut.subarray(0, 30).toString()).toBe('PAGINITY-SAUVEGARDE-CHIFFREE 1');
    for (const clair of ['Salon Coffre-fort', 'ustar', 'proprio@exemple.fr', 'SQLite format']) expect(brut.includes(clair)).toBe(false);
    const e = await c.call('POST', '/api/reglages/sauvegarde/essai');
    expect(e.json.dernierEssai, JSON.stringify(e.json)).toMatchObject({ ok: true });
    expect(e.json.dernierEssai.message).toMatch(/1 site\(s\)/);
    // Rien ne traîne dans les données (dossiers de travail effacés).
    expect(fs.readdirSync(path.join(p.dir, 'sauvegardes'))).toEqual([]);
  });

  it('ne garde que le nombre demandé de sauvegardes', async () => {
    for (let i = 0; i < 2; i++) expect((await c.call('POST', '/api/reglages/sauvegarde/maintenant')).status).toBe(200);
    expect(fichiers()).toHaveLength(2);
    fs.writeFileSync(path.join(dossier, 'mes-photos.jpg'), 'x');
    expect((await c.call('POST', '/api/reglages/sauvegarde/maintenant')).status).toBe(200);
    expect(fichiers()).toHaveLength(2);
    expect(fs.existsSync(path.join(dossier, 'mes-photos.jpg'))).toBe(true); // jamais les autres fichiers
  });

  it('un fichier abîmé est repéré par l’essai, avec une alerte critique', async () => {
    const f = path.join(dossier, fichiers().at(-1)!);
    const copie = fs.readFileSync(f);
    const abime = Buffer.from(copie);
    abime[abime.length - 100] ^= 0xff;
    fs.writeFileSync(f, abime);
    const e = await c.call('POST', '/api/reglages/sauvegarde/essai');
    expect(e.json.dernierEssai).toMatchObject({ ok: false });
    expect(e.json.dernierEssai.message).toMatch(/phrase incorrecte, ou fichier abîmé/);
    const alertes = p.ctx.db.prepare("SELECT message FROM alerts WHERE level = 'critique'").all() as { message: string }[];
    expect(alertes.some((a) => a.message.includes('essai de restauration'))).toBe(true);
    fs.writeFileSync(f, copie);
  });

  it('se déclenche seule à l’heure choisie, une fois par jour', async () => {
    const avant = fichiers();
    const t = new Date();
    t.setHours(4);
    await p.ctx.sauvegardeAuto.tic(t);
    expect(fichiers()).toEqual(avant); // pas l'heure
    t.setHours(3);
    await p.ctx.sauvegardeAuto.tic(t);
    const apres = fichiers();
    expect(apres).not.toEqual(avant);
    await p.ctx.sauvegardeAuto.tic(t);
    expect(fichiers()).toEqual(apres); // une seule fois
  });

  it('l’outil de secours ouvre la sauvegarde avec la phrase, puis tout se restaure', async () => {
    const f = path.join(dossier, fichiers().at(-1)!);
    const mauvais = await admin(p.dir, ['ouvrir-sauvegarde', f, path.join(racine, 'ouvert-1')], 'mauvaise phrase de sauvegarde');
    expect(mauvais.code).toBe(1);
    expect(mauvais.sortie).toMatch(/phrase incorrecte/);
    const bon = await admin(p.dir, ['ouvrir-sauvegarde', f, path.join(racine, 'ouvert-2')], PHRASE);
    expect(bon.code, bon.sortie).toBe(0);
    const archive = /restaurer (\S+) --cle (\S+)/.exec(bon.sortie)!;
    const r = restaurer(archive[1], archive[2], path.join(racine, 'nouvelle-machine'));
    expect(r.sites).toBe(1);
  });
});
