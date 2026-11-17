// M1 — audit de référencement local, dans Chromium : site modèle (avec un défaut ajouté) puis COPIE de Coco Nail's
// importée en ZIP (l'original n'est pas touché ; aucune fonction réelle n'est appelée : l'audit lit les fichiers).
// Lancement : npm run build && COCO_NAILS_DIR=/chemin/vers/coco-nails1 node e2e/referencement.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TOTP, Secret } from 'otpauth';

const require = createRequire(import.meta.url);
const yazl = require('yazl');
const COCO = process.env.COCO_NAILS_DIR ?? '/home/user/coco-nails1';
const { chromium } = require('playwright');
const root = path.dirname(new URL(import.meta.url).pathname);
const OUT = process.env.CAPTURES_IA ?? path.join(root, 'captures');
fs.mkdirSync(OUT, { recursive: true });
const P = { admin: 18830, preview: 18831, sites: 18832 };
const ADMIN = `http://localhost:${P.admin}`;
const MDP = 'une phrase de passe solide';
const totp = (s, d = 0) => new TOTP({ secret: Secret.fromBase32(s), digits: 6, period: 30 }).generate({ timestamp: Date.now() + d * 30_000 });
const tmp = fs.mkdtempSync(path.join(process.env.MANUEL_TMP ?? os.tmpdir(), 'paginity-referencement-'));
let echecs = 0;
const ok = (c, t) => {
  console.log(`${c ? '✔' : '✘'} ${t}`);
  if (!c) echecs++;
};


// Copie de Coco Nail's en archive ZIP (sans .git ni node_modules) : lecture seule de l'original.
const zipPath = path.join(tmp, 'coco.zip');
await new Promise((resolve) => {
  const z = new yazl.ZipFile();
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else z.addFile(path.join(d, e.name), r);
    }
  };
  walk(COCO, '');
  z.end();
  z.outputStream.pipe(fs.createWriteStream(zipPath)).on('close', resolve);
});

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, '..', 'server', 'dist', 'index.js')], {
  env: { ...process.env, PAGINITY_DATA_DIR: path.join(tmp, 'donnees'), PAGINITY_ADMIN_PORT: String(P.admin), PAGINITY_PREVIEW_PORT: String(P.preview), PAGINITY_SITES_PORT: String(P.sites), PAGINITY_PUBLIC_URL: ADMIN, PAGINITY_ISOLATION: 'processus' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
server.stdout.on('data', (d) => (out += d));
const code = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('démarrage')), 20000);
  const i = setInterval(() => {
    const m = out.match(/code à saisir dans le navigateur : (\w+)/);
    if (m) {
      clearInterval(i);
      clearTimeout(t);
      res(m[1]);
    }
  }, 100);
});

