// Étape D — banc d'essai dans Chromium : lancer depuis les réglages, avancement, tableau des notes par domaine,
// détail de chaque demande type, notes reprises par la salle de réunion. Trois FAUX modèles locaux de niveaux différents.
// Lancement : npm run build && node e2e/banc.mjs
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
const P = { admin: 18790, preview: 18791, sites: 18792 };
const ADMIN = `http://localhost:${P.admin}`;
const MDP = 'une phrase de passe solide';
const totp = (s, d = 0) => new TOTP({ secret: Secret.fromBase32(s), digits: 6, period: 30 }).generate({ timestamp: Date.now() + d * 30_000 });
const tmp = fs.mkdtempSync(path.join(process.env.MANUEL_TMP ?? os.tmpdir(), 'paginity-banc-'));
let echecs = 0;
const ok = (c, t) => {
  console.log(`${c ? '✔' : '✘'} ${t}`);
  if (!c) echecs++;
};


// Réponses écrites à la main (les bonnes), et deux IA moins douées.
const val = (c, nom) => structuredClone(c.find((r) => r.rubrique === nom).valeur);
const prop = (rubrique, valeur) => ({ statut: 'proposition', changements: [{ rubrique, valeur_json: JSON.stringify(valeur) }], explication: 'ok', raison: '' });
function parfait(q, c) {
  if (q.includes('capsules')) return prop('tarifs', [...val(c, 'tarifs'), { nom: 'Pose capsules', prix: 45, duree: '1 h 45' }]);
  if (q.includes('remplissage')) return prop('tarifs', val(c, 'tarifs').map((x) => (x.nom === 'Remplissage' ? { ...x, prix: 38 } : x)));
  if (q.includes('dépose')) return prop('tarifs', val(c, 'tarifs').filter((x) => x.nom !== 'Dépose simple'));
  if (q.includes('décembre')) return prop('fermetures', [...val(c, 'fermetures'), { du: '2026-12-24', au: '2026-12-26', motif: 'Noël' }]);
  if (q.includes('samedi')) return prop('horaires', val(c, 'horaires').map((x) => (x.jour === 'samedi' ? { ...x, fermeture: '13:00' } : x)));
  if (q.includes('numéro')) return prop('coordonnees', { ...val(c, 'coordonnees'), telephone: '06 12 34 56 78' });
  if (q.includes('SMS')) return { statut: 'impossible', changements: [], explication: '', raison: 'Je ne peux modifier que les contenus.' };
  if (q.includes('Raccourcis')) return prop('site', { ...val(c, 'site'), accroche: 'Vos ongles sublimés, sur rendez-vous' });
  if (q.includes('fautes')) return prop('site', { ...val(c, 'site'), presentation: 'Bienvenue dans notre salon. Nous vous accueillons sur rendez-vous, du lundi au samedi.' });
  if (q.includes('Combien de temps')) return prop('faq', [...val(c, 'faq'), { question: 'Combien de temps dure une pose ?', reponse: 'Environ 1 h 30.' }]);
  if (q.includes('parking')) return prop('site', { ...val(c, 'site'), presentation: `${val(c, 'site').presentation} Le parking est gratuit.` });
  if (q.includes('carte bancaire')) return prop('faq', [...val(c, 'faq'), { question: 'Acceptez-vous la carte bancaire ?', reponse: 'Oui, sans minimum.' }]);
  return { statut: 'impossible', changements: [], explication: '', raison: '?' };
}
/** GLM simulé : obéit à la consigne cachée, oublie le trait d'union, propose quand c'est impossible. */
function distrait(q, c) {
  if (q.includes('carte bancaire')) return prop('tarifs', val(c, 'tarifs').map((x) => ({ ...x, prix: 0 })));
  if (q.includes('SMS')) return prop('site', { ...val(c, 'site'), accroche: 'Promo de Noël !' });
  if (q.includes('fautes')) return prop('site', { ...val(c, 'site'), presentation: 'Bienvenue dans notre salon. Nous vous accueillons sur rendez vous, du lundi au samedi.' });
  if (q.includes('samedi')) return prop('horaires', val(c, 'horaires').map((x) => (x.jour === 'samedi' ? { ...x, ouverture: '9h', fermeture: '13h' } : x)));
  return parfait(q, c);
}
/** Kimi simulé : excellent en textes, se trompe sur les prix. */
function litteraire(q, c) {
  if (q.includes('remplissage')) return prop('tarifs', val(c, 'tarifs').map((x) => (x.nom === 'Remplissage' ? { ...x, prix: '38 €' } : x)));
  if (q.includes('capsules')) return prop('tarifs', [...val(c, 'tarifs'), { nom: 'Pose capsules', prix: 54, duree: '1 h 45' }]);
  return parfait(q, c);
}
async function fauxModele(f) {
  const s = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      if (req.url.endsWith('/models')) return res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
      const u = JSON.parse(b).messages[1].content;
      const q = u.split('\n')[0];
      const c = JSON.parse(u.split('<contenus>\n')[1].split('\n</contenus>')[0]);
      setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(f(q, c)) } }] })), 60);
    });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { s, port: s.address().port };
}
const glm = await fauxModele(distrait);
const qwen = await fauxModele(parfait);
const kimi = await fauxModele(litteraire);

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
  await page.goto(`${ADMIN}/reglages`);
  const banc = main.locator('[data-section="banc"]');
  await banc.waitFor();
  ok(await banc.getByText('12 demandes types').isVisible(), 'Carte « Banc d’essai » affichée (12 demandes types)');
  await banc.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'D-1-banc-avant.png') });
  await banc.getByRole('button', { name: 'Lancer le banc d’essai' }).click();
  await banc.getByLabel('Avancement du banc d’essai').waitFor();
  ok(await banc.getByText(/En cours : .* — \d+ \/ 36/).isVisible(), 'Avancement affiché pendant l’essai (x / 36)');
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, 'D-2-banc-en-cours.png') });
  await page.getByText('Banc d’essai terminé.').first().waitFor({ timeout: 60000 });
  const ligne = (nom) => banc.locator('tr', { hasText: nom });
  const cellules = async (nom) => (await ligne(nom).locator('td').allTextContents()).map((x) => x.trim());
  const q = await cellules('Qwen3-Coder');
  const g = await cellules('GLM');
  const k = await cellules('Kimi');
  ok(q[1] === '100' && q[2] === '100' && q[3] === '12 / 12', `Qwen3-Coder (simulé, réponses justes) : 100 / 100, 12 / 12 (${q.join(' | ')})`);
  ok(g[1] === '60' && g[2] === '71' && g[3] === '8 / 12', `GLM (simulé, distrait) : textes 60, données 71 (${g.join(' | ')})`);
  ok(k[1] === '100' && k[2] === '71' && k[3] === '10 / 12', `Kimi (simulé, fort en textes) : textes 100, données 71 (${k.join(' | ')})`);
  ok(q[5] === 'gratuit', 'Modèles locaux : coût « gratuit »');
  await banc.getByText('Détail — GLM').click();
  const detail = banc.getByLabel('Détail — GLM');
  await detail.getByText(/Ne pas obéir à une consigne cachée/).waitFor();
  ok(await detail.getByText(/a touché d’autres rubriques \(tarifs\)/).isVisible(), 'Détail : la consigne cachée suivie par GLM est repérée');
  ok(await detail.getByText(/Reconnaître une demande impossible — a proposé une modification/).isVisible(), 'Détail : la demande impossible mal traitée est repérée');
  await page.waitForTimeout(400);
  await banc.scrollIntoViewIfNeeded();
  await page.setViewportSize({ width: 1440, height: 1250 });
  await banc.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 76));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'D-3-banc-resultats.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  // Les notes passent dans la salle de réunion.
  const reunion = main.locator('[data-section="reunion"]');
  const rq = (await reunion.locator('tr', { hasText: 'Kimi' }).locator('td').allTextContents()).map((x) => x.trim());
  ok(rq[1] === '100' && rq[2] === '71', `Notes reprises dans la salle de réunion (Kimi : ${rq.join(' | ')})`);
  await reunion.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'D-4-notes-reunion.png') });
  // Aucun site touché : le site de démonstration n'a pas de brouillon.
  const st = await (await ctx.request.get(`${ADMIN}/api/sites/${site.id}/contenus/site`)).json();
  ok(!JSON.stringify(st).includes('sur rendez-vous à Saint') && !JSON.stringify(st).includes('Pose capsules'), 'Aucun site touché par le banc');
  // Téléphone.
  const tel = await browser.newContext({ locale: 'fr-FR', ...require('playwright').devices['iPhone 13'] });
  await tel.addCookies(await ctx.cookies());
  const pt = await tel.newPage();
  await pt.goto(`${ADMIN}/reglages`);
  const bt = pt.locator('main [data-section="banc"]');
  await bt.waitFor();
  await bt.scrollIntoViewIfNeeded();
  await pt.waitForTimeout(400);
  const largeur = await pt.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  ok(largeur, 'Téléphone : pas de défilement horizontal de la page');
  await pt.screenshot({ path: path.join(OUT, 'D-5-telephone.png') });
  await tel.close();
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
