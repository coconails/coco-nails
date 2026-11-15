// Parcours « phase 3 » dans Chromium : import réel de Coco Nail's, publication avec préparation et fonctions,
// écrans Fonctions, Secrets (avec confirmation d'identité), Formulaires, appel d'une vraie fonction.
// Lancement : npm run build && COCO_NAILS_DIR=/chemin/vers/coco-nails1 node e2e/phase3.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TOTP, Secret } from 'otpauth';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const yazl = require('yazl');

const COCO = process.env.COCO_NAILS_DIR ?? '/home/user/coco-nails1';
const root = path.dirname(new URL(import.meta.url).pathname);
const captures = process.env.CAPTURES ?? path.join(root, 'captures');
fs.mkdirSync(captures, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paginity-e2e3-'));
const P = { admin: 18180, preview: 18181, sites: 18182 };
const ADMIN = `http://localhost:${P.admin}`;
const resultats = [];
const ok = (m) => {
  resultats.push(`✔ ${m}`);
  console.log(`✔ ${m}`);
};
const assert = (c, m) => {
  if (!c) throw new Error(`Échec : ${m}`);
  ok(m);
};

// Archive ZIP du site (sans .git ni node_modules).
const zipPath = path.join(dataDir, 'coco.zip');
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
  env: {
    ...process.env,
    PAGINITY_DATA_DIR: path.join(dataDir, 'donnees'),
    PAGINITY_ADMIN_PORT: String(P.admin),
    PAGINITY_PREVIEW_PORT: String(P.preview),
    PAGINITY_SITES_PORT: String(P.sites),
    PAGINITY_PUBLIC_URL: ADMIN,
    PAGINITY_CONTAINER_NETWORK: process.env.PAGINITY_CONTAINER_NETWORK ?? 'host',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
server.stdout.on('data', (d) => (out += d));
server.stderr.on('data', (d) => process.stderr.write(d));
const code = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('Le serveur ne démarre pas')), 20000);
  const i = setInterval(() => {
    const m = out.match(/code à saisir dans le navigateur : (\w+)/);
    if (m) {
      clearInterval(i);
      clearTimeout(t);
      resolve(m[1]);
    }
  }, 100);
});

const browser = await chromium.launch();
const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1366, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const totp = (s) => new TOTP({ secret: Secret.fromBase32(s), digits: 6, period: 30 }).generate();

