// Prend toutes les captures d'écran du manuel d'utilisation (docs/manuel/*.webp), sur des données de démonstration.
// Lancement : npm run build && COCO_NAILS_DIR=/chemin/vers/coco-nails1 node e2e/captures-manuel.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TOTP, Secret } from 'otpauth';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const sharp = require('sharp');
const yazl = require('yazl');

const root = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(root, '..', '..', 'docs', 'manuel');
const COCO = process.env.COCO_NAILS_DIR ?? '/home/user/coco-nails1';
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f.endsWith('.webp')) fs.rmSync(path.join(OUT, f));
const tmp = fs.mkdtempSync(path.join(process.env.MANUEL_TMP ?? os.tmpdir(), 'paginity-manuel-'));
const P = { admin: 18280, preview: 18281, sites: 18282 };
const ADMIN = `http://localhost:${P.admin}`;
const MDP = 'une phrase de passe solide';
const totp = (s) => new TOTP({ secret: Secret.fromBase32(s), digits: 6, period: 30 }).generate();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name, opts = {}) {
  await pause(opts.attente ?? 350);
  const buf = await page.screenshot({ fullPage: !!opts.pleinePage, clip: opts.clip });
  await sharp(buf).webp({ quality: 82 }).toFile(path.join(OUT, `${name}.webp`));
  console.log('📸', name);
}

// Données de démonstration : une photo générée (dégradé), une archive du site Coco Nail's.
const photo = path.join(tmp, 'vitrine-salon.png');
await sharp({ create: { width: 1600, height: 1000, channels: 3, background: '#c98a1c' } })
  .composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f5c355"/><stop offset="1" stop-color="#13213a"/></linearGradient></defs><rect width="1600" height="1000" fill="url(#g)"/><circle cx="1200" cy="300" r="180" fill="#ffffff55"/></svg>') }])
  .png()
  .toFile(photo);
const zipPath = path.join(tmp, 'coco-nails.zip');
const hasCoco = fs.existsSync(path.join(COCO, '.pages.yml'));
if (hasCoco) {
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
}

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, '..', 'server', 'dist', 'index.js')], {
  env: {
    ...process.env,
    PAGINITY_DATA_DIR: path.join(tmp, 'donnees'),
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
const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 860 } });
const page = await context.newPage();
let codes = [];
let secret = '';
const confirmer = async () => {
  const dlg = page.getByRole('dialog', { name: /Confirmez/ });
  await dlg.waitFor();
  await dlg.getByLabel(/^Mot de passe/).fill(MDP);
  await dlg.getByLabel('Code à 6 chiffres (ou code de secours)').fill(codes.shift());
  return dlg;
};

