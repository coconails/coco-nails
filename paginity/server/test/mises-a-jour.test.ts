import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupOwner, startPaginity, stopPaginity, totpCode, type Client } from './helpers.js';
import { composants } from '../src/lib/mises-a-jour.js';

/** Failles connues : seule la liste des composants part (registre simulé), alerte si faille, rien n'est mis à jour seul. */
type P = Awaited<ReturnType<typeof startPaginity>>;

describe('Surveillance des failles des composants', () => {
  let p: P;
  let c: Client;
  let registre: http.Server;
  const recus: any[] = [];
  let reponse: unknown = {};
  beforeAll(async () => {
    registre = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        recus.push({ url: req.url, corps: JSON.parse(b) });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reponse));
      });
    });
    await new Promise<void>((r) => registre.listen(0, '127.0.0.1', () => r()));
    process.env.PAGINITY_REGISTRE_URL = `http://127.0.0.1:${(registre.address() as { port: number }).port}`;
    p = await startPaginity();
    let secret: string;
    ({ c, secret } = await setupOwner(p));
    expect((await c.call('POST', '/api/confirmation', { motDePasse: 'une phrase de passe solide', code: totpCode(secret, 1) })).status).toBe(200);
  }, 60_000);
  afterAll(async () => {
    delete process.env.PAGINITY_REGISTRE_URL;
    await stopPaginity(p);
    registre.close();
  });

  it('liste les composants utilisés (sans ceux de développement)', () => {
    const l = composants();
    expect(l.fastify?.length).toBeGreaterThan(0);
    expect(l.vitest).toBeUndefined();
  });

  it('aucune faille : rien à signaler ; seule la liste des composants est envoyée', async () => {
    reponse = {};
    const r = await c.call('POST', '/api/reglages/mises-a-jour/verifier');
    expect(r.json.dernier).toMatchObject({ ok: true, failles: [], erreur: null });
    expect(recus.at(-1).url).toBe('/-/npm/v1/security/advisories/bulk');
    expect(Object.keys(recus.at(-1).corps)).toContain('fastify');
    expect(JSON.stringify(recus.at(-1).corps)).not.toMatch(/proprio|Salon/);
  });

  it('faille connue : listée (la plus grave en premier) et alerte', async () => {
    reponse = { fastify: [{ title: 'Déni de service', severity: 'moderate', url: 'https://exemple.org/a' }], tar: [{ title: 'Écriture hors du dossier', severity: 'high', url: 'https://exemple.org/b' }] };
    const r = await c.call('POST', '/api/reglages/mises-a-jour/verifier');
    expect(r.json.dernier.failles.map((f: any) => [f.paquet, f.gravite])).toEqual([
      ['tar', 'high'],
      ['fastify', 'moderate'],
    ]);
    const al = p.ctx.db.prepare("SELECT level, message FROM alerts ORDER BY id DESC LIMIT 1").get() as { level: string; message: string };
    expect(al.level).toBe('critique');
    expect(al.message).toMatch(/2 faille\(s\).*« tar »/);
  });

  it('registre injoignable : noté, sans alerte ; vérification hebdomadaire désactivée par défaut', async () => {
    expect((await c.call('GET', '/api/reglages/mises-a-jour')).json.hebdo).toBe(false);
    process.env.PAGINITY_REGISTRE_URL = 'http://127.0.0.1:1';
    const r = await c.call('POST', '/api/reglages/mises-a-jour/verifier');
    expect(r.json.dernier.ok).toBe(false);
    expect(r.json.dernier.erreur).toMatch(/Vérification impossible/);
    expect((await c.call('PUT', '/api/reglages/mises-a-jour', { hebdo: true })).json.hebdo).toBe(true);
  });
});
