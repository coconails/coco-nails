import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSite, setupOwner, startPaginity, stopPaginity, totpCode, type Client } from './helpers.js';

/**
 * Aperçus (P1-5) : une page d'aperçu ne doit jamais pouvoir agir pour de vrai.
 * - Elle ne peut appeler que sa propre adresse (pas le site en ligne, pas un service extérieur).
 * - Ses formulaires ne peuvent être envoyés qu'à elle-même.
 * - Une clé de test identique à la clé de production est refusée.
 */
type P = Awaited<ReturnType<typeof startPaginity>>;

const FICHIERS: Record<string, string> = {
  'netlify.toml': `[build]\n  publish = "public"\n\n[functions]\n  directory = "netlify/functions"\n\n[[headers]]\n  for = "/*"\n  [headers.values]\n    Content-Security-Policy = "default-src 'self' https:; connect-src *"\n    X-Frame-Options = "DENY"\n`,
  'public/index.html': '<!doctype html><title>Accueil</title><p>Bonjour</p>',
  'netlify/functions/page.mjs': 'export default async () => new Response("<p>page</p>", { headers: { "content-type": "text/html", "content-security-policy": "connect-src *" } });\nexport const config = { path: "/api/page" };\n',
  'netlify/functions/cle.mjs': 'export default async () => new Response(process.env.CLE_API ? "oui" : "non");\nexport const config = { path: "/api/cle" };\n',
};

async function writeFiles(c: Client, siteId: string, files: Record<string, string>) {
  for (const [chemin, contenu] of Object.entries(files)) {
    if ((await c.call('GET', `/api/sites/${siteId}/fichier?chemin=${encodeURIComponent(chemin)}`)).status !== 200) {
      await c.call('POST', `/api/sites/${siteId}/fichiers/nouveau`, { chemin });
    }
    const v = (await c.call('GET', `/api/sites/${siteId}/fichier?chemin=${encodeURIComponent(chemin)}`)).json.version;
    const w = await c.call('PUT', `/api/sites/${siteId}/fichier`, { chemin, contenu, version: v });
    if (w.status !== 200) throw new Error(`${chemin} : ${w.body}`);
  }
}

/** Toutes les politiques CSP reçues (un navigateur les applique toutes à la fois). */
function csp(headers: Record<string, any>): string[] {
  const v = headers['content-security-policy'];
  return Array.isArray(v) ? v : v ? String(v).split(/,(?=\s*[a-z-]+ )/) : [];
}

function protege(headers: Record<string, any>): boolean {
  return csp(headers).some((p) => /connect-src 'self'/.test(p) && /form-action 'self'/.test(p) && /frame-ancestors http:\/\/localhost:8080/.test(p));
}

describe('Aperçus : aucune action réelle possible', () => {
  let p: P;
  let c: Client;
  let siteId: string;
  let host: string;

  beforeAll(async () => {
    p = await startPaginity();
    let secret: string;
    ({ c, secret } = await setupOwner(p));
    const conf = await c.call('POST', '/api/confirmation', { motDePasse: 'une phrase de passe solide', code: totpCode(secret, 1) });
    expect(conf.status).toBe(200);
    const s = await c.call('POST', '/api/sites', { nom: 'Apercu', modele: 'vierge' });
    siteId = s.json.id;
    await writeFiles(c, siteId, FICHIERS);
    const a = await c.call('POST', `/api/sites/${siteId}/apercu`, {});
    expect(a.status).toBe(200);
    host = new URL(a.json.url).hostname;
  });
  afterAll(async () => stopPaginity(p));

  it('les pages d’aperçu ne peuvent appeler que leur propre adresse, même si le site prévoit autre chose', async () => {
    const r = await getSite(p, host, '/', { port: p.ctx.config.previewPort });
    expect(r.status).toBe(200);
    expect(protege(r.headers)).toBe(true);
    const absente = await getSite(p, host, '/introuvable', { port: p.ctx.config.previewPort });
    expect(protege(absente.headers)).toBe(true);
  });

  it('refuse une clé de test identique à celle de production (et l’inverse)', async () => {
    const prod = await c.call('PUT', `/api/sites/${siteId}/secrets/production/CLE_API`, { valeur: 'cle-de-production-tres-longue' });
    expect(prod.status).toBe(200);
    const test = await c.call('PUT', `/api/sites/${siteId}/secrets/test/CLE_API`, { valeur: 'cle-de-production-tres-longue' });
    expect(test.status).toBe(400);
    expect(test.json.erreur).toMatch(/identique/);
    expect(p.ctx.db.prepare("SELECT COUNT(*) AS n FROM site_secrets WHERE env = 'test'").get()).toEqual({ n: 0 });
    // Dans l'autre sens.
    expect((await c.call('PUT', `/api/sites/${siteId}/secrets/test/MOT_DE_PASSE`, { valeur: 'phrase-de-test' })).status).toBe(200);
    expect((await c.call('PUT', `/api/sites/${siteId}/secrets/production/MOT_DE_PASSE`, { valeur: 'phrase-de-test' })).status).toBe(400);
    // Un réglage qui n'est pas une clé (ex. nom d'expéditeur) peut être le même partout.
    expect((await c.call('PUT', `/api/sites/${siteId}/secrets/production/EXPEDITEUR`, { valeur: 'CocoNails' })).status).toBe(200);
    expect((await c.call('PUT', `/api/sites/${siteId}/secrets/test/EXPEDITEUR`, { valeur: 'CocoNails' })).status).toBe(200);
  });

  it('les réponses des fonctions dans l’aperçu sont aussi protégées', async () => {
    await c.call('PUT', `/api/sites/${siteId}/secrets/test/CLE_API`, { valeur: 'cle-de-test' });
    const r = await getSite(p, host, '/api/page', { port: p.ctx.config.previewPort });
    expect(r.status, r.body).toBe(200);
    expect(r.body).toContain('page');
    expect(protege(r.headers)).toBe(true);
  });
});
