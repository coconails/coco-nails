import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupOwner, startPaginity, stopPaginity, type Client } from './helpers.js';
import type { Cerveau } from '../src/ia/assistant.js';

/** Diagnostic en lecture seule : constats en français, lien cassé repéré, explication par un modèle local (simulé). */
type P = Awaited<ReturnType<typeof startPaginity>>;
const recu: string[] = [];
const local: Cerveau = {
  nom: 'local:qwen',
  libelle: 'Qwen3',
  tailleMax: 1_000_000,
  delaiMs: 1000,
  async disponible() {
    return true;
  },
  async proposer() {
    return { statut: 'impossible', raison: 'x' };
  },
  async expliquer(_c, texte) {
    recu.push(texte);
    return 'Votre site n’a jamais été publié, et une image manque.';
  },
};

describe('Diagnostic du site', () => {
  let p: P;
  let c: Client;
  let siteId: string;
  beforeAll(async () => {
    p = await startPaginity({ cerveaux: { 'local:qwen': local } });
    ({ c } = await setupOwner(p));
    siteId = (await c.call('POST', '/api/sites', { nom: 'Salon Diag', modele: 'vitrine' })).json.id;
  }, 60_000);
  afterAll(async () => stopPaginity(p));

  it('rassemble les constats sans rien modifier, et repère un lien cassé', async () => {
    const f = (await c.call('GET', `/api/sites/${siteId}/fichier?chemin=public/index.html`)).json;
    const html = f.contenu.replace('</main>', '<img src="/images/absente.jpg" alt=""></main>');
    expect((await c.call('PUT', `/api/sites/${siteId}/fichier`, { chemin: 'public/index.html', contenu: html, version: f.version })).status).toBe(200);
    const avant = (await c.call('GET', `/api/sites/${siteId}/fichier?chemin=public/index.html`)).json.version;
    const r = await c.call('POST', `/api/sites/${siteId}/diagnostic`, { ia: false });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const titres = r.json.constats.map((x: any) => x.titre);
    expect(titres).toContain('Jamais publié');
    expect(titres).toContain('Liens ou fichiers manquants');
    expect(r.json.constats.find((x: any) => x.titre === 'Liens ou fichiers manquants').detail).toContain('absente.jpg');
    expect(r.json.explication).toBeNull();
    expect((await c.call('GET', `/api/sites/${siteId}/fichier?chemin=public/index.html`)).json.version).toBe(avant);
  });

  it('l’explication vient d’un modèle local, seulement si l’assistant est actif', async () => {
    expect((await c.call('POST', `/api/sites/${siteId}/diagnostic`)).json.explication).toBeNull();
    // Activation (sudo nécessaire) : directement dans les réglages pour ce test.
    p.ctx.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ia', ?)").run(JSON.stringify({ active: true }));
    const r = await c.call('POST', `/api/sites/${siteId}/diagnostic`);
    expect(r.json.explication).toEqual({ texte: 'Votre site n’a jamais été publié, et une image manque.', par: 'Qwen3' });
    expect(recu.at(-1)).toContain('[attention] Jamais publié');
  });
});
