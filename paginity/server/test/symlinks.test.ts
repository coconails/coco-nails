import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSite, setupOwner, startPaginity, stopPaginity, waitJob, type Client } from './helpers.js';
import { findSymlinks } from '../src/sites/files.js';

/**
 * Liens symboliques (P0-2) : un lien placé dans le code d'un site ne doit jamais permettre à ses fonctions
 * de lire un fichier de PAGINITY (clé du coffre, base de données…), ni pendant l'étape de préparation.
 */
type P = Awaited<ReturnType<typeof startPaginity>>;

const LIRE = `import fs from "node:fs";
export default async (req) => {
  const f = new URL(req.url).searchParams.get("f");
  try { return new Response(fs.readFileSync(f, "utf8")); } catch (e) { return new Response("refuse:" + (e.code || e.message), { status: 403 }); }
};
export const config = { path: "/api/lire" };
`;

const LIEN = `import fs from "node:fs";
import path from "node:path";
export default async (req) => {
  const cible = new URL(req.url).searchParams.get("cible");
  const lien = path.join(path.dirname(process.env.PAGINITY_SOCKET), "raccourci");
  let creation = "ok";
  try { fs.symlinkSync(cible, lien); } catch (e) { creation = e.code || e.message; }
  let lecture = "ok";
  try { fs.readFileSync(lien, "utf8"); } catch (e) { lecture = e.code || e.message; }
  return Response.json({ creation, lecture });
};
export const config = { path: "/api/lien" };
`;

const LIEN_PHYSIQUE = `import fs from "node:fs";
import path from "node:path";
export default async (req) => {
  const cible = new URL(req.url).searchParams.get("cible");
  const copie = path.join(path.dirname(process.env.PAGINITY_SOCKET), "copie");
  let creation = "ok";
  try { fs.linkSync(cible, copie); } catch (e) { creation = e.code || e.message; }
  let lecture = "ok";
  try { fs.readFileSync(copie, "utf8"); } catch (e) { lecture = e.code || e.message; }
  return Response.json({ creation, lecture });
};
export const config = { path: "/api/lien-physique" };
`;

async function writeFiles(c: Client, siteId: string, files: Record<string, string>) {
  for (const [chemin, contenu] of Object.entries(files)) {
    if ((await c.call('GET', `/api/sites/${siteId}/fichier?chemin=${encodeURIComponent(chemin)}`)).status !== 200) {
      await c.call('POST', `/api/sites/${siteId}/fichiers/nouveau`, { chemin });
    }
    const v = (await c.call('GET', `/api/sites/${siteId}/fichier?chemin=${encodeURIComponent(chemin)}`)).json.version;
    const w = await c.call('PUT', `/api/sites/${siteId}/fichier`, { chemin, contenu, version: v });
    if (w.status !== 200) throw new Error(`${chemin} : ${w.body}`);
  }
}

describe('Liens symboliques et isolation', () => {
  let p: P;
  let c: Client;
  let siteId: string;
  let slug: string;
  let cle: string;

  beforeAll(async () => {
    p = await startPaginity({ isolation: 'processus' });
    ({ c } = await setupOwner(p));
    cle = path.join(p.dir, 'coffre', 'cle-maitre');
    const s = await c.call('POST', '/api/sites', { nom: 'Liens', modele: 'vierge' });
    siteId = s.json.id;
    slug = s.json.slug;
    await writeFiles(c, siteId, {
      'paginity.yml': 'dossier_publie: public\nfonctions:\n  dossier: netlify/functions\n  format: netlify-v2\n',
      'netlify/functions/lire.mjs': LIRE,
      'netlify/functions/lien.mjs': LIEN,
      'netlify/functions/lien-physique.mjs': LIEN_PHYSIQUE,
    });
    const j = await c.call('POST', `/api/sites/${siteId}/publier`, {});
    expect((await waitJob(p, j.json.id)).etat).toBe('reussie');
  });
  afterAll(async () => stopPaginity(p));

  it('une fonction ne peut pas créer un raccourci vers la clé du coffre dans son dossier de travail', async () => {
    const r = await getSite(p, `${slug}.localhost`, `/api/lien?cible=${encodeURIComponent(cle)}`);
    const b = JSON.parse(r.body);
    expect(b.lecture).not.toBe('ok');
  });

  it('une fonction ne peut pas créer un lien physique (hardlink) vers la clé du coffre', async () => {
    const r = await getSite(p, `${slug}.localhost`, `/api/lien-physique?cible=${encodeURIComponent(cle)}`);
    const b = JSON.parse(r.body);
    expect(b.lecture).not.toBe('ok');
  });

  it('refuse de publier un site dont le dépôt contient un lien symbolique (dépôt importé piégé)', async () => {
    const site = p.ctx.sites.get(siteId)!;
    const repoDir = p.ctx.sites.repoDir(site);
    // Simule ce qu'apporterait un dépôt Git importé contenant un lien vers la clé du coffre.
    fs.symlinkSync(cle, path.join(repoDir, 'piege'));
    await p.ctx.sites.repo(site).commitAll('Lien piégé', { name: 'Test', email: 'test@exemple.fr' });
    const j = await c.call('POST', `/api/sites/${siteId}/publier`, {});
    const done = await waitJob(p, j.json.id);
    // Quoi qu'il arrive, la clé ne doit jamais être lisible par la fonction.
    const fuite = await getSite(p, `${slug}.localhost`, '/api/lire?f=piege');
    expect(fuite.body).not.toBe(fs.readFileSync(cle, 'utf8'));
    expect(done.etat).toBe('echouee');
    expect(done.erreur).toMatch(/lien symbolique/i);
    // L'aperçu refuse aussi.
    const a = await c.call('POST', `/api/sites/${siteId}/apercu`, {});
    expect(a.status).toBe(422);
    expect(a.json.erreur).toMatch(/lien symbolique/i);
  });

  it('repère les liens symboliques d’un dépôt Git cloné', () => {
    const dir = fs.mkdtempSync(path.join(p.dir, 'depot-'));
    execFileSync('git', ['init', '-q', dir]);
    fs.writeFileSync(path.join(dir, 'index.html'), 'ok');
    fs.mkdirSync(path.join(dir, 'public'));
    fs.symlinkSync('/etc/passwd', path.join(dir, 'public', 'mot-de-passe'));
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A']);
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x']);
    const clone = path.join(p.dir, 'clone');
    execFileSync('git', ['clone', '-q', dir, clone]);
    expect(findSymlinks(clone)).toEqual(['public/mot-de-passe']);
  });
});
