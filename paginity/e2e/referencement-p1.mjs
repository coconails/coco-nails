// Référencement, priorité 1, dans Chromium : nouvelles règles, correction assistée d'un constat (FAUX modèle local),
// contrôle du site en ligne (FAUX site extérieur local), rapport mensuel. Aucun service réel n'est appelé.
// Lancement : npm run build && node e2e/referencement-p1.mjs
import http from 'node:http';
import path from 'node:path';
import * as E from './lib/paginity.mjs';

const { require, chromium, OUT, ok } = E;
const { P, ADMIN, tmp } = E.preparer('seo-p1', 18850);
const DESC = '<meta name="description" content="Prestations, tarifs, horaires et contact du salon : tout ce qu’il faut savoir avant de prendre rendez-vous.">';

/** Faux modèle local : pour une correction de référencement, ajoute la description de la page d'accueil. */
const modele = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    if (req.url.endsWith('/models')) return res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
    const u = JSON.parse(b).messages[1].content;
    const rubriques = JSON.parse(u.split('<contenus>\n')[1].split('\n</contenus>')[0]);
    const html = rubriques.find((r) => r.rubrique === 'fichier:public/index.html').valeur;
    const rep = u.includes('Correction de référencement')
      ? { statut: 'proposition', changements: [{ rubrique: 'fichier:public/index.html', valeur_json: JSON.stringify(html.replace('</head>', `${DESC}\n</head>`)) }], explication: 'Description ajoutée à partir des informations déjà présentes sur la page.', raison: '' }
      : { statut: 'impossible', changements: [], explication: '', raison: 'test' };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(rep) } }] }));
  });
});
/** Faux site extérieur : une page qui existe, une page disparue. */
const exterieur = http.createServer((req, res) => (req.url === '/mort' ? res.writeHead(404).end() : res.writeHead(200, { 'content-type': 'text/html' }).end('<p>ok</p>')));
await new Promise((r) => modele.listen(0, '127.0.0.1', r));
await new Promise((r) => exterieur.listen(0, '127.0.0.1', r));
const EXT = `http://127.0.0.1:${exterieur.address().port}`;

