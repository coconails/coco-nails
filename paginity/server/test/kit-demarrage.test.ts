import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupOwner, startPaginity, stopPaginity, totpCode, type Client } from './helpers.js';
import { Assistant } from '../src/ia/assistant.js';

/** Kit de démarrage de l'IA : détecter les modèles d'un Ollama (simulé) et les ajouter en un clic. */
type P = Awaited<ReturnType<typeof startPaginity>>;

describe('Kit de démarrage : modèles installés', () => {
  let p: P;
  let c: Client;
  let ollama: http.Server;
  let base: string;
  beforeAll(async () => {
    ollama = http.createServer((req, res) => {
      if (req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3:8b' }, { id: 'glm4:9b' }, { id: 'nomic-embed-text:latest' }] }));
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(ollama.address() as { port: number }).port}`;
    p = await startPaginity();
    let secret: string;
    ({ c, secret } = await setupOwner(p));
    expect((await c.call('POST', '/api/confirmation', { motDePasse: 'une phrase de passe solide', code: totpCode(secret, 1) })).status).toBe(200);
  }, 60_000);
  afterAll(async () => {
    await stopPaginity(p);
    ollama.close();
  });

  it('donne des noms lisibles', () => {
    expect(Assistant.joliNom('qwen3-coder:30b')).toBe('Qwen3-Coder 30b');
    expect(Assistant.joliNom('glm4:9b')).toBe('GLM4 9b');
    expect(Assistant.joliNom('library/deepseek-r1:latest')).toBe('Deepseek-R1');
  });

  it('détecte les modèles (sans ceux qui ne servent pas à écrire) et les ajoute, autorisés', async () => {
    const d = await c.call('POST', '/api/reglages/ia/detecter', { url: `${base}/v1/` });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect(d.json).toEqual({ url: `${base}/v1`, modeles: [{ id: 'qwen3:8b', nom: 'Qwen3 8b', deja: false }, { id: 'glm4:9b', nom: 'GLM4 9b', deja: false }] });
    const a = await c.call('POST', '/api/reglages/ia/ajouter-detectes', { url: base, ids: ['qwen3:8b', 'glm4:9b'] });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(a.json.reglages.locaux.map((l: any) => [l.nom, l.modele, l.actif, l.url])).toEqual([
      ['Qwen3 8b', 'qwen3:8b', true, `${base}/v1`],
      ['GLM4 9b', 'glm4:9b', true, `${base}/v1`],
    ]);
    expect(Object.keys(a.json.enService)).toHaveLength(2);
    // Une seconde détection les marque « déjà ajoutés » ; les rajouter est refusé.
    expect((await c.call('POST', '/api/reglages/ia/detecter', { url: base })).json.modeles.every((m: any) => m.deja)).toBe(true);
    expect((await c.call('POST', '/api/reglages/ia/ajouter-detectes', { url: base, ids: ['qwen3:8b'] })).status).toBe(400);
  });

  it('message clair si rien ne répond ; adresse vérifiée', async () => {
    expect((await c.call('POST', '/api/reglages/ia/detecter', { url: 'http://127.0.0.1:1' })).json.erreur).toMatch(/Ollama est-il démarré/);
    expect((await c.call('POST', '/api/reglages/ia/detecter', { url: 'file:///etc/passwd' })).status).toBe(400);
  });
});
