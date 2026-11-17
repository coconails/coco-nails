// Bibliothèque commune des parcours dans Chromium : démarrage d'un PAGINITY neuf (données temporaires), installation
// du propriétaire avec double authentification, premier site, confirmation d'identité, suivi des contrôles, arrêt propre.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TOTP, Secret } from 'otpauth';

export const require = createRequire(import.meta.url);
export const { chromium } = require('playwright');
const ici = path.dirname(new URL(import.meta.url).pathname);
export const racineE2e = path.join(ici, '..');
export const OUT = process.env.CAPTURES_IA ?? path.join(racineE2e, 'captures');
fs.mkdirSync(OUT, { recursive: true });
export const MDP = 'une phrase de passe solide';
export const totp = (s, d = 0) => new TOTP({ secret: Secret.fromBase32(s), digits: 6, period: 30 }).generate({ timestamp: Date.now() + d * 30_000 });

let echecs = 0;
/** Affiche un contrôle (✔ ou ✘) et compte les échecs. */
export const ok = (c, t) => {
  console.log(`${c ? '✔' : '✘'} ${t}`);
  if (!c) echecs++;
};
export const echec = (message) => {
  console.log('✘ Parcours interrompu :', message);
  echecs++;
};

/** Ports et dossier temporaire d'un parcours. */
export function preparer(nom, premierPort) {
  const P = { admin: premierPort, preview: premierPort + 1, sites: premierPort + 2 };
  const ADMIN = `http://localhost:${P.admin}`;
  const tmp = fs.mkdtempSync(path.join(process.env.MANUEL_TMP ?? os.tmpdir(), `paginity-${nom}-`));
  return { P, ADMIN, tmp };
}

/** Démarre le serveur fabriqué (server/dist) et attend le code d'installation. */
export async function demarrer({ P, ADMIN, tmp }, envEnPlus = {}) {
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(racineE2e, '..', 'server', 'dist', 'index.js')], {
    env: {
      ...process.env,
      PAGINITY_DATA_DIR: path.join(tmp, 'donnees'),
      PAGINITY_ADMIN_PORT: String(P.admin),
      PAGINITY_PREVIEW_PORT: String(P.preview),
      PAGINITY_SITES_PORT: String(P.sites),
      PAGINITY_PUBLIC_URL: ADMIN,
      PAGINITY_ISOLATION: 'processus',
      ...envEnPlus,
    },
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
  return { server, code };
}

/**
 * Installe le propriétaire (double authentification), crée « Salon Démo » (modèle vitrine) et confirme l'identité.
 * Renvoie les en-têtes à joindre aux appels de l'API (`h`), le secret des codes et le site.
 */
export async function installer(ctx, ADMIN, code) {
  const etat = await (await ctx.request.get(`${ADMIN}/api/etat`)).json();
  const h = { 'x-csrf-token': etat.csrf, origin: ADMIN };
  await ctx.request.post(`${ADMIN}/api/installation`, { data: { code, nom: 'Donaven', email: 'proprietaire@exemple.fr', motDePasse: MDP }, headers: h });
  const d = await (await ctx.request.post(`${ADMIN}/api/profil/2fa/totp/debut`, { data: {}, headers: h })).json();
  await ctx.request.post(`${ADMIN}/api/profil/2fa/totp/confirmer`, { data: { code: totp(d.secret) }, headers: h });
  const site = await (await ctx.request.post(`${ADMIN}/api/sites`, { data: { nom: 'Salon Démo', modele: 'vitrine' }, headers: h })).json();
  await ctx.request.post(`${ADMIN}/api/confirmation`, { data: { motDePasse: MDP, code: totp(d.secret, 1) }, headers: h });
  return { h, secret: d.secret, site };
}

/** Arrête tout, efface les données temporaires et sort avec le bon code. */
export async function terminer({ browser, server, tmp, autres = [] }) {
  await browser?.close();
  server?.kill('SIGTERM');
  for (const x of autres) x.close();
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(echecs ? 1 : 0);
}
