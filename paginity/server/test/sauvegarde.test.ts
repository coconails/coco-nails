import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, getSite, setupOwner, startPaginity, stopPaginity, totpCode, waitJob, type Client } from './helpers.js';
import { main } from '../src/cli/admin.js';
import { secretValues } from '../src/functions/secrets.js';
import { listSubmissions } from '../src/functions/forms.js';

/**
 * Sauvegarde complète et restauration vérifiée (intervention K) : on sauvegarde une installation réelle de PAGINITY,
 * on la restaure sur une machine « vierge » (autre dossier), et on vérifie que TOUT revient : connexion avec double
 * authentification, sites en ligne, historiques, secrets, messages. Puis les cas de refus.
 */
type P = Awaited<ReturnType<typeof startPaginity>>;
const EMAIL = 'proprio@exemple.fr';
const MDP = 'une phrase de passe solide';

async function admin(dataDir: string, args: string[]): Promise<{ code: number; sortie: string }> {
  const avant = process.env.PAGINITY_DATA_DIR;
  process.env.PAGINITY_DATA_DIR = dataDir;
  const lignes: string[] = [];
  try {
    const code = await main(args, { log: (s) => lignes.push(s), err: (s) => lignes.push(s) }, async () => '');
    return { code, sortie: lignes.join('\n') };
  } finally {
    if (avant === undefined) delete process.env.PAGINITY_DATA_DIR;
    else process.env.PAGINITY_DATA_DIR = avant;
  }
}

