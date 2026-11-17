import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupOwner, startPaginity, stopPaginity, totpCode, type Client } from './helpers.js';

/**
 * Alerte de panne : PAGINITY envoie un « battement » à un service de surveillance (ici simulé) ; s'il va mal,
 * il envoie « /fail ». Adresse https obligatoire (sauf essai sur la machine), aucune donnée envoyée.
 */
type P = Awaited<ReturnType<typeof startPaginity>>;

describe('Alerte de panne (battement de cœur)', () => {
  let p: P;
  let c: Client;
  let service: http.Server;
  let base: string;
  const recus: { url: string; methode: string; corps: string }[] = [];
  let reponse = 200;

  beforeAll(async () => {
    service = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        recus.push({ url: req.url!, methode: req.method!, corps: b });
        res.writeHead(reponse).end('OK');
      });
    });
    await new Promise<void>((r) => service.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(service.address() as { port: number }).port}/ping/abc-123`;
    p = await startPaginity();
    let secret: string;
    ({ c, secret } = await setupOwner(p));
    expect((await c.call('POST', '/api/confirmation', { motDePasse: 'une phrase de passe solide', code: totpCode(secret, 1) })).status).toBe(200);
  }, 60_000);
  afterAll(async () => {
    await stopPaginity(p);
    service.close();
  });

  it('valide l’adresse du service', async () => {
    expect((await c.call('PUT', '/api/reglages/battement', { active: true })).json.erreur).toMatch(/adresse/);
    expect((await c.call('PUT', '/api/reglages/battement', { url: 'http://exemple.fr/ping' })).json.erreur).toMatch(/https/);
    expect((await c.call('PUT', '/api/reglages/battement', { url: 'pas une adresse' })).status).toBe(400);
    expect((await c.call('PUT', '/api/reglages/battement', { url: 'https://moi:secret@exemple.fr/x' })).status).toBe(400);
    expect((await c.call('PUT', '/api/reglages/battement', { url: base, minutes: 0 })).status).toBe(400);
    const r = await c.call('PUT', '/api/reglages/battement', { active: true, url: base, minutes: 5 });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ reglages: { active: true, minutes: 5 }, panne: null });
  });

  it('tout va bien : un simple GET, sans aucune donnée', async () => {
    recus.length = 0;
    const r = await c.call('POST', '/api/reglages/battement/essai');
    expect(r.json.dernier).toMatchObject({ ok: true, panne: null });
    expect(recus).toEqual([{ url: '/ping/abc-123', methode: 'GET', corps: '' }]);
  });

  it('le service répond mal ou ne répond pas : c’est noté', async () => {
    reponse = 404;
    expect((await c.call('POST', '/api/reglages/battement/essai')).json.dernier).toMatchObject({ ok: false, reponse: 'le service a répondu 404' });
    reponse = 200;
    await c.call('PUT', '/api/reglages/battement', { url: 'http://127.0.0.1:1/ping' });
    expect((await c.call('POST', '/api/reglages/battement/essai')).json.dernier.reponse).toMatch(/injoignable/);
    await c.call('PUT', '/api/reglages/battement', { url: base });
  });

  it('PAGINITY tourne mais va mal (serveur des sites arrêté) : signal « /fail »', async () => {
    recus.length = 0;
    await new Promise((r) => p.sitesServer.close(() => r(null)));
    const r = await c.call('POST', '/api/reglages/battement/essai');
    expect(r.json.dernier).toMatchObject({ ok: true, panne: 'le serveur des sites ne répond plus' });
    expect(recus.map((x) => x.url)).toEqual(['/ping/abc-123/fail']);
    await new Promise<void>((res) => p.sitesServer.listen(0, '127.0.0.1', () => res()));
  });
});