try {
  await page.goto(ADMIN);
  await page.getByLabel(/^Code d’installation/).fill(code);
  await page.getByLabel(/^Votre nom/).fill('Propriétaire');
  await page.getByLabel(/^Adresse e-mail/).fill('proprio@exemple.fr');
  await page.getByLabel(/^Mot de passe/).first().fill('une phrase de passe solide');
  await page.getByLabel(/^Confirmez le mot de passe/).fill('une phrase de passe solide');
  await page.getByRole('button', { name: 'Créer mon compte' }).click();
  await page.getByRole('button', { name: /codes à 6 chiffres/ }).click();
  const secret = await page.getByLabel('Si vous ne pouvez pas scanner, saisissez cette clé').inputValue();
  await page.locator('input[inputmode="numeric"]').first().click();
  await page.keyboard.type(totp(secret), { delay: 30 });
  await page.getByText('Vos codes de secours').waitFor();
  const codes = await page.locator('code').allInnerTexts();
  await page.getByRole('button', { name: 'J’ai rangé mes codes' }).click();
  await page.getByText('Bonjour Propriétaire').waitFor();
  ok('Installation et double authentification');

  // Import de Coco Nail's par l'assistant.
  await page.getByRole('link', { name: 'Ajouter un site' }).first().click();
  await page.getByLabel(/^Nom du site/).fill("Coco Nail's");
  await page.getByRole('button', { name: 'Continuer' }).click();
  await page.getByText('Importer une archive').click();
  await page.locator('input[type="file"]').setInputFiles(zipPath);
  await page.getByRole('button', { name: 'Continuer' }).click();
  await page.getByRole('button', { name: 'Créer le site' }).click();
  await page.getByRole('button', { name: 'Ouvrir le site' }).waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: 'Ouvrir le site' }).click();
  await page.getByRole('heading', { name: "Coco Nail's" }).waitFor();
  const siteId = page.url().split('/sites/')[1];
  ok('Import de Coco Nail’s par l’assistant');

  // Publication : dépendances, étape de préparation, 8 fonctions.
  await page.goto(`${ADMIN}/sites/${siteId}/publier`);
  await page.getByRole('button', { name: 'Publier maintenant' }).click();
  await page.getByText(/8 fonction\(s\) prête\(s\)/).waitFor({ timeout: 120000 });
  await page.getByText(/Publication n°1 enregistrée/).waitFor({ timeout: 60000 });
  await page.screenshot({ path: path.join(captures, '20-publication-coco.png'), fullPage: true });
  ok('Publication de Coco Nail’s avec étape de préparation et fonctions');

  // Écran Fonctions et tâches.
  await page.goto(`${ADMIN}/sites/${siteId}/fonctions`);
  await page.getByText('disponibilites', { exact: true }).waitFor();
  await page.getByText(/Les tâches de ce site ne s’exécutent pas sur PAGINITY/).waitFor();
  await page.getByText('0 9 * * *').waitFor();
  await page.screenshot({ path: path.join(captures, '21-fonctions-taches.png'), fullPage: true });
  ok('Écran Fonctions : 8 fonctions, tâches planifiées désactivées par défaut avec explication');

  // Écran Secrets : saisie d'un secret de test, avec confirmation d'identité.
  await page.goto(`${ADMIN}/sites/${siteId}/secrets`);
  await page.getByText('GOOGLE_PRIVATE_KEY').waitFor();
  const ligne = page.locator('tr', { hasText: 'COMPTA_MOT_DE_PASSE' });
  await ligne.getByRole('button', { name: 'Définir' }).nth(1).click();
  await page.getByRole('dialog').getByLabel('Valeur').fill('mot-de-passe-de-test');
  await page.getByRole('dialog').getByRole('button', { name: 'Enregistrer' }).click();
  await page.getByText('Confirmez votre identité').waitFor();
  await page.getByRole('dialog', { name: /Confirmez/ }).getByLabel(/^Mot de passe/).fill('une phrase de passe solide');
  await page.getByLabel('Code à 6 chiffres (ou code de secours)').fill(codes[0]);
  await page.getByRole('button', { name: 'Confirmer', exact: true }).click();
  await page.getByText(/Secret « COMPTA_MOT_DE_PASSE » enregistré/).waitFor();
  await page.screenshot({ path: path.join(captures, '22-secrets.png'), fullPage: true });
  const contenu = await page.content();
  assert(!contenu.includes('mot-de-passe-de-test'), 'Secret enregistré après confirmation d’identité, valeur jamais réaffichée');

  // Une vraie fonction répond sur le site public.
  const pub = await context.newPage();
  await pub.goto(`http://coco-nails.localhost:${P.sites}/`);
  await pub.waitForLoadState('networkidle');
  const dispo = await pub.evaluate(async () => (await fetch('/api/disponibilites?du=2026-12-01&au=2026-12-10')).json());
  assert(dispo.actif === false, 'La fonction « disponibilités » répond depuis la page publique (agenda non relié, sans secret)');
  // Formulaire de contact du vrai site (envoi Netlify en arrière-plan, comme le fait la page).
  const r = await pub.evaluate(async () =>
    (await fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'form-name=contact&nom=Cliente%20Test&message=Bonjour' })).status,
  );
  assert(r === 200, 'Formulaire « contact » reçu par PAGINITY');
  await pub.screenshot({ path: path.join(captures, '23-coco-en-ligne.png') });
  await pub.close();

  await page.goto(`${ADMIN}/sites/${siteId}/formulaires`);
  await page.getByText('Cliente Test').first().click();
  await page.getByText('Bonjour', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(captures, '24-formulaires.png'), fullPage: true });
  ok('Message visible dans l’écran Formulaires');

  await page.goto(`${ADMIN}/reglages`);
  await page.getByText('Envoi d’e-mails').waitFor();
  ok('Écran Réglages de la plateforme (messagerie)');

  // Téléphone : écran Fonctions sans défilement horizontal.
  const mobile = await browser.newContext({ ...require('playwright').devices['iPhone 13'], locale: 'fr-FR' });
  await mobile.addCookies(await context.cookies());
  const m = await mobile.newPage();
  await m.goto(`${ADMIN}/sites/${siteId}/fonctions`);
  await m.getByText('disponibilites', { exact: true }).waitFor();
  assert(!(await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'Écran Fonctions sans défilement horizontal sur téléphone');
  await m.screenshot({ path: path.join(captures, '25-mobile-fonctions.png'), fullPage: true });
  await mobile.close();

  assert(errors.length === 0, `Aucune erreur JavaScript (${errors.join(' | ')})`);
} catch (e) {
  console.error(e);
  await page.screenshot({ path: path.join(captures, 'echec-phase3.png'), fullPage: true }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  fs.writeFileSync(path.join(captures, 'resultats-phase3.txt'), resultats.join('\n') + '\n');
  fs.rmSync(dataDir, { recursive: true, force: true });
}
