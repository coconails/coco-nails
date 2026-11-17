import crypto from 'node:crypto';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupOwner, startPaginity, stopPaginity, totpCode, waitJob, type Client } from './helpers.js';
import { rediger, SEUIL_IMPRESSIONS } from '../src/marketing/searchconsole.js';

/**
 * M2 — Search Console en lecture seule, face à un FAUX Google qui vérifie la signature du jeton, le périmètre
 * (webmasters.readonly uniquement, sans « sub ») et le jeton d'accès à chaque appel. Aucun appel réel à Google.
 */
type P = Awaited<ReturnType<typeof startPaginity>>;
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const CLE = JSON.stringify({ type: 'service_account', project_id: 'essai', client_email: 'paginity-seo@essai.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
const JETON = 'jeton-acces-simule';
const assertions: Record<string, unknown>[] = [];
const appels: { url: string; corps: any }[] = [];
const indexnow: any[] = [];

/** Données simulées : 3 apparitions par jour et 1 clic tous les deux jours pour salon.fr ; très peu pour petit.fr. */
function analyse(prop: string, c: any) {
  const jours: string[] = [];
  for (let t = Date.parse(`${c.startDate}T12:00:00Z`); t <= Date.parse(`${c.endDate}T12:00:00Z`); t += 86_400_000) jours.push(new Date(t).toISOString().slice(0, 10));
  const parJour = (j: string) => (prop === 'sc-domain:petit.fr' ? { clicks: 0, impressions: 1 } : { clicks: Number(j.slice(-1)) % 2, impressions: j < '2026-10-20' ? 4 : 6 });
  if (c.dimensions?.[0] === 'date') return jours.map((j) => ({ keys: [j], ...parJour(j), ctr: 0, position: 8 }));
  if (c.dimensions?.[0] === 'query')
    return [
      { keys: ['coco nails'], clicks: 9, impressions: 70, ctr: 0.128, position: 1.4 },
      { keys: ['pose gel la suze'], clicks: 0, impressions: 45, ctr: 0, position: 7.2 },
    ];
  if (c.dimensions?.[0] === 'page') return [{ keys: ['https://salon.fr/'], clicks: 9, impressions: 160, ctr: 0.056, position: 5 }];
  const s = jours.reduce((a, j) => ({ clicks: a.clicks + parJour(j).clicks, impressions: a.impressions + parJour(j).impressions }), { clicks: 0, impressions: 0 });
  return [{ ...s, ctr: s.impressions ? s.clicks / s.impressions : 0, position: 8.25 }];
}

describe('Search Console (lecture seule, faux Google)', () => {
  let p: P;
  let c: Client;
  let google: http.Server;
  let siteId: string;
  let petitId: string;
  beforeAll(async () => {
    google = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        const json = (code: number, o: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(o));
        if (req.url === '/token') {
          const a = new URLSearchParams(b).get('assertion') ?? '';
          const [h, charge, sig] = a.split('.');
          const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${charge}`), publicKey, Buffer.from(sig ?? '', 'base64url'));
          const claims = JSON.parse(Buffer.from(charge, 'base64url').toString());
          assertions.push(claims);
          return ok ? json(200, { access_token: JETON, expires_in: 3600 }) : json(400, { error: 'invalid_grant' });
        }
        if (req.url === '/indexnow') {
          indexnow.push(JSON.parse(b));
          return res.writeHead(202).end();
        }
        if (req.headers.authorization !== `Bearer ${JETON}`) return json(401, {});
        appels.push({ url: req.url!, corps: b ? JSON.parse(b) : null });
        if (req.url === '/webmasters/v3/sites')
          return json(200, { siteEntry: [{ siteUrl: 'sc-domain:salon.fr', permissionLevel: 'siteRestrictedUser' }, { siteUrl: 'sc-domain:petit.fr', permissionLevel: 'siteFullUser' }, { siteUrl: 'https://non-verifie.fr/', permissionLevel: 'siteUnverifiedUser' }] });
        const m = /^\/webmasters\/v3\/sites\/([^/]+)\/searchAnalytics\/query$/.exec(req.url!);
        if (m) {
          const prop = decodeURIComponent(m[1]);
          if (prop === 'sc-domain:interdit.fr') return json(403, {});
          return json(200, { rows: analyse(prop, JSON.parse(b)) });
        }
        if (req.url === '/v1/urlInspection/index:inspect')
          return json(200, { inspectionResult: { indexStatusResult: { verdict: 'PASS', coverageState: 'Envoyée et indexée', lastCrawlTime: '2026-11-10T08:00:00Z', googleCanonical: JSON.parse(b).inspectionUrl, robotsTxtState: 'ALLOWED' } } });
        json(404, {});
      });
    });
    await new Promise<void>((r) => google.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(google.address() as { port: number }).port}`;
    Object.assign(process.env, { PAGINITY_GOOGLE_TOKEN_URL: `${base}/token`, PAGINITY_GOOGLE_API_URL: base, PAGINITY_GOOGLE_INSPECTION_URL: base, PAGINITY_INDEXNOW_URL: `${base}/indexnow` });
    p = await startPaginity();
    let secret: string;
    ({ c, secret } = await setupOwner(p));
    siteId = (await c.call('POST', '/api/sites', { nom: 'Salon GSC', modele: 'vitrine' })).json.id;
    petitId = (await c.call('POST', '/api/sites', { nom: 'Petit site', modele: 'vitrine' })).json.id;
    expect((await c.call('POST', '/api/confirmation', { motDePasse: 'une phrase de passe solide', code: totpCode(secret, 1) })).status).toBe(200);
  }, 60_000);
  afterAll(async () => {
    for (const k of ['PAGINITY_GOOGLE_TOKEN_URL', 'PAGINITY_GOOGLE_API_URL', 'PAGINITY_GOOGLE_INSPECTION_URL', 'PAGINITY_INDEXNOW_URL']) delete process.env[k];
    await stopPaginity(p);
    google.close();
  });

  it('refuse un fichier qui n’est pas une clé de compte de service', async () => {
    expect((await c.call('POST', '/api/reglages/search-console', { cle: 'pas du json' })).status).toBe(400);
    expect((await c.call('POST', '/api/reglages/search-console', { cle: JSON.stringify({ type: 'authorized_user' }) })).status).toBe(400);
  });

  it('se connecte en lecture seule : périmètre unique, sans usurpation, clé jamais réaffichée', async () => {
    const r = await c.call('POST', '/api/reglages/search-console', { cle: CLE });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.proprietes.map((x: any) => x.siteUrl)).toEqual(['sc-domain:salon.fr', 'sc-domain:petit.fr']); // non vérifiées exclues
    const claims = assertions.at(-1)!;
    expect(claims.scope).toBe('https://www.googleapis.com/auth/webmasters.readonly');
    expect(claims.sub).toBeUndefined();
    expect(claims.iss).toBe('paginity-seo@essai.iam.gserviceaccount.com');
    const g = await c.call('GET', '/api/reglages/search-console');
    expect(g.json).toMatchObject({ connecte: true, email: 'paginity-seo@essai.iam.gserviceaccount.com' });
    expect(JSON.stringify(g.json)).not.toContain('PRIVATE KEY');
    const brut = (p.ctx.db.prepare("SELECT value FROM settings WHERE key = 'gsc_cle'").get() as { value: string }).value;
    expect(brut).not.toContain('PRIVATE KEY'); // chiffrée dans le coffre
  });

  it('relie un site à une propriété accessible seulement', async () => {
    expect((await c.call('PUT', `/api/sites/${siteId}/search-console`, { propriete: 'sc-domain:inconnu.fr' })).status).toBe(400);
    expect((await c.call('PUT', `/api/sites/${siteId}/search-console`, { propriete: 'sc-domain:salon.fr' })).json.propriete).toBe('sc-domain:salon.fr');
    expect((await c.call('PUT', `/api/sites/${petitId}/search-console`, { propriete: 'sc-domain:petit.fr' })).status).toBe(200);
  });

  it('relève 28 jours (et les 28 précédents), avec un retard de 3 jours, et rédige un rapport prudent', async () => {
    appels.length = 0;
    const r = await c.call('POST', `/api/sites/${siteId}/search-console/releve`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const rap = r.json.rapport;
    const fin = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    expect(rap.fin).toBe(fin);
    expect(rap.total.impressions).toBeGreaterThanOrEqual(SEUIL_IMPRESSIONS);
    expect(r.json.jours).toHaveLength(28);
    expect(appels.every((a) => a.corps === null || a.corps.type === 'web')).toBe(true);
    const texte = rap.redaction.phrases.join(' ');
    expect(texte).toMatch(/Position moyenne : 8,3\. C’est une moyenne sur toutes les apparitions/);
    expect(texte).toMatch(/Par rapport aux 28 jours précédents : apparitions [+-]\d+ %/);
    expect(rap.redaction.pistes).toEqual([expect.stringContaining('« pose gel la suze » : vu 45 fois')]);
  });

  it('peu de données : le rapport le dit et ne compare pas', async () => {
    const r = (await c.call('POST', `/api/sites/${petitId}/search-console/releve`)).json;
    expect(r.rapport.redaction.significatif).toBe(false);
    expect(r.rapport.redaction.phrases.join(' ')).toMatch(/trop faibles pour tirer des conclusions/);
    expect(rediger({ ...r.rapport, total: { clics: 0, impressions: 0, ctr: 0, position: null } }).phrases.join(' ')).not.toMatch(/Position moyenne/);
  });

  it('inspection de l’indexation (page d’accueil de la propriété quand il n’y a pas de sitemap)', async () => {
    const r = (await c.call('POST', `/api/sites/${siteId}/search-console/inspection`)).json;
    expect(r.inspection.resultats).toEqual([expect.objectContaining({ adresse: 'https://salon.fr/', verdict: 'PASS', couverture: 'Envoyée et indexée' })]);
  });

  it('accès refusé par Google : message clair, et alerte lors du relevé quotidien', async () => {
    p.ctx.db.prepare("UPDATE seo_gsc_liens SET propriete = 'sc-domain:interdit.fr' WHERE site_id = ?").run(petitId);
    const r = await c.call('POST', `/api/sites/${petitId}/search-console/releve`);
    expect(r.status).toBe(403);
    expect(r.json.erreur).toMatch(/ajoutez-le comme utilisateur/);
    p.ctx.db.prepare("UPDATE seo_gsc_releves SET le = le - ? WHERE site_id = ?").run(30 * 3_600_000, petitId);
    await p.ctx.searchConsole.tic();
    const al = p.ctx.db.prepare('SELECT message FROM alerts WHERE site_id = ? ORDER BY id DESC LIMIT 1').get(petitId) as { message: string };
    expect(al.message).toMatch(/Search Console \(« Petit site »\) : relevé impossible/);
  });

  it('IndexNow (désactivé par défaut) : fichier de clé servi, pages signalées après publication', async () => {
    expect((await c.call('PATCH', `/api/sites/${siteId}`, { domaines: ['salon.fr'] })).status).toBe(200);
    const r = (await c.call('PUT', `/api/sites/${siteId}/indexnow`, { actif: true })).json.indexnow;
    expect(r.cle).toMatch(/^[0-9a-f]{32}$/);
    const j = await c.call('POST', `/api/sites/${siteId}/publier`, {});
    expect((await waitJob(p, j.json.id)).etat).toBe('reussie');
    const fichier = await new Promise<string>((res) => http.get({ host: '127.0.0.1', port: p.ctx.config.sitesPort, path: `/${r.cle}.txt`, headers: { host: 'salon.fr' } }, (x) => { let b = ''; x.on('data', (d) => (b += d)); x.on('end', () => res(b)); }));
    expect(fichier).toBe(r.cle);
    for (let i = 0; i < 50 && !indexnow.length; i++) await new Promise((x) => setTimeout(x, 20));
    expect(indexnow[0]).toEqual({ host: 'salon.fr', key: r.cle, keyLocation: `https://salon.fr/${r.cle}.txt`, urlList: ['https://salon.fr/'] });
  });

  it('déconnexion : clé, liaisons et données effacées', async () => {
    const r = await c.call('DELETE', '/api/reglages/search-console');
    expect(r.json.connecte).toBe(false);
    expect((p.ctx.db.prepare('SELECT COUNT(*) AS n FROM seo_gsc_jours').get() as { n: number }).n).toBe(0);
    expect((await c.call('POST', `/api/sites/${siteId}/search-console/releve`)).status).toBe(409);
  });
});
