// Confort, dans Chromium : compteur de visites (site publié, visites simulées), aperçu téléphone avant publication,
// failles connues (registre npm SIMULÉ), notifications (carte et service worker ; l'abonnement réel nécessite le
// service de notification du navigateur, non joignable ici). Lancement : npm run build && node e2e/confort.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as E from './lib/paginity.mjs';

const { require, chromium, OUT, ok } = E;
const { P, ADMIN, tmp } = E.preparer('confort', 18820);

// Faux registre npm : une faille « moyenne » sur fastify.
const registre = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ fastify: [{ title: 'Exemple de faille (simulée)', severity: 'moderate', url: 'https://exemple.org/avis' }] })));
});
await new Promise((r) => registre.listen(0, '127.0.0.1', r));

const { server, code } = await E.demarrer({ P, ADMIN, tmp }, { PAGINITY_REGISTRE_URL: `http://127.0.0.1:${registre.address().port}` });

const browser = await chromium.launch();
const erreurs = [];
try {
  const ctx = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const { h, site } = await E.installer(ctx, ADMIN, code);
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
  E.echec(e.message);
} finally {
  await browser.close();
  server.kill('SIGTERM');
  registre.close();
}
await E.terminer({ tmp });
