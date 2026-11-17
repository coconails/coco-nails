// Assistant, améliorations, dans Chromium : question de précision et réponse, annulation d'une modification acceptée,
// dictée vocale (reconnaissance vocale SIMULÉE dans la page : aucun micro, aucun service), banc qui apprend.
// Un FAUX modèle local. Lancement : npm run build && node e2e/assistant-plus.mjs
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
const P = { admin: 18810, preview: 18811, sites: 18812 };
const ADMIN = `http://localhost:${P.admin}`;
const MDP = 'une phrase de passe solide';
const totp = (s, d = 0) => new TOTP({ secret: Secret.fromBase32(s), digits: 6, period: 30 }).generate({ timestamp: Date.now() + d * 30_000 });
const tmp = fs.mkdtempSync(path.join(process.env.MANUEL_TMP ?? os.tmpdir(), 'paginity-plus-'));
let echecs = 0;
const ok = (c, t) => {
  console.log(`${c ? '✔' : '✘'} ${t}`);
  if (!c) echecs++;
};

/** Faux modèle : pose une question si la demande n'a pas de réponse, sinon change l'accroche. */
const modele = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    if (req.url.endsWith('/models')) return res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
    const u = JSON.parse(b).messages[1].content;
    const site = JSON.parse(u.split('<contenus>\n')[1].split('\n</contenus>')[0]).find((r) => r.rubrique === 'site').valeur;
    const reponse = /Réponse : (.*)/.exec(u)?.[1];
    const rep = reponse
      ? { statut: 'proposition', changements: [{ rubrique: 'site', valeur_json: JSON.stringify({ ...site, accroche: reponse }) }], explication: `Accroche remplacée par « ${reponse} ».`, raison: '' }
      : { statut: 'question', changements: [], explication: '', raison: 'Quel texte voulez-vous pour la nouvelle accroche ?' };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(rep) } }] }));
  });
});
await new Promise((r) => modele.listen(0, '127.0.0.1', r));

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
  ok((await ctx.request.put(`${ADMIN}/api/reglages/ia`, { data: { active: true, dictee: true, locaux: [{ nom: 'Qwen3', actif: true, url: `http://127.0.0.1:${modele.address().port}/v1`, modele: 'qwen3' }] }, headers: h })).ok(), 'Assistant activé avec un modèle local (simulé) et la dictée');
  // Reconnaissance vocale simulée : « parler » renvoie toujours la même phrase.
  await ctx.addInitScript(() => {
    window.SpeechRecognition = class {
      start() {
        setTimeout(() => {
          this.onresult?.({ results: [[{ transcript: 'change l’accroche du site' }]] });
          this.onend?.();
        }, 200);
      }
      stop() {
        this.onend?.();
      }
    };
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => erreurs.push(e.message));
  page.on('dialog', (d) => d.accept());
  const main = page.locator('main');
  const capture = async (nom, opts = {}) => {
    for (const b of await page.locator('.mantine-Notification-closeButton').all()) await b.click().catch(() => {});
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(OUT, nom), ...opts });
  };
  await page.goto(`${ADMIN}/sites/${site.id}/assistant`);
  // 1. Dictée.
  await main.getByRole('button', { name: 'Dicter' }).click();
  await page.waitForFunction(() => document.querySelector('main textarea')?.value === 'change l’accroche du site');
  ok(true, 'Dictée : le texte dicté arrive dans la demande (reconnaissance vocale simulée)');
  await capture('E5-1-dictee.png');
  // 2. Question de précision.
  await main.getByRole('button', { name: 'Envoyer à l’assistant' }).click();
  await main.getByText('L’assistant a besoin d’une précision').waitFor();
  ok(await main.getByText('Quel texte voulez-vous pour la nouvelle accroche ?', { exact: true }).isVisible(), 'L’IA pose une question au lieu de deviner');
  await main.getByLabel('Votre réponse').fill('Ongles soignés, sur rendez-vous');
  await capture('E5-2-question.png');
  await main.getByRole('button', { name: 'Répondre' }).click();
  await main.getByText('À valider').waitFor();
  ok(await main.getByRole('cell', { name: 'Ongles soignés, sur rendez-vous' }).isVisible(), 'Après la réponse, la demande repart et la proposition arrive');
  // 3. Accepter puis annuler.
  await main.getByRole('button', { name: 'Accepter (brouillon)' }).click();
  await main.getByRole('button', { name: 'Annuler cette modification' }).waitFor();
  await capture('E5-3-acceptee-annulable.png');
  await main.getByRole('button', { name: 'Annuler cette modification' }).click();
  await page.getByText('Modification annulée : le brouillon est revenu comme avant.').first().waitFor();
  const contenu = await (await ctx.request.get(`${ADMIN}/api/sites/${site.id}/contenus/site`)).json();
  ok(contenu.valeur.accroche === 'Bienvenue ! Présentez votre activité en une phrase.', 'Annulation : l’accroche est revenue comme avant');
  ok(await main.getByText('Annulée', { exact: true }).isVisible(), 'La proposition est marquée « Annulée »');
  // 4. Le banc retient les demandes acceptées (celle annulée est oubliée) : on en accepte une autre.
  await main.getByLabel('Votre demande').fill('Change l’accroche');
  await main.getByRole('button', { name: 'Envoyer à l’assistant' }).click();
  await main.getByLabel('Votre réponse').first().fill('Votre beauté, notre passion');
  await main.getByRole('button', { name: 'Répondre' }).first().click();
  await main.getByRole('button', { name: 'Accepter (brouillon)' }).click();
  await main.getByRole('button', { name: 'Annuler cette modification' }).first().waitFor();
  await page.goto(`${ADMIN}/reglages`);
  const banc = main.locator('[data-section="banc"]');
  await banc.waitFor();
  ok(await banc.getByText(/Dont 1 de vos vraies demandes acceptées/).isVisible(), 'Banc d’essai : 1 vraie demande retenue (l’annulée a été oubliée)');
  await banc.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 76));
  await capture('E5-4-banc-reelles.png');
  ok(erreurs.length === 0, `Aucune erreur JavaScript (${erreurs.join(' | ')})`);
} catch (e) {
  console.log('✘ Parcours interrompu :', e.message);
  echecs++;
} finally {
  await browser.close();
  server.kill('SIGTERM');
  modele.close();
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(echecs ? 1 : 0);
