import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupOwner, startPaginity, stopPaginity, waitJob, type Client } from './helpers.js';

/** Compteur de visites sans cookies : pages HTML vues par des navigateurs, ni robots ni fichiers, aucune donnée personnelle. */
type P = Awaited<ReturnType<typeof startPaginity>>;
const NAVIGATEUR = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';

function visiter(p: P, host: string, chemin: string, entetes: Record<string, string>): Promise<{ status: number; cookie: unknown }> {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: p.ctx.config.sitesPort, path: chemin, headers: { host, ...entetes } }, (r) => {
      r.resume();
      r.on('end', () => setTimeout(() => res({ status: r.statusCode ?? 0, cookie: r.headers['set-cookie'] }), 5));
    }).on('error', rej);
  });
}

describe('Compteur de visites', () => {
  let p: P;
  let c: Client;
  let siteId: string;
  let host: string;
  beforeAll(async () => {
    p = await startPaginity();
    ({ c } = await setupOwner(p));
    const s = (await c.call('POST', '/api/sites', { nom: 'Salon Visites', modele: 'vitrine' })).json;
    siteId = s.id;
    host = `${s.slug}.localhost`;
    const j = await c.call('POST', `/api/sites/${siteId}/publier`, {});
    expect((await waitJob(p, j.json.id)).etat).toBe('reussie');
  }, 60_000);
  afterAll(async () => stopPaginity(p));

  it('compte les pages vues par un navigateur, sans cookie, et ignore le reste', async () => {
    const html = { 'user-agent': NAVIGATEUR, accept: 'text/html,*/*' };
    const r = await visiter(p, host, '/', html);
    expect(r.status).toBe(200);
    expect(r.cookie).toBeUndefined();
    await visiter(p, host, '/index.html', html);
    await visiter(p, host, '/?utm=promo', html);
    await visiter(p, host, '/style.css', { 'user-agent': NAVIGATEUR, accept: 'text/css' }); // pas une page
    await visiter(p, host, '/', { 'user-agent': 'Googlebot/2.1', accept: 'text/html' }); // robot
    await visiter(p, host, '/', { ...html, 'sec-purpose': 'prefetch' }); // préchargement
    await visiter(p, host, '/absente.html', html); // 404
    const v = (await c.call('GET', `/api/sites/${siteId}/visites?jours=7`)).json;
    expect(v.total).toBe(3);
    expect(v.parJour).toHaveLength(7);
    expect(v.parJour.at(-1).vues).toBe(3);
    expect(v.pages).toEqual([{ chemin: '/', vues: 3 }]);
    // Aucune colonne d'adresse ou d'identifiant n'existe.
    const colonnes = (p.ctx.db.prepare('PRAGMA table_info(visites)').all() as { name: string }[]).map((x) => x.name);
    expect(colonnes).toEqual(['site_id', 'jour', 'chemin', 'vues']);
  });
});
