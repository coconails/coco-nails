// Assistant, améliorations, dans Chromium : question de précision et réponse, annulation d'une modification acceptée,
// dictée vocale (reconnaissance vocale SIMULÉE dans la page : aucun micro, aucun service), banc qui apprend.
// Un FAUX modèle local. Lancement : npm run build && node e2e/assistant-plus.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as E from './lib/paginity.mjs';

const { require, chromium, OUT, ok } = E;
const { P, ADMIN, tmp } = E.preparer('plus', 18810);

/** Faux modèle : pose une question si la demande n'a pas de réponse, sinon change l'accroche. */
const modele = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    if (req.url.endsWith('/models')) return res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
    const msgs = JSON.parse(b).messages;
    if (msgs[0].content.includes('pas informaticienne')) {
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'Votre site n’a pas encore été publié. Les liens sont en ordre : vérifiez l’aperçu, puis publiez.' } }] }));
    }
    const u = msgs[1].content;
    if (u.includes('MODE PAGES ET STYLES')) {
      const css = JSON.parse(u.split('<contenus>\n')[1].split('\n</contenus>')[0]).find((r) => r.rubrique === 'fichier:public/style.css').valeur;
      const rep = { statut: 'proposition', changements: [{ rubrique: 'fichier:public/style.css', valeur_json: JSON.stringify(css.replace('--accent: #b7791f', '--accent: #2f9e44')) }], explication: 'Couleur d’accent passée au vert (boutons, titres).', raison: '' };
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(rep) } }] }));
    }
    const site = JSON.parse(u.split('<contenus>\n')[1].split('\n</contenus>')[0]).find((r) => r.rubrique === 'site').valeur;
    const reponse = /Réponse : (.*)/.exec(u)?.[1];
    const rep = reponse
      ? { statut: 'proposition', changements: [{ rubrique: 'site', valeur_json: JSON.stringify({ ...site, accroche: reponse }) }], explication: `Accroche remplacée par « ${reponse} ».`, raison: '' }
      : { statut: 'question', changements: [], explication: '', raison: 'Quel texte voulez-vous pour la nouvelle accroche ?' };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(rep) } }] }));
  });
});
await new Promise((r) => modele.listen(0, '127.0.0.1', r));

const { server, code } = await E.demarrer({ P, ADMIN, tmp });

const browser = await chromium.launch();
const erreurs = [];
try {
  const ctx = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const { h, site } = await E.installer(ctx, ADMIN, code);
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

  // 5. Pages et styles : avant / après.
  await page.goto(`${ADMIN}/sites/${site.id}/assistant`);
  await main.getByText('Pages et styles (HTML, CSS)').click();
  await main.getByLabel('Votre demande').fill('Mets les boutons en vert');
  await main.getByRole('button', { name: 'Envoyer à l’assistant' }).click();
  await main.getByText('Couleur d’accent passée au vert (boutons, titres).').waitFor();
  ok(await main.locator('[data-diff]').first().getByText('--accent: #2f9e44').isVisible(), 'Pages et styles : différence ligne à ligne affichée (ancienne ligne / nouvelle ligne)');
  await capture('E6-1-pages-diff.png');
  await main.getByRole('button', { name: 'Voir avant / après' }).click();
  const avantF = page.frameLocator('iframe[title="Aperçu avant"]');
  const apresF = page.frameLocator('iframe[title="Aperçu après"]');
  await avantF.locator('.bouton').first().waitFor({ timeout: 30000 });
  await apresF.locator('.bouton').first().waitFor({ timeout: 30000 });
  const couleur = async (f) => f.locator('.bouton').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  const ca = await couleur(avantF);
  const cb = await couleur(apresF);
  ok(ca === 'rgb(183, 121, 31)' && cb === 'rgb(47, 158, 68)', `Avant / après : bouton doré avant, vert après (${ca} → ${cb})`);
  await page.waitForTimeout(500);
  await capture('E6-2-avant-apres.png');
  await page.keyboard.press('Escape');
  const cssBrouillon = await (await ctx.request.get(`${ADMIN}/api/sites/${site.id}/fichier?chemin=public/style.css`)).json();
  ok(cssBrouillon.contenu.includes('--accent: #b7791f'), 'Rien n’est écrit tant que la proposition n’est pas acceptée');
  // 6. Diagnostic.
  const diag = main.locator('[data-section="diagnostic"]');
  await diag.getByRole('button', { name: 'Lancer le diagnostic' }).click();
  await diag.getByText('En bref (Qwen3)').waitFor({ timeout: 30000 });
  ok(await diag.getByText('Jamais publié').isVisible(), 'Diagnostic : constats en français (ex. « Jamais publié ») et explication par le modèle local');
  await diag.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 76));
  await capture('E6-3-diagnostic.png');

  ok(erreurs.length === 0, `Aucune erreur JavaScript (${erreurs.join(' | ')})`);
} catch (e) {
  E.echec(e.message);
} finally {
  await browser.close();
  server.kill('SIGTERM');
  modele.close();
}
await E.terminer({ tmp });
