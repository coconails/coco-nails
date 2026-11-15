import fs from 'node:fs';
import path from 'node:path';
import yazl from 'yazl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

  it('publie le site (sans étape de préparation ni fonctions en phase 2) avec ses redirections et en-têtes', async () => {
    const j = await c.call('POST', '/api/sites/' + id + '/publier', {});
    const done = await waitJob(p, j.json.id);
    expect(done.erreur).toBeNull();
    expect(done.etapes.find((s) => s.nom === 'Fonctions serveur')!.message).toMatch(/phase 3/);
    const home = await getSite(p, `${slug}.localhost`);
    expect(home.status).toBe(200);
    expect(home.body).toContain("Coco Nail");
    expect(home.headers['x-frame-options']).toBe('DENY');
    const rdv = await getSite(p, `${slug}.localhost`, '/rdv');
    expect(rdv.status).toBe(301);
    expect(rdv.headers.location).toBe('/#reserver');
    expect((await getSite(p, `${slug}.localhost`, '/contenu/soins.json')).headers['cache-control']).toBe('no-cache');
    expect((await getSite(p, `${slug}.localhost`, '/api/disponibilites')).status).toBe(503);
    // Le code des fonctions et la fiche ne sont jamais publiés.
    expect((await getSite(p, `${slug}.localhost`, '/netlify/lib/agenda.mjs')).status).toBe(404);
  });
});
