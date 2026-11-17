// M2 — Search Console en lecture seule, dans Chromium, face à un FAUX Google (aucune connexion réelle) :
// envoi de la clé, propriétés, liaison du site, relevé, rapport, graphiques, inspection, IndexNow.
// Lancement : npm run build && node e2e/search-console.mjs
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
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
const P = { admin: 18840, preview: 18841, sites: 18842 };
const ADMIN = `http://localhost:${P.admin}`;
const MDP = 'une phrase de passe solide';
const totp = (s, d = 0) => new TOTP({ secret: Secret.fromBase32(s), digits: 6, period: 30 }).generate({ timestamp: Date.now() + d * 30_000 });
const tmp = fs.mkdtempSync(path.join(process.env.MANUEL_TMP ?? os.tmpdir(), 'paginity-gsc-'));
let echecs = 0;
const ok = (c, t) => {
  console.log(`${c ? '✔' : '✘'} ${t}`);
  if (!c) echecs++;
};


// Faux Google : jeton (signature vérifiée), propriétés, statistiques, inspection.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const cleFichier = path.join(tmp, 'paginity-seo-cle.json');
fs.writeFileSync(cleFichier, JSON.stringify({ type: 'service_account', project_id: 'essai', client_email: 'paginity-seo@essai.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
const portees = [];
const jourISO = (t) => new Date(t).toISOString().slice(0, 10);
function analyse(c) {
  const jours = [];
  for (let t = Date.parse(`${c.startDate}T12:00:00Z`); t <= Date.parse(`${c.endDate}T12:00:00Z`); t += 86_400_000) jours.push(jourISO(t));
  const v = (j) => { const n = Number(j.slice(-2)); return { clicks: n % 3 === 0 ? 2 : n % 2, impressions: 4 + (n % 7) + (new Date(`${j}T12:00:00Z`).getUTCDay() === 6 ? 6 : 0) }; };
  if (c.dimensions?.[0] === 'date') return jours.map((j) => ({ keys: [j], ...v(j), ctr: 0, position: 7 }));
  if (c.dimensions?.[0] === 'query') return [
    { keys: ['coco nails'], clicks: 14, impressions: 61, ctr: 0.23, position: 1.3 },
    { keys: ['prothésiste ongulaire saint-jean-du-bois'], clicks: 6, impressions: 48, ctr: 0.125, position: 2.1 },
    { keys: ['pose gel la suze sur sarthe'], clicks: 0, impressions: 37, ctr: 0, position: 8.6 },
    { keys: ['manucure noyen sur sarthe'], clicks: 1, impressions: 22, ctr: 0.045, position: 11.4 },
  ];
  if (c.dimensions?.[0] === 'page') return [{ keys: ['https://salon-demo.fr/'], clicks: 21, impressions: 168, ctr: 0.125, position: 4.8 }];
  const s = jours.reduce((a, j) => ({ clicks: a.clicks + v(j).clicks, impressions: a.impressions + v(j).impressions }), { clicks: 0, impressions: 0 });
  return [{ ...s, ctr: s.clicks / s.impressions, position: 6.4 }];
}
const google = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const json = (code, o) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    if (req.url === '/token') {
      const [h, charge, sig] = (new URLSearchParams(b).get('assertion') ?? '').split('.');
      const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${charge}`), publicKey, Buffer.from(sig ?? '', 'base64url'));
      const claims = JSON.parse(Buffer.from(charge, 'base64url').toString());
      portees.push(claims);
      return ok ? json(200, { access_token: 'jeton', expires_in: 3600 }) : json(400, { error: 'invalid_grant' });
    }
    if (req.headers.authorization !== 'Bearer jeton') return json(401, {});
    if (req.url === '/webmasters/v3/sites') return json(200, { siteEntry: [{ siteUrl: 'sc-domain:salon-demo.fr', permissionLevel: 'siteRestrictedUser' }] });
    if (/searchAnalytics\/query$/.test(req.url)) return json(200, { rows: analyse(JSON.parse(b)) });
    if (req.url === '/v1/urlInspection/index:inspect') return json(200, { inspectionResult: { indexStatusResult: { verdict: 'PASS', coverageState: 'Envoyée et indexée', lastCrawlTime: new Date(Date.now() - 5 * 86_400_000).toISOString() } } });
    json(404, {});
  });
});
await new Promise((r) => google.listen(0, '127.0.0.1', r));
const G = `http://127.0.0.1:${google.address().port}`;

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, '..', 'server', 'dist', 'index.js')], {
  env: { ...process.env, PAGINITY_DATA_DIR: path.join(tmp, 'donnees'), PAGINITY_ADMIN_PORT: String(P.admin), PAGINITY_PREVIEW_PORT: String(P.preview), PAGINITY_SITES_PORT: String(P.sites), PAGINITY_PUBLIC_URL: ADMIN, PAGINITY_ISOLATION: 'processus', PAGINITY_GOOGLE_TOKEN_URL: `${G}/token`, PAGINITY_GOOGLE_API_URL: G, PAGINITY_GOOGLE_INSPECTION_URL: G },
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
    await page.setViewportSize({ width: 1440, height: 1250 });
    if (loc) await loc.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 76));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, nom) });
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  // 1. Connexion dans les Réglages de la plateforme.
  await page.goto(`${ADMIN}/reglages`);
  const carte = main.locator('[data-section="search-console"]');
  await carte.waitFor();
  await capture('M2-1-connexion-guide.png', carte);
  await carte.getByLabel('Fichier de clé du compte de service').setInputFiles(cleFichier);
  await page.getByText('Search Console connecté (lecture seule).').first().waitFor();
  ok(await carte.getByText('sc-domain:salon-demo.fr').isVisible(), 'Clé envoyée, vérifiée auprès de Google (simulé) ; propriété accessible listée');
  ok(portees.at(-1).scope === 'https://www.googleapis.com/auth/webmasters.readonly' && portees.at(-1).sub === undefined, 'Accès demandé : lecture Search Console uniquement, sans représenter aucun utilisateur');
  await capture('M2-2-connecte.png', carte);
  // 2. Liaison et relevé sur la page Référencement.
  await page.goto(`${ADMIN}/sites/${site.id}/referencement`);
  const g = main.locator('[data-section="google"]');
  await g.getByLabel('Propriété Search Console de ce site').click();
  await page.getByRole('option', { name: 'sc-domain:salon-demo.fr' }).click();
  await g.getByRole('button', { name: 'Relier' }).click();
  await g.getByRole('button', { name: 'Actualiser les chiffres' }).click();
  await g.locator('[data-rapport]').waitFor({ timeout: 30000 });
  ok(await g.getByText(/Position moyenne : 6,4\. C’est une moyenne/).isVisible(), 'Rapport en français : position présentée comme une moyenne');
  ok(await g.getByText(/« pose gel la suze sur sarthe » : vu 37 fois/).isVisible(), 'Piste repérée : recherche souvent vue mais peu cliquée');
  await g.getByRole('button', { name: 'Vérifier l’indexation' }).click();
  await g.getByText('Envoyée et indexée').waitFor();
  ok(true, 'Inspection de l’indexation affichée');
  await capture('M2-3-rapport.png', g);
  await capture('M2-4-graphiques-tableaux.png', g.getByText('Apparitions par jour'));
  ok(await g.getByText('Prévenir Bing et les moteurs IndexNow après chaque publication').isVisible(), 'Option IndexNow proposée (désactivée par défaut)');
  ok(erreurs.length === 0, `Aucune erreur JavaScript (${erreurs.join(' | ')})`);
} catch (e) {
  console.log('✘ Parcours interrompu :', e.message);
  echecs++;
} finally {
  await browser.close();
  server.kill('SIGTERM');
  google.close();
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(echecs ? 1 : 0);
