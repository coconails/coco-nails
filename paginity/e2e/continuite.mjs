// Continuité de service dans Chromium : sauvegarde automatique chiffrée (phrase, dossier, sauvegarde, essai de
// restauration), alerte de panne, page de secours. Aucun service réel : dossier local, faux service de surveillance.
// Lancement : npm run build && node e2e/continuite.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as E from './lib/paginity.mjs';

const { require, chromium, OUT, ok } = E;
const { P, ADMIN, tmp } = E.preparer('continuite', 18800);

// Faux service de surveillance (comme healthchecks.io) : note chaque signal reçu.
const signaux = [];
const surveillance = http.createServer((req, res) => {
  signaux.push(req.url);
  res.writeHead(200).end('OK');
});
await new Promise((r) => surveillance.listen(0, '127.0.0.1', r));

// Faux Ollama : la liste des modèles « installés ».
const ollama = http.createServer((req, res) => {
  if (req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'qwen3:8b' }, { id: 'glm4:9b' }, { id: 'nomic-embed-text:latest' }] }));
  res.writeHead(404).end();
});
await new Promise((r) => ollama.listen(0, '127.0.0.1', r));

const { server, code } = await E.demarrer({ P, ADMIN, tmp });

const browser = await chromium.launch();
const erreurs = [];
try {
  const ctx = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const { h, site } = await E.installer(ctx, ADMIN, code);
  const dossier = path.join(tmp, 'Google Drive', 'Sauvegardes PAGINITY');
  fs.mkdirSync(dossier, { recursive: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => erreurs.push(e.message));
  const main = page.locator('main');
  const capture = async (loc, nom) => {
    for (const b of await page.locator('.mantine-Notification-closeButton').all()) await b.click().catch(() => {});
    await page.setViewportSize({ width: 1440, height: 1250 });
    await loc.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 76));
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(OUT, nom) });
    await page.setViewportSize({ width: 1440, height: 900 });
  };

  // ---- 1. Sauvegarde automatique
  await page.goto(`${ADMIN}/reglages`);
  const sv = main.locator('[data-section="sauvegarde"]');
  await sv.waitFor();
  await capture(sv, 'E1-1-sauvegarde-vierge.png');
  await sv.getByLabel('Phrase', { exact: true }).fill('girafe cassis tambour lanterne');
  await sv.getByLabel('Retapez-la').fill('girafe cassis tambour lanterne');
  await sv.getByRole('button', { name: 'Enregistrer la phrase' }).click();
  await page.getByText('Phrase de sauvegarde enregistrée.').first().waitFor();
  ok(await sv.getByText('choisie').isVisible(), 'Phrase de sauvegarde enregistrée (jamais réaffichée)');
  await sv.getByLabel('Dossier de destination (chemin complet)').fill(dossier);
  await sv.getByRole('switch', { name: 'Sauvegarde automatique active' }).click({ force: true });
  await sv.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await page.getByText('Réglages de sauvegarde enregistrés.').first().waitFor();
  ok(await sv.getByText('Active', { exact: true }).isVisible(), 'Sauvegarde automatique activée');
  await sv.getByRole('button', { name: 'Sauvegarder maintenant' }).click();
  await page.getByText('Sauvegarde terminée.').first().waitFor({ timeout: 60000 });
  const f = fs.readdirSync(dossier).filter((n) => n.endsWith('.paginity'));
  ok(f.length === 1 && !fs.readFileSync(path.join(dossier, f[0])).includes('Salon Démo'), 'Fichier chiffré déposé dans le dossier (le nom du site n’y est pas lisible)');
  await sv.getByRole('button', { name: 'Essayer de restaurer la dernière' }).click();
  await sv.getByText(/Restauration d’essai réussie/).waitFor({ timeout: 60000 });
  ok(true, 'Essai de restauration réussi, affiché à l’écran');
  await capture(sv, 'E1-2-sauvegarde-active.png');

  // ---- 2. Alerte de panne
  const bt = main.locator('[data-section="battement"]');
  await bt.getByLabel('Adresse « ping » du service de surveillance').fill(`http://127.0.0.1:${surveillance.address().port}/ping/coco`);
  await bt.getByRole('switch', { name: 'Surveillance active' }).click({ force: true });
  await bt.getByRole('button', { name: 'Enregistrer' }).click();
  await page.getByText('Surveillance enregistrée.').first().waitFor();
  await bt.getByRole('button', { name: 'Envoyer un essai' }).click();
  await bt.getByText('reçu par le service').waitFor();
  ok(signaux.join() === '/ping/coco', 'Signal « je vais bien » reçu par le service de surveillance (simulé)');
  ok(await bt.getByText('tout va bien').isVisible() && await bt.getByText('Surveillé', { exact: true }).isVisible(), 'État du serveur et surveillance affichés');
  await capture(bt, 'E2-alerte-panne.png');

  // ---- 3. Page de secours
  await page.goto(`${ADMIN}/sites/${site.id}/reglages`);
  const sc = main.locator('[data-section="secours"]');
  await sc.waitFor();
  ok((await sc.getByLabel('Téléphone').inputValue()) === '01 23 45 67 89', 'Page de secours pré-remplie depuis les contenus (téléphone, e-mail)');
  await sc.getByLabel('Lien de contact (facultatif)').fill('https://wa.me/33600000000');
  await sc.getByLabel('Horaires').fill('Lun, mar, jeu, ven 9 h–19 h · mer, sam 9 h–12 h');
  await sc.getByRole('button', { name: 'Enregistrer' }).click();
  await page.getByText('Page de secours enregistrée.').first().waitFor();
  const cadre = page.frameLocator('iframe[title="Aperçu de la page de secours"]');
  await cadre.getByText('Lun, mar, jeu, ven 9 h–19 h').waitFor();
  ok(await cadre.getByRole('link', { name: 'Appeler le 01 23 45 67 89' }).isVisible(), 'Aperçu : bouton « Appeler » et horaires');
  const [dl] = await Promise.all([page.waitForEvent('download'), sc.getByRole('button', { name: 'Télécharger la page (index.html)' }).click()]);
  const html = fs.readFileSync(await dl.path(), 'utf8');
  ok(dl.suggestedFilename() === 'index.html' && html.includes('wa.me/33600000000') && !/<script|<link/.test(html), 'Page téléchargée : un seul fichier autonome');
  await capture(sc, 'E3-page-secours.png');
  // La page seule, telle que les clientes la verraient sur téléphone.
  const tel = await browser.newContext({ ...require('playwright').devices['iPhone 13'] });
  const pt = await tel.newPage();
  await pt.setContent(html);
  await pt.screenshot({ path: path.join(OUT, 'E3b-page-secours-telephone.png') });
  await tel.close();

  // ---- 4. Kit de démarrage de l'IA
  await page.goto(`${ADMIN}/reglages`);
  const kit = main.locator('[data-section="detecter"]');
  await kit.waitFor();
  await kit.getByLabel('Adresse d’Ollama').fill(`http://127.0.0.1:${ollama.address().port}`);
  await kit.getByRole('button', { name: 'Détecter les modèles installés' }).click();
  await kit.getByText('Qwen3 8b').waitFor();
  ok((await kit.getByRole('checkbox').count()) === 2, 'Deux modèles d’écriture détectés (le modèle « embed » est ignoré)');
  await capture(kit, 'E4-1-modeles-detectes.png');
  await kit.getByRole('button', { name: 'Ajouter les modèles choisis' }).click();
  await page.getByText(/2 modèle\(s\) ajouté\(s\)/).first().waitFor();
  await main.locator('[data-modele-local]').nth(1).waitFor();
  ok((await main.locator('[data-modele-local]').count()) === 2, 'Les deux modèles apparaissent dans la liste, autorisés');
  await capture(main.locator('[data-modele-local]').first(), 'E4-2-modeles-ajoutes.png');

  ok(erreurs.length === 0, `Aucune erreur JavaScript (${erreurs.join(' | ')})`);
} catch (e) {
  E.echec(e.message);
} finally {
  await browser.close();
  server.kill('SIGTERM');
  surveillance.close();
  ollama.close();
}
await E.terminer({ tmp });
