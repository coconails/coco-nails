import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupOwner, startPaginity, stopPaginity, type Client } from './helpers.js';

/** Page de secours : pré-remplie depuis les contenus, validée, autonome (rien d'extérieur), texte échappé. */
type P = Awaited<ReturnType<typeof startPaginity>>;

describe('Page de secours', () => {
  let p: P;
  let c: Client;
  let id: string;
  beforeAll(async () => {
    p = await startPaginity();
    ({ c } = await setupOwner(p));
    id = (await c.call('POST', '/api/sites', { nom: 'Salon Secours', modele: 'vitrine' })).json.id;
  }, 60_000);
  afterAll(async () => stopPaginity(p));

  it('est pré-remplie avec le nom, le téléphone et l’e-mail trouvés dans les contenus', async () => {
    const r = await c.call('GET', `/api/sites/${id}/secours`);
    expect(r.json.enregistree).toBe(false);
    expect(r.json.fiche).toMatchObject({ nom: 'Salon Secours', telephone: '01 23 45 67 89', email: 'contact@exemple.fr' });
    expect(r.json.page).toContain('href="tel:+33123456789"');
  });

  it('vérifie la fiche et échappe le texte', async () => {
    const base = (await c.call('GET', `/api/sites/${id}/secours`)).json.fiche;
    expect((await c.call('PUT', `/api/sites/${id}/secours`, { ...base, nom: '' })).status).toBe(400);
    expect((await c.call('PUT', `/api/sites/${id}/secours`, { ...base, telephone: '', email: '', lien: '' })).json.erreur).toMatch(/au moins un moyen/);
    expect((await c.call('PUT', `/api/sites/${id}/secours`, { ...base, lien: 'javascript:alert(1)' })).status).toBe(400);
    expect((await c.call('PUT', `/api/sites/${id}/secours`, { ...base, couleur: 'red;}' })).status).toBe(400);
    const r = await c.call('PUT', `/api/sites/${id}/secours`, { ...base, nom: 'Coco <script>alert(1)</script>', lien: 'https://wa.me/33768227015', horaires: 'Lun–ven 9 h–19 h' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.page).not.toContain('<script>');
    expect(r.json.page).toContain('Coco &lt;script&gt;');
    expect(r.json.page).toContain('href="https://wa.me/33768227015"');
    // Autonome : aucune ressource extérieure.
    expect(r.json.page).not.toMatch(/<link|<script|src=|@import|url\(/);
  });

  it('se télécharge en un seul fichier index.html', async () => {
    const r = await c.call('GET', `/api/sites/${id}/secours/index.html`);
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toBe('attachment; filename="index.html"');
    expect(r.body).toContain('Lun–ven 9 h–19 h');
  });
});