try {
  // ---------------------------------------------------------------- 1. Premier démarrage
  await page.goto(ADMIN);
  await page.getByLabel(/^Code d’installation/).fill(code);
  await page.getByLabel(/^Votre nom/).fill('Donaven');
  await page.getByLabel(/^Adresse e-mail/).fill('proprietaire@exemple.fr');
  await page.getByLabel(/^Mot de passe/).first().fill(MDP);
  await page.getByLabel(/^Confirmez le mot de passe/).fill(MDP);
  await shot(page, '01-installation');
  await page.getByRole('button', { name: 'Créer mon compte' }).click();
  await page.getByText('Protégez votre compte').waitFor();
  await shot(page, '02-proteger-compte');
  await page.getByRole('button', { name: /codes à 6 chiffres/ }).click();
  secret = await page.getByLabel('Si vous ne pouvez pas scanner, saisissez cette clé').inputValue();
  await shot(page, '03-qr-code', { pleinePage: true });
  await page.locator('input[inputmode="numeric"]').first().click();
  await page.keyboard.type(totp(secret), { delay: 30 });
  await page.getByText('Vos codes de secours').waitFor();
  codes = await page.locator('code').allInnerTexts();
  await shot(page, '04-codes-secours', { pleinePage: true });
  await page.getByRole('button', { name: 'J’ai rangé mes codes' }).click();
  await page.getByText('Bonjour Donaven').waitFor();
  await shot(page, '05-tableau-de-bord-vide');

  // ---------------------------------------------------------------- 2. Créer un site
  await page.getByRole('link', { name: 'Ajouter un site' }).first().click();
  await page.getByLabel(/^Nom du site/).fill('Salon Démo');
  await shot(page, '06-assistant-nom');
  await page.getByRole('button', { name: 'Continuer' }).click();
  await page.getByText('Vitrine une page').click();
  await shot(page, '07-assistant-modele');
  await page.getByRole('button', { name: 'Continuer' }).click();
  await shot(page, '08-assistant-verification');
  await page.getByRole('button', { name: 'Créer le site' }).click();
  await page.getByRole('heading', { name: 'Salon Démo' }).waitFor();
  const demoId = page.url().split('/sites/')[1];
  await shot(page, '09-fiche-site', { pleinePage: true });

  // ---------------------------------------------------------------- 3. Contenus
  await page.getByRole('link', { name: /Contenus/ }).first().click();
  await page.getByLabel(/^Nom du site/).waitFor();
  await page.getByLabel(/^Phrase d'accroche/).fill('Votre pause beauté, à deux pas de chez vous.');
  await shot(page, '10-contenus-presentation', { pleinePage: true });
  await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
  await page.getByText('Brouillon enregistré').waitFor();
  await page.getByRole('link', { name: 'Prestations et tarifs' }).click();
  await page.getByLabel('Prix').first().fill('27 €');
  await shot(page, '11-contenus-tarifs', { pleinePage: true });
  await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
  await page.getByText('Brouillon enregistré').first().waitFor();
  await shot(page, '12-brouillon-enregistre');

  // ---------------------------------------------------------------- 4. Médias
  await page.goto(`${ADMIN}/sites/${demoId}/medias`);
  await page.locator('input[type="file"]').setInputFiles(photo);
  await page.getByText('Ajouté au brouillon').waitFor();
  await pause(800);
  await shot(page, '13-medias');
  await page.getByText('vitrine-salon.png').first().click();
  await page.getByText('Adresse sur le site').waitFor();
  await shot(page, '14-media-detail');
  await page.keyboard.press('Escape');
  // Photo choisie dans un champ « image ».
  await page.goto(`${ADMIN}/sites/${demoId}/contenus/site`);
  await page.getByRole('button', { name: 'Choisir' }).click();
  await page.getByText('Choisir un fichier').waitFor();
  await shot(page, '15-choisir-image');
  await page.getByRole('dialog').getByText('vitrine-salon.png').click();
  await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
  await page.getByText('Brouillon enregistré').waitFor();

  // ---------------------------------------------------------------- 5. Code
  await page.goto(`${ADMIN}/sites/${demoId}/fichiers?chemin=public/style.css`);
  await page.locator('.cm-editor').waitFor();
  await shot(page, '16-mode-code');

  // ---------------------------------------------------------------- 6. Aperçu
  await page.goto(`${ADMIN}/sites/${demoId}/apercu`);
  await page.frameLocator('iframe[title="Aperçu du site"]').getByText('27 €').waitFor({ timeout: 20000 });
  await shot(page, '17-apercu-ordinateur', { attente: 800 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('label', { hasText: 'Téléphone' }).click();
  await shot(page, '18-apercu-telephone', { attente: 900 });

  // ---------------------------------------------------------------- 7. Publier
  await page.goto(`${ADMIN}/sites/${demoId}/publier`);
  await page.getByPlaceholder(/nouveaux tarifs/).fill('Première mise en ligne');
  await shot(page, '19-publier-avant');
  await page.getByRole('button', { name: 'Publier maintenant' }).click();
  await page.getByText(/Publication n°1 enregistrée/).waitFor({ timeout: 60000 });
  await shot(page, '20-publication-reussie', { pleinePage: true });
  const pub = await context.newPage();
  await pub.goto(`http://salon-demo.localhost:${P.sites}/`);
  await pub.getByText('27 €').waitFor();
  await shot(pub, '21-site-public', { attente: 600 });
  await pub.close();

  // Deuxième modification, pour montrer la comparaison et les versions.
  await page.goto(`${ADMIN}/sites/${demoId}/contenus/prestations`);
  await page.getByLabel('Prix').first().fill('29 €');
  await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
  await page.getByText('Brouillon enregistré').waitFor();
  await page.goto(`${ADMIN}/sites/${demoId}/publier`);
  await page.getByText('Prestations › n°1 › Prix').waitFor();
  await shot(page, '22-comparaison-champ', { pleinePage: true });
  await page.getByRole('button', { name: 'Publier maintenant' }).click();
  await page.getByText(/Publication n°2 enregistrée/).waitFor({ timeout: 60000 });

  // ---------------------------------------------------------------- 8. Versions
  await page.goto(`${ADMIN}/sites/${demoId}/versions`);
  await page.getByText('En ligne').first().waitFor();
  await page.getByRole('button', { name: 'Actions' }).nth(1).click();
  await shot(page, '23-versions');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Historique du brouillon' }).click();
  await shot(page, '24-historique');

  // ---------------------------------------------------------------- 9. Réglages du site et invitations
  await page.goto(`${ADMIN}/sites/${demoId}/reglages`);
  await page.getByLabel(/^Adresse e-mail/).fill('collaboratrice@exemple.fr');
  await page.getByRole('button', { name: 'Créer l’invitation' }).click();
  await page.getByText(/Invitation créée/).waitFor();
  await shot(page, '25-reglages-site', { pleinePage: true });

  // ---------------------------------------------------------------- 10. Site avec fonctions : Coco Nail's
  if (hasCoco) {
    await page.goto(`${ADMIN}/sites/nouveau`);
    await page.getByLabel(/^Nom du site/).fill("Coco Nail's");
    await page.getByRole('button', { name: 'Continuer' }).click();
    await page.getByText('Importer une archive').click();
    await page.locator('input[type="file"]').setInputFiles(zipPath);
    await shot(page, '26-assistant-import');
    await page.getByRole('button', { name: 'Continuer' }).click();
    await page.getByRole('button', { name: 'Créer le site' }).click();
    await page.getByRole('button', { name: 'Ouvrir le site' }).waitFor({ timeout: 60000 });
    await shot(page, '27-import-termine', { pleinePage: true });
    await page.getByRole('button', { name: 'Ouvrir le site' }).click();
    await page.getByRole('heading', { name: "Coco Nail's" }).waitFor();
    const cocoId = page.url().split('/sites/')[1];
    await page.goto(`${ADMIN}/sites/${cocoId}/contenus`);
    await page.getByRole('link', { name: 'Horaires et coordonnées' }).click();
    await page.getByText('Horaires de la semaine').waitFor();
    await shot(page, '28-contenus-pagescms');
    await page.goto(`${ADMIN}/sites/${cocoId}/publier`);
    await page.getByRole('button', { name: 'Publier maintenant' }).click();
    await page.getByText(/Publication n°1 enregistrée/).waitFor({ timeout: 180000 });
    await shot(page, '29-publication-avec-fonctions');
    await page.goto(`${ADMIN}/sites/${cocoId}/fonctions`);
    await page.getByText('disponibilites', { exact: true }).waitFor();
    await shot(page, '30-fonctions-taches', { pleinePage: true });
    await page.goto(`${ADMIN}/sites/${cocoId}/secrets`);
    await page.getByText('GOOGLE_PRIVATE_KEY').waitFor();
    await shot(page, '31-secrets');
    await page.locator('tr', { hasText: 'COMPTA_MOT_DE_PASSE' }).getByRole('button', { name: 'Définir' }).nth(1).click();
    await page.getByRole('dialog').getByLabel('Valeur').fill('valeur-de-test');
    await shot(page, '32-secret-saisie');
    await page.getByRole('dialog').getByRole('button', { name: 'Enregistrer' }).click();
    await confirmer();
    await shot(page, '33-confirmer-identite');
    await page.getByRole('button', { name: 'Confirmer', exact: true }).click();
    await page.getByText(/Secret « COMPTA_MOT_DE_PASSE » enregistré/).waitFor();
    // Message reçu par le formulaire de contact du site.
    const site = await context.newPage();
    await site.goto(`http://coco-nails.localhost:${P.sites}/`);
    await site.evaluate(async () =>
      fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'form-name=contact&nom=Cliente%20Exemple&telephone=06%2000%2000%2000%2000&message=Bonjour%2C%20avez-vous%20un%20cr%C3%A9neau%20samedi%20%3F' }),
    );
    await site.close();
    await page.goto(`${ADMIN}/sites/${cocoId}/formulaires`);
    await page.getByText('Cliente Exemple').first().click();
    await shot(page, '34-formulaires', { pleinePage: true, attente: 600 });
  }

  // ---------------------------------------------------------------- 11. Plateforme
  await page.goto(ADMIN);
  await page.getByText('Mes sites').first().waitFor();
  await shot(page, '35-tableau-de-bord', { pleinePage: true, attente: 800 });
  await page.goto(`${ADMIN}/activites`);
  await page.getByText(/Publication de/).first().click();
  await shot(page, '36-activites', { pleinePage: true });
  await page.goto(`${ADMIN}/utilisateurs`);
  await page.getByText('Invitations en attente').waitFor();
  await shot(page, '37-utilisateurs');
  await page.goto(`${ADMIN}/sante`);
  await page.getByText('Ressources').waitFor();
  await shot(page, '38-sante', { attente: 800 });
  await page.goto(`${ADMIN}/journal`);
  await page.getByText('Installation de PAGINITY').first().waitFor();
  await shot(page, '39-journal');
  await page.goto(`${ADMIN}/reglages`);
  await page.getByText('Envoi d’e-mails').waitFor();
  await shot(page, '40-reglages-plateforme', { pleinePage: true });
  await page.goto(`${ADMIN}/profil`);
  await page.getByText('Double authentification').waitFor();
  await shot(page, '41-profil', { pleinePage: true });

  // ---------------------------------------------------------------- 12. Connexion
  await page.getByRole('button', { name: 'Mon compte' }).click();
  await shot(page, '42-menu-compte');
  await page.getByRole('menuitem', { name: 'Se déconnecter' }).click();
  await page.getByRole('button', { name: 'Continuer' }).waitFor();
  await page.getByLabel(/^Adresse e-mail/).fill('proprietaire@exemple.fr');
  await page.getByLabel(/^Mot de passe/).fill(MDP);
  await shot(page, '43-connexion');
  await page.getByRole('button', { name: 'Continuer' }).click();
  await page.getByText('Double authentification').waitFor();
  await shot(page, '44-connexion-code');
  await pause(31000); // nouveau code (un code ne sert qu'une fois)
  await page.locator('input[inputmode="numeric"]').first().click();
  await page.keyboard.type(totp(secret), { delay: 30 });
  await page.getByText('Bonjour Donaven').waitFor();

  // ---------------------------------------------------------------- 13. Téléphone et mode clair
  const mobile = await browser.newContext({ ...devices['iPhone 13'], locale: 'fr-FR' });
  await mobile.addCookies(await context.cookies());
  const m = await mobile.newPage();
  await m.goto(ADMIN);
  await m.getByText('Bonjour Donaven').waitFor();
  await shot(m, '45-mobile-tableau-de-bord', { attente: 800 });
  await m.getByRole('button', { name: 'Ouvrir le menu' }).click();
  await shot(m, '46-mobile-menu', { attente: 600 });
  await m.goto(`${ADMIN}/sites/${demoId}/contenus/horaires`);
  await m.getByText('Jours').first().waitFor();
  await shot(m, '47-mobile-contenus', { attente: 600 });
  await m.goto(`${ADMIN}/sites/${demoId}/medias`);
  await m.getByText('vitrine-salon.png').first().waitFor();
  await shot(m, '48-mobile-medias', { attente: 600 });
  await mobile.close();
  await page.getByRole('button', { name: 'Changer de thème' }).click();
  await shot(page, '49-mode-clair', { attente: 700 });
  await page.getByRole('button', { name: 'Changer de thème' }).click();
} catch (e) {
  console.error(e);
  await page.screenshot({ path: path.join(tmp, 'echec.png'), fullPage: true }).catch(() => undefined);
  fs.copyFileSync(path.join(tmp, 'echec.png'), path.join(os.tmpdir(), 'manuel-echec.png'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await pause(1500);
  fs.rmSync(tmp, { recursive: true, force: true });
}
