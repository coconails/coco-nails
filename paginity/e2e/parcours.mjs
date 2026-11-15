// Parcours complet dans un vrai navigateur (Chromium) : installation, double authentification,
// création d'un site, modification d'un tarif, aperçu, publication, versions, passkey, affichage mobile.
// Lancement : npm run build && node e2e/parcours.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TOTP, Secret } from 'otpauth';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = path.dirname(new URL(import.meta.url).pathname);
const captures = process.env.CAPTURES ?? path.join(root, 'captures');
fs.mkdirSync(captures, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paginity-e2e-'));
const PORTS = { admin: 18080, preview: 18081, sites: 18082 };
const ADMIN = `http://localhost:${PORTS.admin}`;
const resultats = [];
const ok = (m) => {
  resultats.push(`✔ ${m}`);
  console.log(`✔ ${m}`);
};
const assert = (c, m) => {
  if (!c) throw new Error(`Échec : ${m}`);
  ok(m);
};

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, '..', 'server', 'dist', 'index.js')], {
  env: {
    ...process.env,
    PAGINITY_DATA_DIR: dataDir,
    PAGINITY_ADMIN_PORT: String(PORTS.admin),
    PAGINITY_PREVIEW_PORT: String(PORTS.preview),
    PAGINITY_SITES_PORT: String(PORTS.sites),
    PAGINITY_PUBLIC_URL: ADMIN,
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
ok('Le serveur démarre et affiche un code d’installation');

const browser = await chromium.launch();
const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1366, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const totp = (secret) => new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate();
const typePin = async (code) => {
  await page.locator('input[aria-label="Code à 6 chiffres"], input[inputmode="numeric"]').first().click();
  await page.keyboard.type(code, { delay: 30 });
};

try {
  // 1. Installation
  await page.goto(ADMIN);
  await page.getByLabel(/^Code d’installation/).fill(code);
  await page.getByLabel(/^Votre nom/).fill('Propriétaire Test');
  await page.getByLabel(/^Adresse e-mail/).fill('proprio@exemple.fr');
  await page.getByLabel(/^Mot de passe/).first().fill('une phrase de passe solide');
  await page.getByLabel(/^Confirmez le mot de passe/).fill('une phrase de passe solide');
  await page.screenshot({ path: path.join(captures, '01-installation.png') });
  await page.getByRole('button', { name: 'Créer mon compte' }).click();
  await page.getByText('Protégez votre compte').waitFor();
  ok('Installation du compte propriétaire');

  // 2. Double authentification obligatoire
  await page.getByRole('button', { name: /codes à 6 chiffres/ }).click();
  const secret = await page.getByLabel('Si vous ne pouvez pas scanner, saisissez cette clé').inputValue();
  await page.screenshot({ path: path.join(captures, '02-double-authentification.png') });
  await typePin(totp(secret));
  await page.getByText('Vos codes de secours').waitFor();
  const codes = await page.locator('code').allInnerTexts();
  assert(codes.length === 10, '10 codes de secours affichés');
  await page.getByRole('button', { name: 'J’ai rangé mes codes' }).click();
  await page.getByText('Bonjour Propriétaire').waitFor();
  await page.screenshot({ path: path.join(captures, '03-tableau-de-bord-vide.png') });
  ok('Double authentification configurée, tableau de bord affiché');

  // 3. Création d'un site avec l'assistant
  await page.getByRole('link', { name: 'Ajouter un site' }).first().click();
  await page.getByLabel(/^Nom du site/).fill('Salon Démo');
  await page.getByRole('button', { name: 'Continuer' }).click();
  await page.getByText('Vitrine une page').click();
  await page.getByRole('button', { name: 'Continuer' }).click();
  await page.getByRole('button', { name: 'Créer le site' }).click();
  await page.getByRole('heading', { name: 'Salon Démo' }).waitFor();
  ok('Site créé avec l’assistant (modèle vitrine)');

  // 4. Modification d'un tarif par formulaire
  await page.getByRole('link', { name: /Contenus/ }).first().click();
  await page.getByRole('link', { name: 'Prestations et tarifs' }).click();
  const prix = page.getByLabel('Prix').first();
  await prix.waitFor();
  await prix.fill('27 €');
  await page.screenshot({ path: path.join(captures, '04-contenus-formulaire.png'), fullPage: true });
  await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
  await page.getByText('Brouillon enregistré').waitFor();
  ok('Tarif modifié et enregistré dans le brouillon');

  // 5. Aperçu privé dans un cadre (format téléphone)
  await page.getByRole('link', { name: 'Aperçu' }).first().click();
  const frame = page.frameLocator('iframe[title="Aperçu du site"]');
  await frame.getByText('27 €').waitFor({ timeout: 15000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('label', { hasText: 'Téléphone' }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(captures, '05-apercu-telephone.png') });
  ok('Aperçu privé affiché avec la modification (cadre isolé, format téléphone)');

  // 6. Publication en 10 étapes
  await page.getByRole('link', { name: 'Publier' }).first().click();
  await page.getByText('Prestations › n°1 › Prix').waitFor();
  await page.screenshot({ path: path.join(captures, '06-publier-modifications.png'), fullPage: true });
  await page.getByRole('button', { name: 'Publier maintenant' }).click();
  await page.getByText(/Publication n°1 enregistrée/).waitFor({ timeout: 30000 });
  await page.screenshot({ path: path.join(captures, '07-publication-reussie.png'), fullPage: true });
  ok('Publication réussie, progression affichée étape par étape');

  // 7. Le site public sert la nouvelle version
  const slugMatch = page.url().match(/\/sites\/([^/]+)/);
  const sitePage = await context.newPage();
  await sitePage.goto(`http://salon-demo.localhost:${PORTS.sites}/`);
  await sitePage.getByText('27 €').waitFor();
  await sitePage.screenshot({ path: path.join(captures, '08-site-publie.png') });
  ok('Le site public affiche le nouveau tarif');
  await sitePage.close();

  // 8. Versions
  await page.goto(`${ADMIN}/sites/${slugMatch[1]}/versions`);
  await page.getByText('En ligne').first().waitFor();
  ok('La page Versions montre la publication en ligne');

  // 9. Passkey avec un authentificateur virtuel, puis connexion par passkey
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
  await page.goto(`${ADMIN}/profil`);
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await page.getByRole('button', { name: 'Ajouter une passkey sur cet appareil' }).click();
  // Confirmation d'identité demandée (action sensible).
  await page.getByText('Confirmez votre identité').waitFor();
  await page.getByRole('dialog').getByLabel(/^Mot de passe/).fill('une phrase de passe solide');
  await page.getByLabel('Code à 6 chiffres (ou code de secours)').fill(codes[0]);
  await page.getByRole('button', { name: 'Confirmer', exact: true }).click();
  await page.getByText('Passkey ajoutée.').waitFor({ timeout: 15000 });
  ok('Passkey enregistrée après confirmation d’identité');
  await page.getByRole('button', { name: 'Mon compte' }).click();
  await page.getByRole('menuitem', { name: 'Se déconnecter' }).click();
  await page.getByRole('button', { name: 'Continuer' }).waitFor();
  await page.getByLabel(/^Adresse e-mail/).fill('proprio@exemple.fr');
  await page.getByLabel(/^Mot de passe/).fill('une phrase de passe solide');
  await page.getByRole('button', { name: 'Continuer' }).click();
  await page.getByRole('button', { name: /Utiliser ma passkey/ }).click();
  await page.getByText('Bonjour Propriétaire').waitFor();
  ok('Connexion par passkey réussie');

  // 10. Affichage téléphone
  const mobile = await browser.newContext({ ...require('playwright').devices['iPhone 13'], locale: 'fr-FR' });
  await mobile.addCookies((await context.cookies()).map((c) => ({ ...c })));
  const m = await mobile.newPage();
  await m.goto(ADMIN);
  await m.getByText('Bonjour Propriétaire').waitFor();
  await m.screenshot({ path: path.join(captures, '09-mobile-tableau-de-bord.png'), fullPage: true });
  await m.goto(`${ADMIN}/sites/${slugMatch[1]}/contenus/horaires`);
  await m.getByText('Jours').first().waitFor();
  await m.screenshot({ path: path.join(captures, '10-mobile-contenus.png') });
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert(!overflow, 'Pas de défilement horizontal sur téléphone (format iPhone 13, moteur Chromium)');
  await m.getByRole('button', { name: 'Ouvrir le menu' }).click();
  await m.getByRole('link', { name: 'Activités', exact: true }).last().waitFor();
  await m.screenshot({ path: path.join(captures, '11-mobile-menu.png') });
  ok('Menu mobile utilisable');
  await mobile.close();

  // 11. Fermer le navigateur pendant une publication : elle se termine quand même
  await page.goto(`${ADMIN}/sites/${slugMatch[1]}/contenus/faq`);
  await page.getByText('Questions').first().waitFor();
  await page.getByLabel('Réponse').first().fill('Par téléphone, par e-mail ou sur place.');
  await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
  await page.getByText('Brouillon enregistré').waitFor();
  const csrf = (await context.cookies()).find((c) => c.name === 'paginity_csrf').value;
  const job = await page.evaluate(
    async ([id, token]) => (await fetch(`/api/sites/${id}/publier`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: '{}' })).json(),
    [slugMatch[1], csrf],
  );
  await page.close();
  const p2 = await context.newPage();
  await new Promise((r) => setTimeout(r, 4000));
  await p2.goto(`${ADMIN}/activites`);
  const state = await p2.evaluate(async (id) => (await (await fetch(`/api/activites/${id}`)).json()).etat, job.id);
  assert(state === 'reussie', 'Publication terminée alors que la page qui l’a lancée a été fermée');

  assert(errors.length === 0, `Aucune erreur JavaScript dans les pages (${errors.join(' | ')})`);
} catch (e) {
  console.error(e);
  await page.screenshot({ path: path.join(captures, 'echec.png'), fullPage: true }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
  fs.writeFileSync(path.join(captures, 'resultats.txt'), resultats.join('\n') + '\n');
  fs.rmSync(dataDir, { recursive: true, force: true });
}