describe('Sauvegarde complète et restauration', () => {
  let src: P;
  let c: Client;
  let secret: string;
  let siteId: string;
  let slug: string;
  let racine: string;
  let archive: string;
  let cle: string;
  let commitsAvant: number;
  let pageAvant: string;

  beforeAll(async () => {
    racine = fs.mkdtempSync(path.join(os.tmpdir(), 'paginity-sauv-'));
    src = await startPaginity();
    ({ c, secret } = await setupOwner(src, EMAIL, MDP));
    expect((await c.call('POST', '/api/confirmation', { motDePasse: MDP, code: totpCode(secret, 1) })).status).toBe(200);
    const s = await c.call('POST', '/api/sites', { nom: 'Boutique', modele: 'vitrine' });
    siteId = s.json.id;
    slug = s.json.slug;
    for (let i = 0; i < 2; i++) {
      const e = await c.call('GET', `/api/sites/${siteId}/contenus/faq`);
      if (i === 1) await c.call('PUT', `/api/sites/${siteId}/contenus/faq`, { valeur: e.json.valeur, version: e.json.version });
      const j = await c.call('POST', `/api/sites/${siteId}/publier`, {});
      expect((await waitJob(src, j.json.id)).etat).toBe('reussie');
    }
    expect((await c.call('PUT', `/api/sites/${siteId}/secrets/production/CLE_API`, { valeur: 'cle-tres-secrete-42' })).status).toBe(200);
    // Un message reçu par un formulaire (chiffré comme à la réception).
    src.ctx.db.prepare('INSERT INTO form_submissions (id, site_id, form, at, data_enc) VALUES (?, ?, ?, ?, ?)').run('f1', siteId, 'contact', Date.now(), src.ctx.vault.encrypt(JSON.stringify({ nom: 'Julie', message: 'Bonjour' })));
    commitsAvant = (await src.ctx.sites.repo(src.ctx.sites.get(siteId)!).log({ limit: 1000 })).length;
    pageAvant = (await getSite(src, `${slug}.localhost`)).body;
    expect(pageAvant).toContain('<');
  }, 120_000);
  afterAll(async () => {
    await stopPaginity(src);
    fs.rmSync(racine, { recursive: true, force: true });
  });

  it('sauvegarde pendant que PAGINITY tourne : une archive et, à part, la clé (droits réservés)', async () => {
    const r = await admin(src.dir, ['sauvegarder', path.join(racine, 'sauvegardes')]);
    expect(r.code, r.sortie).toBe(0);
    const fichiers = fs.readdirSync(path.join(racine, 'sauvegardes'));
    archive = path.join(racine, 'sauvegardes', fichiers.find((f) => f.endsWith('.tar.gz'))!);
    cle = path.join(racine, 'sauvegardes', fichiers.find((f) => f.startsWith('paginity-cle-coffre-'))!);
    expect(fs.statSync(archive).mode & 0o777).toBe(0o600);
    expect(fs.statSync(cle).mode & 0o777).toBe(0o600);
    // La clé n'est pas dans l'archive, ni rien de temporaire.
    const contenu = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    expect(contenu).not.toMatch(/coffre|temporaire|cache\//);
    expect(contenu).toMatch(/^base\.db$/m);
    expect(contenu).toMatch(/en-ligne/);
    expect(fs.readFileSync(cle, 'utf8').trim()).toBe(fs.readFileSync(path.join(src.dir, 'coffre', 'cle-maitre'), 'utf8').trim());
    // Refus d'écrire la sauvegarde au milieu des données.
    expect((await admin(src.dir, ['sauvegarder', path.join(src.dir, 'espaces')])).code).toBe(1);
  });

  it('restaure sur une installation vierge : connexion, site en ligne, historique, secrets et messages identiques', async () => {
    const cible = path.join(racine, 'nouvelle-machine');
    const r = await admin(cible, ['restaurer', archive, '--cle', cle]);
    expect(r.code, r.sortie).toBe(0);
    const v = await admin(cible, ['verifier']);
    expect(v.code, v.sortie).toBe(0);
    const dst = await startPaginity({ dataDir: cible });
    try {
      // Connexion avec le même mot de passe et la même application de codes.
      // (L'anti-rejeu est restauré lui aussi : le code tout juste utilisé sur l'ancienne machine serait refusé ;
      //  on simule ici le code suivant, comme si l'on se connectait un peu plus tard.)
      dst.ctx.db.prepare('UPDATE users SET totp_last_step = 0').run();
      const n = client(dst);
      n.csrf = (await n.call('GET', '/api/etat')).json.csrf;
      const s1 = await n.call('POST', '/api/connexion', { email: EMAIL, motDePasse: MDP });
      expect(s1.json.etape).toBe('2fa');
      expect((await n.call('POST', '/api/connexion/totp', { defi: s1.json.defi, code: totpCode(secret, 1) })).status).toBe(200);
      // Le site est en ligne, à l'identique.
      expect((await getSite(dst, `${slug}.localhost`)).body).toBe(pageAvant);
      const site = dst.ctx.sites.get(siteId)!;
      expect((await dst.ctx.sites.repo(site).log({ limit: 1000 })).length).toBe(commitsAvant);
      expect(secretValues(dst.ctx, siteId, 'production')).toEqual({ CLE_API: 'cle-tres-secrete-42' });
      expect(listSubmissions(dst.ctx, siteId).map((m: any) => m.donnees ?? m.data ?? m)).toHaveLength(1);
      expect(JSON.stringify(listSubmissions(dst.ctx, siteId))).toContain('Julie');
      // Et on peut continuer à travailler : nouvelle publication.
      const j = await n.call('POST', `/api/sites/${siteId}/publier`, {});
      expect((await waitJob(dst, j.json.id)).etat).toBe('reussie');
      expect((await getSite(dst, `${slug}.localhost`)).status).toBe(200);
      // Le lien « en ligne » pointe bien dans la nouvelle machine, pas dans l'ancienne.
      expect(fs.readlinkSync(dst.ctx.sites.liveLink(site)).startsWith(cible)).toBe(true);
    } finally {
      await stopPaginity(dst);
    }
  }, 120_000);

  it('refuse de restaurer dans un dossier qui n’est pas vide', async () => {
    const r = await admin(src.dir, ['restaurer', archive, '--cle', cle]);
    expect(r.code).toBe(1);
    expect(r.sortie).toMatch(/n’est pas vide/);
  });

  it('refuse une mauvaise clé', async () => {
    const autre = path.join(racine, 'autre-cle.txt');
    fs.writeFileSync(autre, Buffer.alloc(32, 9).toString('base64'));
    const cible = path.join(racine, 'essai-cle');
    const r = await admin(cible, ['restaurer', archive, '--cle', autre]);
    expect(r.code).toBe(1);
    expect(r.sortie).toMatch(/ne correspond pas/);
    expect(fs.existsSync(cible)).toBe(false);
  });

  it('refuse une sauvegarde abîmée ou modifiée', async () => {
    const dir = fs.mkdtempSync(path.join(racine, 'modif-'));
    execFileSync('tar', ['-xzf', archive, '-C', dir]);
    const page = execFileSync('find', [path.join(dir, 'espaces'), '-name', 'index.html', '-path', '*versions*'], { encoding: 'utf8' }).split('\n')[0];
    fs.chmodSync(path.dirname(page), 0o755);
    fs.chmodSync(page, 0o644);
    fs.appendFileSync(page, '<script>piège</script>');
    const modifiee = path.join(racine, 'modifiee.tar.gz');
    execFileSync('tar', ['-czf', modifiee, '-C', dir, ...fs.readdirSync(dir)]);
    const r = await admin(path.join(racine, 'essai-modif'), ['restaurer', modifiee, '--cle', cle]);
    expect(r.code).toBe(1);
    expect(r.sortie).toMatch(/abîmée/);
    // Archive tronquée.
    const tronquee = path.join(racine, 'tronquee.tar.gz');
    fs.writeFileSync(tronquee, fs.readFileSync(archive).subarray(0, 2000));
    const t = await admin(path.join(racine, 'essai-tronq'), ['restaurer', tronquee, '--cle', cle]);
    expect(t.code).toBe(1);
    expect(t.sortie).toMatch(/illisible ou incomplète/);
  });

  it('refuse une archive piégée (chemin hors du dossier, lien vers le système)', async () => {
    const dir = fs.mkdtempSync(path.join(racine, 'piege-'));
    fs.mkdirSync(path.join(dir, 'espaces'));
    fs.symlinkSync('/etc', path.join(dir, 'espaces', 'raccourci'));
    const piegee = path.join(racine, 'piegee.tar.gz');
    execFileSync('tar', ['-czf', piegee, '-C', dir, 'espaces']);
    const r = await admin(path.join(racine, 'essai-piege'), ['restaurer', piegee, '--cle', cle]);
    expect(r.code).toBe(1);
    expect(r.sortie).toMatch(/lien inattendu/);
    const evasion = path.join(racine, 'evasion.tar.gz');
    fs.writeFileSync(path.join(racine, 'x.txt'), 'x');
    execFileSync('tar', ['-czf', evasion, '-P', '--transform', 's,^,espaces/../../,', '-C', racine, 'x.txt']);
    expect(execFileSync('tar', ['-tzf', evasion], { encoding: 'utf8' })).toMatch(/\.\.\//);
    const r2 = await admin(path.join(racine, 'essai-evasion'), ['restaurer', evasion, '--cle', cle]);
    expect(r2.code).toBe(1);
    expect(r2.sortie).toMatch(/dangereux|inattendu/);
  });
});