// NODE_ENV=test : permet au contrôle en ligne de joindre le faux site extérieur local (refusé en temps normal).
const { server, code } = await E.demarrer({ P, ADMIN, tmp }, { NODE_ENV: 'test' });
const browser = await chromium.launch();
const erreurs = [];
try {
  const ctx = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const { h, site } = await E.installer(ctx, ADMIN, code);
  ok((await ctx.request.put(`${ADMIN}/api/reglages/ia`, { data: { active: true, locaux: [{ nom: 'Qwen3', actif: true, url: `http://127.0.0.1:${modele.address().port}/v1`, modele: 'qwen3' }] }, headers: h })).ok(), 'Assistant activé avec un modèle local (simulé)');
  // Défauts volontaires : plus de description, un lien vers une page extérieure disparue.
  const f = await (await ctx.request.get(`${ADMIN}/api/sites/${site.id}/fichier?chemin=public/index.html`)).json();
  const contenu = f.contenu.replace(/<meta name="description"[^>]*>/, '').replace('</main>', `<p><a href="${EXT}/ok">Partenaire</a> · <a href="${EXT}/mort">Ancien partenaire</a></p></main>`);
  ok((await ctx.request.put(`${ADMIN}/api/sites/${site.id}/fichier`, { data: { chemin: 'public/index.html', contenu, version: f.version }, headers: h })).ok(), 'Site préparé avec deux défauts');

  const page = await ctx.newPage();
  page.on('pageerror', (e) => erreurs.push(e.message));
  const main = page.locator('main');
  const panneau = page.locator('aside[aria-label="Assistant"]');
  const capture = async (nom, loc) => {
    for (const b of await page.locator('.mantine-Notification-closeButton').all()) await b.click().catch(() => {});
    if (loc) await loc.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 90));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, nom) });
  };

  // 1. Audit du brouillon, puis correction assistée du constat « Pas de description ».
  await page.goto(`${ADMIN}/sites/${site.id}/referencement`);
  await main.getByRole('button', { name: 'Lancer l’audit' }).click();
  await main.locator('[data-section="resume"]').waitFor({ timeout: 60000 });
  const carte = main.locator('.mantine-Card-root', { hasText: 'Pas de description (<meta name="description">).' }).last();
  ok(await carte.getByRole('button', { name: 'Proposer une correction' }).isVisible(), 'Bouton « Proposer une correction » sur un constat corrigeable');
  ok((await main.getByRole('button', { name: 'Proposer une correction' }).count()) < (await main.locator('[data-niveau] .mantine-Card-root').count()), 'Pas de bouton sur les constats qu’on ne peut pas corriger sans inventer (ex. sitemap)');
  await capture('S1-1-audit-correction.png', carte);
  await carte.getByRole('button', { name: 'Proposer une correction' }).click();
  await page.getByText('Proposition prête').waitFor({ timeout: 30000 });
  await panneau.getByText('Correction de référencement').first().waitFor();
  ok(await panneau.getByText('Description ajoutée à partir des informations déjà présentes sur la page.').isVisible(), 'La proposition apparaît dans le panneau Assistant, avec avant / après');
  await capture('S1-2-proposition.png');
  await panneau.getByRole('button', { name: 'Accepter (brouillon)' }).first().click();
  await panneau.locator('[data-verification-seo]').waitFor({ timeout: 60000 });
  ok(await panneau.locator("[data-verification-seo]").getByText(/le constat a disparu/).isVisible(), 'Après accord : nouvel audit du brouillon, le constat a disparu');
  await page.reload();
  await main.locator('[data-section="resume"]').waitFor();
  ok(!(await main.locator('[data-niveau]').getByText('Pas de description (<meta name="description">).').count()), 'L’audit affiché ne contient plus le constat corrigé');
  ok(await main.getByRole('alert').filter({ hasText: 'Corrigé depuis l’audit précédent' }).getByText('Pas de description').isVisible(), 'Il apparaît dans « Corrigé depuis l’audit précédent »');
  await capture('S1-3-apres-correction.png');
  ok((await (await ctx.request.get(`${ADMIN}/api/sites/${site.id}/referencement`)).json()).publie === false, "Rien n’a été publié automatiquement");

  // 2. Publication (geste humain), puis contrôle du site en ligne.
  const j = await (await ctx.request.post(`${ADMIN}/api/sites/${site.id}/publier`, { data: {}, headers: h })).json();
  for (let i = 0; i < 120; i++) {
    const a = await (await ctx.request.get(`${ADMIN}/api/activites/${j.id}`)).json();
    if (a.etat !== 'en_cours' && a.etat !== 'en_attente') break;
    await page.waitForTimeout(500);
  }
  await page.reload();
  await main.getByText('Contrôle en ligne', { exact: true }).click();
  ok(await main.locator('[data-explication="controle"]').isVisible(), 'Contrôle en ligne : explication de ce qui est vérifié');
  await main.getByRole('button', { name: 'Lancer le contrôle' }).click();
  await main.locator('[data-section="resume"]').waitFor({ timeout: 120000 });
  await main.getByText(`Lien vers une page qui n’existe plus : ${EXT}/mort (erreur 404).`).waitFor();
  ok(true, 'Contrôle en ligne : le lien vers la page disparue est signalé');
  ok(!(await main.getByText(`${EXT}/ok`).count()), 'Le lien qui fonctionne n’est pas signalé');
  ok(await main.getByText(/adresse inconnue renvoie bien une erreur 404/).isVisible(), 'Vérifié : une adresse inconnue renvoie une vraie erreur 404');
  await capture('S1-4-controle-en-ligne.png', main.locator('[data-niveau="attention"]'));

  // 3. Rapport mensuel.
  await main.getByRole('button', { name: 'Voir le rapport de ce mois-ci' }).click();
  await main.locator('[data-rapport="apercu"]').waitFor();
  ok(await main.locator('[data-rapport="apercu"]').getByText('Ce que je vous conseille ce mois-ci').isVisible(), 'Rapport mensuel : aperçu en langage simple, avec des conseils');
  await capture('S1-5-rapport-mensuel.png', main.locator('[data-section="rapport-mensuel"]'));

  // 4. Téléphone.
  const tel = await browser.newContext({ locale: 'fr-FR', ...require('playwright').devices['iPhone 13'] });
  await tel.addCookies(await ctx.cookies());
  const pt = await tel.newPage();
  await pt.goto(`${ADMIN}/sites/${site.id}/referencement`);
  await pt.locator('main [data-section="resume"]').waitFor();
  ok(await pt.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Téléphone : pas de défilement horizontal');
  await tel.close();
  ok(erreurs.length === 0, `Aucune erreur JavaScript (${erreurs.join(' | ')})`);
} catch (e) {
  E.echec(e.message);
}
await E.terminer({ browser, server, tmp, autres: [modele, exterieur] });
