import fs from 'node:fs';
import path from 'node:path';
import yazl from 'yazl';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
import { getSite, setupOwner, startPaginity, stopPaginity, waitJob, type Client } from './helpers.js';

/**
 * Essai de compatibilité avec le vrai site Coco Nail's (dépôt lu en local, jamais copié dans PAGINITY).
 * Le test est ignoré si le dépôt n'est pas présent (variable COCO_NAILS_DIR).
 */
const SRC = process.env.COCO_NAILS_DIR ?? '/home/user/coco-nails1';
const present = fs.existsSync(path.join(SRC, '.pages.yml'));

function zipDir(dir: string, dest: string): Promise<void> {
  return new Promise((resolve) => {
    const z = new yazl.ZipFile();
    const walk = (d: string, rel: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else z.addFile(path.join(d, e.name), r);
      }
    };
    walk(dir, '');
    z.end();
    z.outputStream.pipe(fs.createWriteStream(dest)).on('close', () => resolve());
  });
}

describe.skipIf(!present)('Compatibilité Coco Nail’s (import réel)', () => {
  let p: Awaited<ReturnType<typeof startPaginity>>;
  let c: Client;
  let id: string;
  let slug: string;

  beforeAll(async () => {
    p = await startPaginity();
    ({ c } = await setupOwner(p));
  });
  afterAll(async () => stopPaginity(p));

  it('importe le dépôt et détecte sa configuration Netlify', async () => {
    const zip = path.join(p.dir, 'coco.zip');
    await zipDir(SRC, zip);
    const boundary = '----coco';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="nom"\r\n\r\nCoco Nail's\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="coco.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      fs.readFileSync(zip),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const j = await c.call('POST', '/api/sites/import', body, { 'content-type': `multipart/form-data; boundary=${boundary}` });
    const done = await waitJob(p, j.json.id);
    expect(done.erreur).toBeNull();
    id = (done.resultat as any).siteId;
    const s = await c.call('GET', `/api/sites/${id}`);
    slug = s.json.slug;
    expect(slug).toBe('coco-nails');
    expect(s.json.fiche.dossierPublie).toBe('public');
    expect(s.json.fiche.preparation).toBe('node netlify/preparer-page.mjs');
    expect(s.json.fiche.fonctions).toBe('netlify/functions');
  });

  it('ouvre toutes les rubriques de son .pages.yml en formulaires', async () => {
    const list = await c.call('GET', `/api/sites/${id}/contenus`);
    expect(list.json.source).toBe('.pages.yml');
    expect(list.json.rubriques.length).toBeGreaterThanOrEqual(9);
    for (const r of list.json.rubriques) {
      const e = await c.call('GET', `/api/sites/${id}/contenus/${r.nom}`);
      expect(e.status, r.nom).toBe(200);
    }
    // Les saisies actuelles respectent le schéma : un enregistrement à l'identique est accepté.
    const soins = await c.call('GET', `/api/sites/${id}/contenus/soins`);
    const save = await c.call('PUT', `/api/sites/${id}/contenus/soins`, { valeur: soins.json.valeur, version: soins.json.version });
    expect(save.status).toBe(200);
    expect(save.json.enregistre).toBe(false); // rien n'a changé : aucun point d'historique inutile
  });

  it('publie le site avec son étape de préparation, ses dépendances et ses 8 fonctions', async () => {
    const j = await c.call('POST', '/api/sites/' + id + '/publier', {});
    const done = await waitJob(p, j.json.id);
    if (done.erreur) console.log(p.ctx.functions.recentLogs(id).join('\n'));
    expect(done.erreur).toBeNull();
    expect(done.etapes.find((s) => s.nom === 'Fabriquer')!.message).toMatch(/dépendances.*préparation exécutée/);
    expect(done.etapes.find((s) => s.nom === 'Fonctions serveur')!.message).toMatch(/^8 fonction\(s\) prête\(s\)/);
    const home = await getSite(p, `${slug}.localhost`);
    expect(home.status).toBe(200);
    // L'étape de préparation a écrit les données structurées pour Google dans la page.
    expect(home.body).toContain('NailSalon');
    expect(home.headers['x-frame-options']).toBe('DENY');
    const rdv = await getSite(p, `${slug}.localhost`, '/rdv');
    expect(rdv.status).toBe(301);
    expect(rdv.headers.location).toBe('/#reserver');
    expect((await getSite(p, `${slug}.localhost`, '/contenu/soins.json')).headers['cache-control']).toBe('no-cache');
    // Le code des fonctions et la fiche ne sont jamais publiés.
    expect((await getSite(p, `${slug}.localhost`, '/netlify/lib/agenda.mjs')).status).toBe(404);
    expect((await getSite(p, `${slug}.localhost`, '/.app/netlify/lib/agenda.mjs')).status).toBe(404);
  });

  it('exécute les vraies fonctions (sans secrets : elles le signalent elles-mêmes)', async () => {
    const dispo = await getSite(p, `${slug}.localhost`, '/api/disponibilites?du=2026-12-01&au=2026-12-10');
    expect(dispo.status).toBe(200);
    expect(JSON.parse(dispo.body)).toEqual({ actif: false, occupe: [] });
    const compta = await getSite(p, `${slug}.localhost`, '/api/compta');
    expect(compta.status).toBe(503);
    expect(JSON.parse(compta.body).configuration).toBe(true);
    const f = await c.call('GET', `/api/sites/${id}/fonctions`);
    const noms = f.json.fonctions.map((x: any) => x.nom).sort();
    expect(noms).toEqual(['compta', 'desinscription', 'disponibilites', 'facture', 'rappel-urssaf', 'rappels', 'rdv', 'reserver']);
    expect(f.json.fonctions.find((x: any) => x.nom === 'rappels').planification).toBe('0 9 * * *');
    expect(f.json.fonctions.find((x: any) => x.nom === 'rappel-urssaf').planification).toBe('0 7 * * *');
    // Site importé : tâches planifiées désactivées par défaut (pas de double envoi avec Netlify).
    expect(f.json.planificationActive).toBe(false);
    expect(f.json.statistiques.find((x: any) => x.fonction === 'disponibilites').appels24h).toBe(1);
  });

  it('détecte les secrets attendus par le code, sans jamais renvoyer leur valeur', async () => {
    const r = await c.call('GET', `/api/sites/${id}/secrets`);
    const noms = r.json.map((x: any) => x.nom);
    expect(noms).toEqual(expect.arrayContaining(['GOOGLE_PRIVATE_KEY', 'GOOGLE_CLIENT_EMAIL', 'GOOGLE_CALENDAR_ID', 'COMPTA_MOT_DE_PASSE', 'OVH_APPLICATION_KEY', 'SUMUP_API_KEY']));
    expect(noms).not.toContain('URL');
  });

  it('reçoit les formulaires Netlify du site (contact et rendez-vous de secours)', async () => {
    const post = (body: string, accept = 'text/html') =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const r = require('node:http').request(
          { host: '127.0.0.1', port: p.ctx.config.sitesPort, path: '/', method: 'POST', headers: { host: `${slug}.localhost`, 'content-type': 'application/x-www-form-urlencoded', accept } },
          (res: any) => {
            let b = '';
            res.on('data', (d: Buffer) => (b += d));
            res.on('end', () => resolve({ status: res.statusCode, body: b }));
          },
        );
        r.end(body);
      });
    expect((await post('form-name=contact&nom=Test&email=test%40exemple.fr&message=Bonjour')).status).toBe(200);
    // Robot (champ piège rempli) : réponse normale, rien d'enregistré.
    expect((await post('form-name=contact&nom=Robot&bot-field=spam')).status).toBe(200);
    expect((await post('form-name=inconnu&x=1')).status).toBe(404);
    const m = await c.call('GET', `/api/sites/${id}/formulaires`);
    expect(m.json.messages).toHaveLength(1);
    expect(m.json.messages[0].formulaire).toBe('contact');
    expect(m.json.messages[0].donnees).toMatchObject({ nom: 'Test', message: 'Bonjour' });
    // Les messages sont chiffrés dans la base.
    const raw = p.ctx.db.prepare('SELECT data_enc FROM form_submissions').get() as { data_enc: string };
    expect(raw.data_enc).not.toContain('Bonjour');
  });
});
