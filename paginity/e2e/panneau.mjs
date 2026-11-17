// Panneau permanent de l'assistant (étape A), dans Chromium : présent partout, boutons « + » / « − », bord à tirer,
// taille retenue après rechargement, version téléphone, demande envoyée depuis le panneau (faux modèle local).
// Lancement : npm run build && node e2e/panneau.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TOTP, Secret } from 'otpauth';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const root = path.dirname(new URL(import.meta.url).pathname);
const OUT = process.env.CAPTURES_IA ?? path.join(root, 'captures');
fs.mkdirSync(OUT, { recursive: true });
const P = { admin: 18680, preview: 18681, sites: 18682 };
const ADMIN = `http://localhost:${P.admin}`;
const MDP = 'une phrase de passe solide';
const totp = (s, d = 0) => new TOTP({ secret: Secret.fromBase32(s), digits: 6, period: 30 }).generate({ timestamp: Date.now() + d * 30_000 });
const tmp = fs.mkdtempSync(path.join(process.env.MANUEL_TMP ?? os.tmpdir(), 'paginity-panneau-'));
let echecs = 0;
const ok = (c, t) => {
  console.log(`${c ? '✔' : '✘'} ${t}`);
  if (!c) echecs++;
};

const local = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    if (req.url.endsWith('/models')) return res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
    const u = JSON.parse(b).messages[1].content;
    const site = JSON.parse(u.split('<contenus>\n')[1].split('\n</contenus>')[0]).find((r) => r.rubrique === 'site');
    const rep = { statut: 'proposition', changements: [{ rubrique: 'site', valeur_json: JSON.stringify({ ...site.valeur, accroche: 'Prenez soin de vous' }) }], explication: 'Accroche remplacée.', raison: '' };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(rep) } }] }));
  });
});
await new Promise((r) => local.listen(0, '127.0.0.1', r));

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
  // Assistant activé avec un modèle local (simulé), réglé par l'API (l'écran des réglages est testé par e2e:ia).
  await ctx.request.post(`${ADMIN}/api/confirmation`, { data: { motDePasse: MDP, code: totp(d.secret, 1) }, headers: h });
  const r = await ctx.request.put(`${ADMIN}/api/reglages/ia`, { data: { active: true, local: { actif: true, url: `http://127.0.0.1:${local.address().port}/v1`, modele: 'modele-demo' } }, headers: h });
  ok(r.ok(), 'Assistant activé avec un modèle local (simulé)');

  const page = await ctx.newPage();
  page.on('pageerror', (e) => erreurs.push(e.message));
  const panneau = page.locator('aside[aria-label="Assistant"]');
  const largeur = async () => Math.round((await panneau.boundingBox()).width);
  await page.goto(`${ADMIN}/`);
  await panneau.waitFor();
  ok((await panneau.getAttribute('data-panneau-assistant')) === 'ouvert', 'Panneau présent sur le tableau de bord, ouvert par défaut sur ordinateur');
  ok(Math.abs((await largeur()) - 420) <= 2, `Largeur par défaut : ${await largeur()} px`);
  await page.screenshot({ path: path.join(OUT, 'A-1-tableau-de-bord.png') });

  await page.goto(`${ADMIN}/sites/${site.id}/contenus`);
  await panneau.getByLabel('Votre demande').fill('Remplace l’accroche par : Prenez soin de vous');
  await panneau.getByRole('button', { name: 'Envoyer à l’assistant' }).click();
  await panneau.getByText('À valider').waitFor();
  ok(await panneau.getByText('Prenez soin de vous', { exact: true }).isVisible(), 'Demande envoyée depuis le panneau, sur la page Contenus : avant / après affiché');
  await page.getByText('Phrase d\'accroche').waitFor();
  await page.screenshot({ path: path.join(OUT, 'A-2-panneau-sur-contenus.png') });

  await page.getByRole('button', { name: 'Agrandir le panneau de l’assistant' }).click();
  ok(Math.abs((await largeur()) - 520) <= 2, `« + » agrandit : ${await largeur()} px`);
  await page.getByRole('button', { name: 'Agrandir le panneau de l’assistant' }).click();
  ok(Math.abs((await largeur()) - 760) <= 2, `« + » agrandit encore : ${await largeur()} px`);
  await page.screenshot({ path: path.join(OUT, 'A-3-panneau-agrandi.png') });
  // Bord à tirer à la souris.
  const b = await panneau.boundingBox();
  await page.mouse.move(b.x, b.y + 300);
  await page.mouse.down();
  await page.mouse.move(b.x + 160, b.y + 300, { steps: 8 });
  await page.mouse.up();
  const reglee = await largeur();
  ok(Math.abs(reglee - 600) <= 4, `Bord tiré à la souris : ${reglee} px`);
  await page.reload();
  await panneau.waitFor();
  ok(Math.abs((await largeur()) - reglee) <= 2, 'Taille réglée à la main retrouvée après rechargement');
  await page.getByRole('button', { name: 'Réduire le panneau de l’assistant' }).click();
  ok((await panneau.getAttribute('data-panneau-assistant')) === 'reduit' && (await largeur()) <= 46, '« − » réduit complètement : il reste une fine barre');
  await page.reload();
  await panneau.waitFor();
  ok((await panneau.getAttribute('data-panneau-assistant')) === 'reduit', 'État réduit retenu après rechargement');
  const contenuAvantPanneau = async () => {
    await page.waitForTimeout(400); // fin de l'animation de largeur du contenu
    const c = await page.locator('main > *').first().boundingBox();
    const p = await panneau.boundingBox();
    return c.x + c.width <= p.x + 1;
  };
  ok(await contenuAvantPanneau(), 'Panneau réduit : le contenu de la page s’arrête avant la barre');
  await page.screenshot({ path: path.join(OUT, 'A-4-panneau-reduit.png') });
  await page.getByRole('button', { name: 'Agrandir le panneau de l’assistant' }).click();
  ok(Math.abs((await largeur()) - reglee) <= 2, '« + » rouvre le panneau à la taille réglée');
  ok(await contenuAvantPanneau(), 'Panneau ouvert : le contenu de la page n’est jamais caché dessous');
  await page.goto(`${ADMIN}/reglages`);
  await page.locator('main').getByText('Assistant IA').waitFor();
  ok(await contenuAvantPanneau(), 'Réglages de la plateforme : le contenu s’arrête avant le panneau ouvert');
  const sw = await page.locator('main').getByText('Autoriser').first().boundingBox();
  const pb = await panneau.boundingBox();
  ok(sw.x + sw.width <= pb.x, `L’interrupteur « Autoriser » reste visible à gauche du panneau (${Math.round(sw.x + sw.width)} ≤ ${Math.round(pb.x)})`);
  const inter = page.locator('main').getByRole('switch', { name: 'Autoriser' }).first();
  const avant = await inter.isChecked();
  await inter.click({ force: true });
  ok((await inter.isChecked()) !== avant, 'Un clic sur « Autoriser » fonctionne, panneau ouvert');
  await page.screenshot({ path: path.join(OUT, 'A-7-reglages-avec-panneau.png') });

  // Téléphone.
  const tel = await browser.newContext({ ...devices['iPhone 13'], locale: 'fr-FR' });
  await tel.addCookies(await ctx.cookies());
  const m = await tel.newPage();
  m.on('pageerror', (e) => erreurs.push(e.message));
  const pm = m.locator('aside[aria-label="Assistant"]');
  await m.goto(`${ADMIN}/sites/${site.id}`);
  await pm.waitFor();
  ok((await pm.getAttribute('data-panneau-assistant')) === 'reduit', 'Téléphone : barre « Assistant » en bas, réduite par défaut');
  ok(!(await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'Téléphone : pas de défilement horizontal');
  await m.screenshot({ path: path.join(OUT, 'A-5-telephone-reduit.png') });
  await m.getByRole('button', { name: 'Agrandir le panneau de l’assistant' }).click();
  const hauteur = async () => Math.round((await pm.boundingBox()).height);
  const vh = m.viewportSize().height;
  ok(Math.abs((await hauteur()) - Math.round(vh * 0.4)) <= 3, `Téléphone : « + » ouvre à 40 % de l’écran (${await hauteur()} px)`);
  await m.getByRole('button', { name: 'Agrandir le panneau de l’assistant' }).click();
  ok(Math.abs((await hauteur()) - Math.round(vh * 0.7)) <= 3, `Téléphone : « + » agrandit à 70 % (${await hauteur()} px)`);
  await m.screenshot({ path: path.join(OUT, 'A-6-telephone-ouvert.png') });
  await m.reload();
  await pm.waitFor();
  ok(Math.abs((await hauteur()) - Math.round(vh * 0.7)) <= 3, 'Téléphone : hauteur retenue après rechargement');
  ok(erreurs.length === 0, `Aucune erreur JavaScript (${erreurs.join(' | ')})`);
} catch (e) {
  console.log('✘ Parcours interrompu :', e.message);
  echecs++;
} finally {
  await browser.close();
  server.kill('SIGTERM');
  local.close();
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(echecs ? 1 : 0);
