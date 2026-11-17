// Étape C — salle de réunion dans Chromium : réglages (activer, participants, vérificateur par domaine), demande,
// vérificateur final désigné, propositions des autres IA visibles. Trois FAUX modèles locaux (GLM, Qwen3-Coder, Kimi).
// Lancement : npm run build && node e2e/reunion.mjs
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
const P = { admin: 18780, preview: 18781, sites: 18782 };
const ADMIN = `http://localhost:${P.admin}`;
const MDP = 'une phrase de passe solide';
const totp = (s, d = 0) => new TOTP({ secret: Secret.fromBase32(s), digits: 6, period: 30 }).generate({ timestamp: Date.now() + d * 30_000 });
const tmp = fs.mkdtempSync(path.join(process.env.MANUEL_TMP ?? os.tmpdir(), 'paginity-reunion-'));
let echecs = 0;
const ok = (c, t) => {
  console.log(`${c ? '✔' : '✘'} ${t}`);
  if (!c) echecs++;
};

/** Faux modèle : `role(site, estVerificateur)` renvoie la proposition. */
async function fauxModele(role) {
  const appels = [];
  const s = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      if (req.url.endsWith('/models')) return res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
      const u = JSON.parse(b).messages[1].content;
      const verif = u.includes('<propositions>');
      appels.push(verif ? 'vérification' : 'proposition');
      const site = JSON.parse(u.split('<contenus>\n')[1].split('\n</contenus>')[0]).find((r) => r.rubrique === 'site').valeur;
      const rep = role(site, verif);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(rep) } }] }));
    });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { s, port: s.address().port, appels };
}
const prop = (site, champs, explication) => ({ statut: 'proposition', changements: [{ rubrique: 'site', valeur_json: JSON.stringify({ ...site, ...champs }) }], explication, raison: '' });
const glm = await fauxModele((site) => prop(site, { nom: '' }, 'J’ai aussi vidé le nom (erreur volontaire).'));
const qwen = await fauxModele((site) => prop(site, { accroche: 'Ongles soignés, sur rendez-vous' }, 'Accroche plus courte.'));
const kimi = await fauxModele((site, verif) =>
  verif ? prop(site, { accroche: 'Ongles soignés, sur rendez-vous à Saint-Jean' }, 'J’ai retenu la proposition A et ajouté le lieu.') : prop(site, { accroche: 'Kimi seule' }, 'x'),
);

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
  const locaux = [
    ['GLM', glm.port],
    ['Qwen3-Coder', qwen.port],
    ['Kimi', kimi.port],
  ].map(([nom, port]) => ({ nom, actif: true, url: `http://127.0.0.1:${port}/v1`, modele: nom.toLowerCase() }));
  ok((await ctx.request.put(`${ADMIN}/api/reglages/ia`, { data: { active: true, locaux }, headers: h })).ok(), 'Trois modèles locaux déclarés (simulés)');

  const page = await ctx.newPage();
  page.on('pageerror', (e) => erreurs.push(e.message));
  const main = page.locator('main');
  // 1. Réglages : activer la réunion et désigner Kimi pour les données.
  await page.goto(`${ADMIN}/reglages`);
  const reunion = main.locator('[data-section="reunion"]');
  await reunion.waitFor();
  await reunion.getByRole('switch', { name: 'Activer' }).click({ force: true });
  await reunion.getByLabel('Vérificateur final — Données').click();
  await page.getByRole('option', { name: 'Kimi' }).click();
  await main.getByRole('button', { name: 'Enregistrer les réglages de l’assistant' }).click();
  await page.getByText('Réglages de l’assistant enregistrés.').first().waitFor();
  const reg = await (await ctx.request.get(`${ADMIN}/api/reglages/ia`)).json();
  ok(reg.reglages.reunion.active === true && reg.reglages.reunion.verificateurs.donnees === reg.reglages.locaux[2].id.replace(/^/, 'local:'), 'Réunion activée et Kimi désigné vérificateur des « Données » depuis l’écran');
  ok(await reunion.getByRole('cell', { name: 'Qwen3-Coder' }).isVisible(), 'Tableau des notes par domaine affiché');
  await reunion.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'C-1-reglages-reunion.png') });

  // 2. Demande « données » : un tour par IA, Kimi vérifie en dernier.
  await page.goto(`${ADMIN}/sites/${site.id}/assistant`);
  const choix = main.getByLabel('Domaine', { exact: true });
  await choix.waitFor();
  await choix.click();
  ok((await page.getByRole('option').allTextContents()).join() === 'Automatique,Textes,Données', 'Choix du domaine proposé (Automatique / Textes / Données)');
  await page.getByRole('option', { name: 'Données' }).click();
  await main.getByLabel('Votre demande').fill('Ajoute « Saint-Jean » et la mention sur rendez-vous dans l’accroche, ouverte le lundi');
  await main.getByRole('button', { name: 'Envoyer à l’assistant' }).click();
  await main.getByText('À valider').waitFor();
  ok(await main.getByText(/domaine données \(choisi par vous\).*vérificateur final : Kimi \(désigné dans les réglages\)/).isVisible(), 'Vérificateur final : Kimi, désigné pour les données');
  ok(await main.getByRole('cell', { name: 'Ongles soignés, sur rendez-vous à Saint-Jean' }).isVisible(), 'Version finale de Kimi affichée en avant / après');
  ok(glm.appels.join() === 'proposition' && qwen.appels.join() === 'proposition' && kimi.appels.join() === 'vérification', 'Un seul tour par IA : GLM et Qwen proposent, Kimi vérifie');
  await main.getByText('Propositions des autres IA (2)').click();
  await main.getByText('refusée par les vérifications', { exact: true }).waitFor();
  ok(await main.getByText('valable', { exact: true }).isVisible(), 'Propositions des autres IA visibles, avec leur statut (valable / refusée)');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'C-2-proposition-reunion.png'), fullPage: true });
  await main.getByRole('button', { name: 'Accepter (brouillon)' }).click();
  await main.getByText('Acceptée (brouillon)').waitFor();
  const notes = (await (await ctx.request.get(`${ADMIN}/api/reglages/ia`)).json()).notes.donnees;
  ok(notes[`local:${reg.reglages.locaux[2].id}`]?.acceptes === 1, 'Votre accord est compté dans la note de Kimi (données)');
  ok(erreurs.length === 0, `Aucune erreur JavaScript (${erreurs.join(' | ')})`);
} catch (e) {
  console.log('✘ Parcours interrompu :', e.message);
  echecs++;
} finally {
  await browser.close();
  server.kill('SIGTERM');
  for (const x of [glm, qwen, kimi]) x.s.close();
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(echecs ? 1 : 0);