const browser = await chromium.launch();
const erreurs = [];
try {
  const ctx = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const etat = await (await ctx.request.get(`${ADMIN}/api/etat`)).json();
  const h = { 'x-csrf-token': etat.csrf, origin: ADMIN };
  await ctx.request.post(`${ADMIN}/api/installation`, { data: { code, nom: 'Donaven', email: 'proprietaire@exemple.fr', motDePasse: MDP }, headers: h });
  const d = await (await ctx.request.post(`${ADMIN}/api/profil/2fa/totp/debut`, { data: {}, headers: h })).json();
  await ctx.request.post(`${ADMIN}/api/profil/2fa/totp/confirmer`, { data: { code: totp(d.secret) }, headers: h });
  const site = await (await ctx.request.post(`${ADMIN}/api/sites`, { data: { nom: 'Salon Démo', modele: 'vitrine' }, headers: h })).json();
  await ctx.request.post(`${ADMIN}/api/confirmation`, { data: { motDePasse: MDP, code: totp(d.secret, 1) }, headers: h });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => erreurs.push(e.message));
  const main = page.locator('main');
  const capture = async (nom, loc) => {
    for (const b of await page.locator('.mantine-Notification-closeButton').all()) await b.click().catch(() => {});
    if (loc) await loc.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 76));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, nom) });
  };
  // 1. Site modèle avec un lien cassé ajouté.
  const f = await (await ctx.request.get(`${ADMIN}/api/sites/${site.id}/fichier?chemin=public/index.html`)).json();
  await ctx.request.put(`${ADMIN}/api/sites/${site.id}/fichier`, { data: { chemin: 'public/index.html', contenu: f.contenu.replace('</main>', '<a href="/tarifs-2025.html">Anciens tarifs</a></main>'), version: f.version }, headers: h });
  await page.goto(`${ADMIN}/sites/${site.id}`);
  await main.getByText('Ce que Google trouve sur le site').waitFor();
  ok(await main.getByText('Ce que Google trouve sur le site').isVisible(), 'Tuile « Référencement » sur la page du site');
  await page.goto(`${ADMIN}/sites/${site.id}/referencement`);
  await main.getByText('Aucun audit du brouillon pour l’instant').waitFor();
  await main.getByRole('button', { name: 'Lancer l’audit' }).click();
  await main.locator('[data-niveau="probleme"]').waitFor({ timeout: 60000 });
  ok(await main.getByText('Lien vers une page qui n’existe pas : /tarifs-2025.html.').isVisible(), 'Problème repéré : lien cassé, avec la page et le conseil');
  ok(await main.getByText('Pas de sitemap.xml.').isVisible(), 'Point à améliorer repéré : pas de sitemap');
  await capture('M1-1-audit-site-modele.png');
  const avant = (await (await ctx.request.get(`${ADMIN}/api/sites/${site.id}/fichier?chemin=public/index.html`)).json()).version;

  // 2. Copie de Coco Nail's importée, audit du brouillon fabriqué (avec sa préparation SEO).
  await page.goto(`${ADMIN}/`);
  await page.getByRole('link', { name: 'Ajouter un site' }).first().click();
  await page.getByLabel(/^Nom du site/).fill("Coco Nail's (copie)");
  await page.getByRole('button', { name: 'Continuer' }).click();
  await page.getByText('Importer une archive').click();
  await page.locator('input[type="file"]').setInputFiles(zipPath);
  await page.getByRole('button', { name: 'Continuer' }).click();
  await page.getByRole('button', { name: 'Créer le site' }).click();
  await page.getByRole('button', { name: 'Ouvrir le site' }).waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: 'Ouvrir le site' }).click();
  await page.getByRole('heading', { name: "Coco Nail's (copie)" }).waitFor();
  const cocoId = page.url().split('/sites/')[1];
  await page.goto(`${ADMIN}/sites/${cocoId}/referencement`);
  await main.getByRole('button', { name: 'Lancer l’audit' }).click();
  await main.locator('[data-section="resume"]').waitFor({ timeout: 180000 });
  const r = await (await ctx.request.get(`${ADMIN}/api/sites/${cocoId}/referencement`)).json();
  const nb = (n) => r.brouillon.constats.filter((c) => c.niveau === n).length;
  console.log(`  (Coco, copie) ${r.brouillon.pages} pages, ${nb('probleme')} problème(s), ${nb('attention')} à améliorer, ${nb('info')} à savoir ; vérifié : ${r.brouillon.verifie.length}`);
  for (const c of r.brouillon.constats) console.log(`    - [${c.niveau}] ${c.page ?? ''} ${c.message}`);
  ok(r.brouillon.verifie.some((v) => v.includes('NailSalon')), 'Coco (copie) : fiche d’entreprise structurée NailSalon reconnue');
  await capture('M1-2-audit-coco-resume.png');
  await capture('M1-3-audit-coco-verifie.png', main.locator('[data-section="verifie"]'));
  // Téléphone.
  const tel = await browser.newContext({ locale: 'fr-FR', ...require('playwright').devices['iPhone 13'] });
  await tel.addCookies(await ctx.cookies());
  const pt = await tel.newPage();
  await pt.goto(`${ADMIN}/sites/${site.id}/referencement`);
  await pt.locator('main [data-niveau="probleme"]').waitFor();
  ok(await pt.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Téléphone : pas de défilement horizontal');
  await pt.screenshot({ path: path.join(OUT, 'M1-4-telephone.png') });
  await tel.close();
  // Lecture seule.
  ok((await (await ctx.request.get(`${ADMIN}/api/sites/${site.id}/fichier?chemin=public/index.html`)).json()).version === avant, 'Lecture seule : aucun fichier modifié par l’audit');
  ok(erreurs.length === 0, `Aucune erreur JavaScript (${erreurs.join(' | ')})`);
} catch (e) {
  console.log('✘ Parcours interrompu :', e.message);
  echecs++;
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(echecs ? 1 : 0);
