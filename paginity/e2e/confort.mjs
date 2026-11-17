// Confort, dans Chromium : compteur de visites (site publié, visites simulées), aperçu téléphone avant publication,
// failles connues (registre npm SIMULÉ), notifications (carte et service worker ; l'abonnement réel nécessite le
// service de notification du navigateur, non joignable ici). Lancement : npm run build && node e2e/confort.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TOTP, Secret } from 'otpauth';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.dirname(new URL(import.meta.url).pathname);
const OUT = process.env.CAPTURES_IA ?? path.join(root, 'captures');
fs.mkdirSync(OUT, { recursive: true });
const P = { admin: 18820, preview: 18821, sites: 18822 };
const ADMIN = `http://localhost:${P.admin}`;
const MDP = 'une phrase de passe solide';
const totp = (s, d = 0) => new TOTP({ secret: Secret.fromBase32(s), digits: 6, period: 30 }).generate({ timestamp: Date.now() + d * 30_000 });
const tmp = fs.mkdtempSync(path.join(process.env.MANUEL_TMP ?? os.tmpdir(), 'paginity-confort-'));
let echecs = 0;
const ok = (c, t) => {
  console.log(`${c ? '✔' : '✘'} ${t}`);
  if (!c) echecs++;
};


// Faux registre npm : une faille « moyenne » sur fastify.
const registre = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ fastify: [{ title: 'Exemple de faille (simulée)', severity: 'moderate', url: 'https://exemple.org/avis' }] })));
});
await new Promise((r) => registre.listen(0, '127.0.0.1', r));

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, '..', 'server', 'dist', 'index.js')], {
  env: { ...process.env, PAGINITY_DATA_DIR: path.join(tmp, 'donnees'), PAGINITY_ADMIN_PORT: String(P.admin), PAGINITY_PREVIEW_PORT: String(P.preview), PAGINITY_SITES_PORT: String(P.sites), PAGINITY_PUBLIC_URL: ADMIN, PAGINITY_ISOLATION: 'processus', PAGINITY_REGISTRE_URL: `http://127.0.0.1:${registre.address().port}` },
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
  const capture = async (loc, nom) => {
    for (const b of await page.locator('.mantine-Notification-closeButton').all()) await b.click().catch(() => {});
    await page.setViewportSize({ width: 1440, height: 1250 });
    await loc.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 76));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, nom) });
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  // Publication, puis visites (navigateur simulé) sur le site en ligne.
  const pub = await (await ctx.request.post(`${ADMIN}/api/sites/${site.id}/publier`, { data: {}, headers: h })).json();
  for (let i = 0; i < 60; i++) {
    const j = await (await ctx.request.get(`${ADMIN}/api/activites/${pub.id}`)).json();
    if (['reussie', 'echouee'].includes(j.etat)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const visiter = (chemin) => new Promise((res) => http.get({ host: '127.0.0.1', port: P.sites, path: chemin, headers: { host: `${site.slug}.localhost`, 'user-agent': 'Mozilla/5.0 Safari/604.1', accept: 'text/html' } }, (r) => { r.resume(); r.on('end', res); }));
  for (let i = 0; i < 7; i++) await visiter('/');
  await visiter('/404-inexistante');
  await new Promise((r) => setTimeout(r, 200));
  await page.goto(`${ADMIN}/sites/${site.id}`);
  const vis = main.locator('[data-section="visites"]');
  await vis.getByText('pages vues en 30 jours').waitFor();
  const tot = (await (await ctx.request.get(`${ADMIN}/api/sites/${site.id}/visites`)).json()).total;
  ok(tot === 7 && (await vis.getByText('7', { exact: true }).first().isVisible()), 'Visites : 7 pages vues comptées (la page introuvable ne compte pas)');
  await capture(vis, 'E7-1-visites.png');
  // Aperçu téléphone avant publication.
  await page.goto(`${ADMIN}/sites/${site.id}/publier`);
  const tel = main.locator('[data-section="apercu-telephone"]');
  await tel.getByRole('button', { name: 'Afficher' }).click();
  await page.frameLocator('iframe[title="Aperçu sur téléphone"]').locator('h1').waitFor({ timeout: 30000 });
  ok(true, 'Aperçu téléphone du brouillon affiché sur la page Publier');
  await capture(tel, 'E7-2-apercu-telephone.png');
  // Failles connues.
  await page.goto(`${ADMIN}/reglages`);
  const maj = main.locator('[data-section="mises-a-jour"]');
  await maj.getByRole('button', { name: 'Vérifier maintenant' }).click();
  await maj.getByText('Exemple de faille (simulée)').waitFor();
  ok(await maj.getByText('moyenne').isVisible(), 'Failles connues : faille simulée listée avec sa gravité');
  await capture(maj, 'E7-3-failles.png');
  // Notifications.
  await page.goto(`${ADMIN}/profil`);
  const notif = main.locator('[data-section="notifications"]');
  await notif.waitFor();
  ok(await notif.getByRole('button', { name: 'Activer sur cet appareil', exact: true }).isVisible(), 'Carte « Notifications sur le téléphone » dans le profil');
  const sw = await ctx.request.get(`${ADMIN}/sw.js`);
  ok(sw.ok() && /javascript/.test(sw.headers()['content-type'] ?? '') && (await sw.text()).includes("addEventListener('push'"), 'Service worker des notifications servi par PAGINITY');
  await capture(notif, 'E7-4-notifications.png');
  ok(erreurs.length === 0, `Aucune erreur JavaScript (${erreurs.join(' | ')})`);
} catch (e) {
  console.log('✘ Parcours interrompu :', e.message);
  echecs++;
} finally {
  await browser.close();
  server.kill('SIGTERM');
  registre.close();
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(echecs ? 1 : 0);
