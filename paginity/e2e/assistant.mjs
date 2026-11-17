// Parcours « PAGINITY AI » dans Chromium : réglages de l'assistant, essai du modèle local, demande, avant/après,
// acceptation dans le brouillon, affichage téléphone. Le « modèle local » est un faux serveur (aucune IA réelle).
// Lancement : npm run build && node e2e/assistant.mjs
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
const P = { admin: 18580, preview: 18581, sites: 18582 };
const ADMIN = `http://localhost:${P.admin}`;
const MDP = 'une phrase de passe solide';
const totp = (s, d = 0) => new TOTP({ secret: Secret.fromBase32(s), digits: 6, period: 30 }).generate({ timestamp: Date.now() + d * 30_000 });
const tmp = fs.mkdtempSync(path.join(process.env.MANUEL_TMP ?? os.tmpdir(), 'paginity-ia-'));
let echecs = 0;
const ok = (cond, texte) => {
  console.log(`${cond ? '✔' : '✘'} ${texte}`);
  if (!cond) echecs++;
};

// Faux modèle local (protocole compatible OpenAI) : change l'accroche demandée.
const recus = [];
const local = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    if (req.url.endsWith('/models')) return res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
    const corps = JSON.parse(b);
    recus.push(corps);
    const u = corps.messages[1].content;
    const contenus = JSON.parse(u.split('<contenus>\n')[1].split('\n</contenus>')[0]);
    const site = contenus.find((r) => r.rubrique === 'site');
    const rep = { statut: 'proposition', changements: [{ rubrique: 'site', valeur_json: JSON.stringify({ ...site.valeur, accroche: 'Votre pause beauté, sur rendez-vous' }) }], explication: 'J’ai remplacé la phrase d’accroche.', raison: '' };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(rep) } }] }));
  });
});
await new Promise((r) => local.listen(0, '127.0.0.1', r));
const portLocal = local.address().port;
// Premier modèle de la liste : répond « je ne sais pas faire » (pour montrer le passage au suivant).
const prudent = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    if (req.url.endsWith('/models')) return res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
    const rep = { statut: 'impossible', changements: [], explication: '', raison: 'je ne suis pas sûr de la formulation' };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(rep) } }] }));
  });
});
await new Promise((r) => prudent.listen(0, '127.0.0.1', r));
const portPrudent = prudent.address().port;

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
const erreursJs = [];
try {
  const ctx = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  // Installation et site de démonstration par l'API (déjà couverts par les autres parcours).
  const etat = await (await ctx.request.get(`${ADMIN}/api/etat`)).json();
  const h = { 'x-csrf-token': etat.csrf, origin: ADMIN };
  await ctx.request.post(`${ADMIN}/api/installation`, { data: { code, nom: 'Donaven', email: 'proprietaire@exemple.fr', motDePasse: MDP }, headers: h });
  const d = await (await ctx.request.post(`${ADMIN}/api/profil/2fa/totp/debut`, { data: {}, headers: h })).json();
  await ctx.request.post(`${ADMIN}/api/profil/2fa/totp/confirmer`, { data: { code: totp(d.secret) }, headers: h });
  const site = await (await ctx.request.post(`${ADMIN}/api/sites`, { data: { nom: 'Salon Démo', modele: 'vitrine' }, headers: h })).json();

  const onglet = await ctx.newPage();
  onglet.on('pageerror', (e) => erreursJs.push(e.message));
  // Les recherches se font dans la zone de la page (le panneau permanent de l'assistant a ses propres essais : e2e/panneau.mjs).
  const zone = onglet.locator('main');
  const page = new Proxy(onglet, {
    get: (t, k) => (['getByText', 'getByLabel', 'getByRole', 'getByPlaceholder'].includes(k) ? zone[k].bind(zone) : typeof t[k] === 'function' ? t[k].bind(t) : t[k]),
  });
  // 1. Réglages de la plateforme : activer, configurer le modèle local, plafond.
  await page.goto(`${ADMIN}/reglages`);
  await page.getByText('Assistant IA').waitFor();
  // Le panneau permanent est réduit pour cet essai de l'écran des réglages (il a ses propres essais).
  await onglet.getByRole('button', { name: 'Réduire le panneau de l’assistant' }).click();
  await onglet.waitForTimeout(400);
  ok(await page.getByText('Désactivé').isVisible(), 'Assistant désactivé par défaut');
  // Deux modèles locaux ajoutés depuis l'écran.
  for (const [nom, port] of [['GLM', portPrudent], ['Qwen3-Coder', portLocal]]) {
    await page.getByRole('button', { name: 'Ajouter un modèle local' }).click();
    const carte = onglet.locator('main [data-modele-local=""]').last();
    await carte.getByLabel('Nom affiché').fill(nom);
    const c2 = onglet.locator(`main [data-modele-local="${nom}"]`);
    await c2.getByLabel('Nom du modèle installé').fill(nom.toLowerCase());
    await c2.getByLabel('Adresse du modèle').fill(`http://127.0.0.1:${port}/v1`);
  }
  await page.getByRole('button', { name: 'Enregistrer les réglages de l’assistant' }).click();
  // Action sensible : confirmation d'identité.
  const dlg = onglet.getByRole('dialog', { name: /Confirmez/ });
  await dlg.waitFor();
  await dlg.getByLabel(/^Mot de passe/).fill(MDP);
  await dlg.getByLabel('Code à 6 chiffres (ou code de secours)').fill(totp(d.secret, 1));
  await dlg.getByRole('button', { name: /Confirmer/ }).click();
  await onglet.getByText('Réglages de l’assistant enregistrés.').waitFor();
  await page.getByLabel('Désactivé').check({ force: true });
  await page.getByText('Activé', { exact: true }).waitFor();
  ok(true, 'Assistant activé depuis les réglages (avec confirmation d’identité)');
  await onglet.locator('main [data-modele-local="Qwen3-Coder"]').getByRole('button', { name: 'Essayer' }).click();
  ok(await onglet.getByText('Qwen3-Coder répond.').waitFor().then(() => true), 'Essai d’un modèle local précis : il répond');
  ok((await page.getByText('En service').count()) >= 2, 'Deux modèles locaux en service');
  ok(await page.getByText(/Dépensé ce mois-ci : 0,00 \$ sur 0,00 \$/).isVisible(), 'Plafond global et dépense du mois affichés (0 $ par défaut)');
  await page.screenshot({ path: path.join(OUT, 'ia-01-reglages.png'), fullPage: true });
  await onglet.locator('main [data-modele-local="GLM"]').scrollIntoViewIfNeeded();
  await onglet.mouse.wheel(0, -220);
  await onglet.waitForTimeout(300);
  await onglet.screenshot({ path: path.join(OUT, 'ia-01b-modeles-locaux.png') });

  // 2. Page Assistant du site : demande, proposition avant/après, acceptation.
  await page.goto(`${ADMIN}/sites/${site.id}/assistant`);
  await page.getByLabel('Votre demande').fill('Remplace la phrase d’accroche par : Votre pause beauté, sur rendez-vous');
  await page.getByRole('button', { name: 'Envoyer à l’assistant' }).click();
  await page.getByText('À valider').waitFor();
  ok(await page.getByText(/préparée par Qwen3-Coder · gratuit/).first().isVisible(), 'Le 1er modèle ne sait pas faire : le 2e (Qwen3-Coder) prépare la proposition, gratuitement');
  await page.getByText('Ce qui s’est passé').first().click();
  ok(await page.getByText(/GLM : « je ne sais pas faire »/).first().waitFor({ timeout: 5000 }).then(() => true, () => false), 'Le détail montre le passage d’un modèle à l’autre');
  await onglet.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'ia-02b-detail.png'), fullPage: true });
  ok(await page.getByRole('cell', { name: 'Votre pause beauté, sur rendez-vous' }).isVisible(), 'Avant / après affiché champ par champ');
  await page.screenshot({ path: path.join(OUT, 'ia-02-proposition.png'), fullPage: true });
  await page.getByRole('button', { name: 'Accepter (brouillon)' }).click();
  await page.getByText('Acceptée (brouillon)').waitFor();
  const contenu = await (await ctx.request.get(`${ADMIN}/api/sites/${site.id}/contenus/site`)).json();
  ok(contenu.valeur.accroche === 'Votre pause beauté, sur rendez-vous', 'Modification enregistrée dans le brouillon');
  ok(!JSON.stringify(recus).includes('proprietaire@exemple.fr'), 'Le modèle n’a reçu aucune donnée de compte');
  await page.screenshot({ path: path.join(OUT, 'ia-03-acceptee.png'), fullPage: true });

  // 3. Téléphone.
  const tel = await browser.newContext({ ...devices['iPhone 13'], locale: 'fr-FR' });
  await tel.addCookies(await ctx.cookies());
  const m = await tel.newPage();
  m.on('pageerror', (e) => erreursJs.push(e.message));
  await m.goto(`${ADMIN}/sites/${site.id}/assistant`);
  await m.getByText('Acceptée (brouillon)').waitFor();
  const deborde = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ok(!deborde, 'Écran Assistant sans défilement horizontal sur téléphone (format iPhone 13, moteur Chromium)');
  await m.screenshot({ path: path.join(OUT, 'ia-04-telephone.png') });
  ok(erreursJs.length === 0, `Aucune erreur JavaScript (${erreursJs.join(' | ')})`);
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
