import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, setupOwner, startPaginity, stopPaginity, totpCode, type Client } from './helpers.js';

/**
 * Avant d'accueillir des sites de clients (P2) : le code qui s'exécute SUR LE SERVEUR (fonctions, étape de
 * préparation, réglages de fabrication et dépendances) est réservé au propriétaire de la plateforme.
 * Un administrateur de site garde la main sur ses pages, ses styles, ses scripts du navigateur et ses contenus.
 */
type P = Awaited<ReturnType<typeof startPaginity>>;

describe('Code exécuté sur le serveur : réservé au propriétaire', () => {
  let p: P;
  let c: Client;
  let admin: Client;
  let siteId: string;

  async function ecrire(qui: Client, chemin: string, contenu: string) {
    let f = await qui.call('GET', `/api/sites/${siteId}/fichier?chemin=${encodeURIComponent(chemin)}`);
    if (f.status === 404 || f.status === 400) {
      const n = await qui.call('POST', `/api/sites/${siteId}/fichiers/nouveau`, { chemin });
      if (n.status !== 200) return n;
      f = await qui.call('GET', `/api/sites/${siteId}/fichier?chemin=${encodeURIComponent(chemin)}`);
    }
    return qui.call('PUT', `/api/sites/${siteId}/fichier`, { chemin, contenu, version: f.json.version });
  }

  beforeAll(async () => {
    p = await startPaginity();
    ({ c } = await setupOwner(p));
    const s = await c.call('POST', '/api/sites', { nom: 'Client', modele: 'vitrine' });
    siteId = s.json.id;
    for (const [chemin, contenu] of Object.entries({
      'paginity.yml': 'dossier_publie: public\nfonctions:\n  dossier: netlify/functions\n  format: netlify-v2\n',
      'netlify/functions/ok.mjs': 'export default async () => new Response("ok");\nexport const config = { path: "/api/ok" };\n',
      'outils/preparer.mjs': 'console.log("préparation");\n',
    })) {
      const r = await ecrire(c, chemin, contenu);
      expect(r.status, `${chemin} : ${r.body}`).toBe(200);
    }
    const inv = await c.call('POST', '/api/invitations', { email: 'client@exemple.fr', roles: [{ siteId, role: 'admin_site' }] });
    const token = inv.json.lien.split('/invitation/')[1];
    admin = client(p, { remoteAddress: '10.1.1.1' });
    admin.csrf = (await admin.call('GET', '/api/etat')).json.csrf;
    await admin.call('POST', `/api/invitations/${token}/accepter`, { nom: 'Cliente', motDePasse: 'une autre phrase solide' });
    const d = await admin.call('POST', '/api/profil/2fa/totp/debut', {});
    await admin.call('POST', '/api/profil/2fa/totp/confirmer', { code: totpCode(d.json.secret) });
  });
  afterAll(async () => stopPaginity(p));

  it('l’administrateur du site modifie ses pages, styles et scripts du navigateur', async () => {
    expect((await ecrire(admin, 'public/style.css', 'body{}')).status).toBe(200);
    expect((await ecrire(admin, 'public/menu.js', 'console.log(1)')).status).toBe(200);
    expect((await ecrire(admin, 'public/nouvelle.html', '<p>x</p>')).status).toBe(200);
  });

  it('mais pas les fonctions serveur, la préparation, les réglages de fabrication ni les dépendances', async () => {
    for (const chemin of ['netlify/functions/ok.mjs', 'netlify/functions/nouvelle.mjs', 'paginity.yml', 'netlify.toml', 'package.json', 'outils/preparer.mjs', 'outils/autre.ts']) {
      const r = await ecrire(admin, chemin, 'export default 1');
      expect(r.status, chemin).toBe(403);
      expect(r.json.erreur, chemin).toMatch(/propriétaire de la plateforme/);
    }
    // Renommer un script du navigateur en fonction serveur, ou supprimer une fonction : refusé aussi.
    expect((await admin.call('POST', `/api/sites/${siteId}/fichiers/renommer`, { de: 'public/menu.js', vers: 'netlify/functions/menu.mjs' })).status).toBe(403);
    expect((await admin.call('DELETE', `/api/sites/${siteId}/fichier?chemin=netlify/functions/ok.mjs`)).status).toBe(403);
    expect((await admin.call('DELETE', `/api/sites/${siteId}/fichier?chemin=netlify`)).status).toBe(403);
    // Rien n'a changé.
    expect((await c.call('GET', `/api/sites/${siteId}/fichier?chemin=netlify/functions/ok.mjs`)).json.contenu).toContain('Response("ok")');
  });

  it('un contenu ne peut pas être détourné pour écrire dans le code serveur', async () => {
    const f = await c.call('GET', `/api/sites/${siteId}/fichier?chemin=.pages.yml`);
    const yml = f.status === 200 ? f.json.contenu : null;
    const piege = 'content:\n  - name: piege\n    label: Piège\n    type: file\n    path: netlify/functions/piege.mjs\n    format: json\n    fields:\n      - name: x\n        type: string\n';
    const w = await ecrire(admin, '.pages.yml', piege);
    expect(w.status, w.body).toBe(200);
    const e = await admin.call('GET', `/api/sites/${siteId}/contenus/piege`);
    const r = await admin.call('PUT', `/api/sites/${siteId}/contenus/piege`, { valeur: { x: 'y' }, version: e.json?.version ?? null });
    expect(r.status, r.body).toBe(403);
    void yml;
  });

  it('le propriétaire de la plateforme garde tous les droits', async () => {
    expect((await ecrire(c, 'netlify/functions/ok.mjs', 'export default async () => new Response("ok2");\nexport const config = { path: "/api/ok" };\n')).status).toBe(200);
  });

  it('revenir à une version publiée qui changerait le code serveur est réservé au propriétaire', async () => {
    p.ctx.db.prepare("INSERT INTO site_members (site_id, user_id, role) SELECT ?, id, 'admin_site' FROM users WHERE email = 'client@exemple.fr' ON CONFLICT DO NOTHING").run(siteId);
    // Le propriétaire a publié une 1re version, puis changé la fonction.
    const site = p.ctx.sites.get(siteId)!;
    const repo = p.ctx.sites.repo(site);
    await repo.tag('pub-1', (await repo.head())!);
    expect((await ecrire(c, 'netlify/functions/ok.mjs', 'export default async () => new Response("corrigée");\nexport const config = { path: "/api/ok" };\n')).status).toBe(200);
    expect((await admin.call('POST', `/api/sites/${siteId}/publications/1/reprendre`, {})).status).toBe(403);
    expect((await c.call('GET', `/api/sites/${siteId}/fichier?chemin=netlify/functions/ok.mjs`)).json.contenu).toContain('corrigée');
    // Une version qui ne diffère que par les pages : permise.
    expect((await ecrire(admin, 'public/style.css', 'body{color:red}')).status).toBe(200);
    await repo.tag('pub-2', (await repo.head())!);
    expect((await ecrire(admin, 'public/style.css', 'body{color:blue}')).status).toBe(200);
    expect((await admin.call('POST', `/api/sites/${siteId}/publications/2/reprendre`, {})).status).toBe(200);
  });

  it('un administrateur du site ne peut ni rétrograder ni retirer un autre administrateur (seul le propriétaire le peut)', async () => {
    // Un second administrateur, nommé par le propriétaire.
    const inv = await c.call('POST', '/api/invitations', { email: 'second@exemple.fr', roles: [{ siteId, role: 'admin_site' }] });
    const token = inv.json.lien.split('/invitation/')[1];
    const autre = client(p, { remoteAddress: '10.1.1.2' });
    autre.csrf = (await autre.call('GET', '/api/etat')).json.csrf;
    await autre.call('POST', `/api/invitations/${token}/accepter`, { nom: 'Second', motDePasse: 'une troisième phrase solide' });
    const second = (p.ctx.db.prepare("SELECT id FROM users WHERE email = 'second@exemple.fr'").get() as { id: string }).id;
    const role = () => (p.ctx.db.prepare('SELECT role FROM site_members WHERE site_id = ? AND user_id = ?').get(siteId, second) as { role: string } | undefined)?.role;
    expect((await admin.call('PUT', `/api/sites/${siteId}/membres/${second}`, { role: 'contributeur' })).status).toBe(403);
    expect((await admin.call('DELETE', `/api/sites/${siteId}/membres/${second}`)).status).toBe(403);
    expect(role()).toBe('admin_site');
    // Le propriétaire, lui, le peut.
    expect((await c.call('PUT', `/api/sites/${siteId}/membres/${second}`, { role: 'editeur' })).status).toBe(200);
    expect(role()).toBe('editeur');
    // Et l'administrateur gère normalement les éditeurs et contributeurs.
    expect((await admin.call('PUT', `/api/sites/${siteId}/membres/${second}`, { role: 'contributeur' })).status).toBe(200);
    expect((await admin.call('DELETE', `/api/sites/${siteId}/membres/${second}`)).status).toBe(200);
    expect(role()).toBeUndefined();
  });
});
