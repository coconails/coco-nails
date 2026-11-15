import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import yazl from 'yazl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, getSite, setupOwner, startPaginity, stopPaginity, totpCode, waitJob, type Client } from './helpers.js';
import { hooks } from '../src/publish/pipeline.js';
import { JobQueue } from '../src/jobs/queue.js';

type P = Awaited<ReturnType<typeof startPaginity>>;

function makeZip(files: Record<string, string | Buffer>, dest: string): Promise<void> {
  return new Promise((resolve) => {
    const z = new yazl.ZipFile();
    for (const [name, content] of Object.entries(files)) z.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content), name);
    z.end();
    z.outputStream.pipe(fs.createWriteStream(dest)).on('close', () => resolve());
  });
}

function multipart(fields: Record<string, string>, file: { name: string; filename: string; data: Buffer; type: string }) {
  const boundary = '----paginity' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('Sites : contenus, code, publication, versions', () => {
  let p: P;
  let c: Client;
  let siteId: string;
  let slug: string;
  let secret: string;
  let codes: string[];

  beforeAll(async () => {
    p = await startPaginity();
    ({ c, secret, codes } = await setupOwner(p));
  });
  afterAll(async () => stopPaginity(p));

  const host = () => `${slug}.localhost`;

  it('crée un site depuis le modèle « vitrine »', async () => {
    const r = await c.call('POST', '/api/sites', { nom: 'Mon Salon Test', modele: 'vitrine' });
    expect(r.status).toBe(200);
    siteId = r.json.id;
    slug = r.json.slug;
    expect(slug).toBe('mon-salon-test');
    expect(r.json.etat).toBe('jamais_publie');
    const d = await c.call('GET', `/api/sites/${siteId}`);
    expect(d.json.fiche.dossierPublie).toBe('public');
    expect(d.json.contenus.source).toBe('.pages.yml');
    // Pas encore publié : le serveur des sites l'indique.
    expect((await getSite(p, host())).status).toBe(503);
  });

  it('lit les rubriques de contenu et valide les saisies', async () => {
    const list = await c.call('GET', `/api/sites/${siteId}/contenus`);
    expect(list.json.rubriques.map((r: any) => r.nom)).toEqual(['site', 'prestations', 'horaires', 'faq']);
    const e = await c.call('GET', `/api/sites/${siteId}/contenus/site`);
    expect(e.json.valeur.nom).toBe('Mon Salon Test');
    const bad = await c.call('PUT', `/api/sites/${siteId}/contenus/site`, { valeur: { ...e.json.valeur, telephone: 'pas un numéro', nom: '' }, version: e.json.version });
    expect(bad.status).toBe(422);
    expect(bad.json.details.champs.map((x: any) => x.chemin)).toEqual(expect.arrayContaining(['nom', 'telephone']));
    const p1 = await c.call('GET', `/api/sites/${siteId}/contenus/prestations`);
    const valeur = structuredClone(p1.json.valeur);
    valeur.prestations[0].prix = '29 €';
    const ok = await c.call('PUT', `/api/sites/${siteId}/contenus/prestations`, { valeur, version: p1.json.version });
    expect(ok.status).toBe(200);
    expect(ok.json.enregistre).toBe(true);
    // Une deuxième sauvegarde basée sur l'ancienne version est refusée (aucun écrasement silencieux).
    valeur.prestations[0].prix = '99 €';
    const conflict = await c.call('PUT', `/api/sites/${siteId}/contenus/prestations`, { valeur, version: p1.json.version });
    expect(conflict.status).toBe(409);
    const after = await c.call('GET', `/api/sites/${siteId}/contenus/prestations`);
    expect(after.json.valeur.prestations[0].prix).toBe('29 €');
  });

  it('protège le mode code (chemins, JSON invalide, conflits)', async () => {
    expect((await c.call('GET', `/api/sites/${siteId}/fichier?chemin=../../plateforme/paginity.db`)).status).toBe(400);
    expect((await c.call('GET', `/api/sites/${siteId}/fichier?chemin=.git/config`)).status).toBe(400);
    const f = await c.call('GET', `/api/sites/${siteId}/fichier?chemin=public/contenu/faq.json`);
    expect(f.status).toBe(200);
    const invalid = await c.call('PUT', `/api/sites/${siteId}/fichier`, { chemin: 'public/contenu/faq.json', contenu: '{ pas du json', version: f.json.version });
    expect(invalid.status).toBe(422);
    const css = await c.call('GET', `/api/sites/${siteId}/fichier?chemin=public/style.css`);
    const w = await c.call('PUT', `/api/sites/${siteId}/fichier`, { chemin: 'public/style.css', contenu: css.json.contenu + '\n/* ajout */\n', version: css.json.version });
    expect(w.status).toBe(200);
    const stale = await c.call('PUT', `/api/sites/${siteId}/fichier`, { chemin: 'public/style.css', contenu: 'écrasement', version: css.json.version });
    expect(stale.status).toBe(409);
    expect(stale.json.details.conflit).toBe(true);
    const created = await c.call('POST', `/api/sites/${siteId}/fichiers/nouveau`, { chemin: 'public/mentions.html' });
    expect(created.status).toBe(200);
  });

  it('liste les modifications non publiées, champ par champ', async () => {
    const m = await c.call('GET', `/api/sites/${siteId}/modifications`);
    expect(m.json.fichiers.length).toBeGreaterThan(5); // jamais publié : tout est nouveau
  });

  it('prépare un aperçu privé, accessible seulement par une adresse temporaire', async () => {
    const a = await c.call('POST', `/api/sites/${siteId}/apercu`, {});
    expect(a.status).toBe(200);
    const url = new URL(a.json.url);
    expect(url.hostname).toMatch(new RegExp(`^${slug}--[a-z2-7]{16}\\.localhost$`));
    const port = p.ctx.config.previewPort;
    expect((await getSite(p, `${slug}.localhost`, '/', { port })).status).toBe(404);
    expect((await getSite(p, `${slug}--aaaaaaaaaaaaaaaa.localhost`, '/', { port })).status).toBe(404);
    const page = await getSite(p, url.hostname, '/contenu/prestations.json', { port });
    expect(page.status).toBe(200);
    expect(page.body).toContain('29 €');
    expect(page.headers['content-security-policy']).toContain('frame-ancestors http://localhost:8080');
    expect(page.headers['x-robots-tag']).toContain('noindex');
    const fn = await getSite(p, url.hostname, '/api/reserver', { port });
    expect(fn.status).toBe(503);
    expect(fn.body).toMatch(/aucun SMS/);
    // Lien expiré : refusé.
    p.ctx.db.prepare('UPDATE preview_links SET expires_at = 0').run();
    expect((await getSite(p, url.hostname, '/', { port })).status).toBe(404);
  });

  let pub1: number;
  it('publie en 10 étapes et sert la nouvelle version', async () => {
    const j = await c.call('POST', `/api/sites/${siteId}/publier`, { message: 'Première mise en ligne' });
    expect(j.status).toBe(200);
    const done = await waitJob(p, j.json.id);
    expect(done.erreur).toBeNull();
    expect(done.etat).toBe('reussie');
    expect(done.etapes.map((s) => s.etat)).toEqual(['reussi', 'reussi', 'reussi', 'reussi', 'reussi', 'reussi', 'ignore', 'reussi', 'reussi', 'reussi']);
    pub1 = (done.resultat as any).numero;
    const home = await getSite(p, host());
    expect(home.status).toBe(200);
    expect(home.headers['x-paginity-version']).toBe(String(pub1));
    expect(home.body).toContain('<title>Mon Salon Test</title>');
    expect((await getSite(p, host(), '/contenu/prestations.json')).body).toContain('29 €');
    // Fichiers techniques jamais servis.
    expect((await getSite(p, host(), '/.paginity.json')).status).toBe(404);
    expect((await getSite(p, host(), '/../paginity.yml')).status).toBe(404);
    const s = await c.call('GET', `/api/sites/${siteId}`);
    expect(s.json.etat).toBe('en_ligne');
    expect(s.json.modificationsEnAttente).toBe(0);
  });

  it('modifie, compare champ par champ, publie une 2e version, puis restaure la 1re', async () => {
    const e = await c.call('GET', `/api/sites/${siteId}/contenus/prestations`);
    const v = structuredClone(e.json.valeur);
    v.prestations[0].prix = '31 €';
    await c.call('PUT', `/api/sites/${siteId}/contenus/prestations`, { valeur: v, version: e.json.version });
    const m = await c.call('GET', `/api/sites/${siteId}/modifications`);
    expect(m.json.fichiers).toHaveLength(1);
    expect(m.json.fichiers[0].rubrique).toBe('Prestations et tarifs');
    expect(m.json.fichiers[0].champs[0]).toEqual({ champ: 'Prestations › n°1 › Prix', avant: '29 €', apres: '31 €' });
    expect(m.json.fichiers[0].auteurs).toEqual(['Propriétaire']);
    const j = await c.call('POST', `/api/sites/${siteId}/publier`, {});
    const done = await waitJob(p, j.json.id);
    expect(done.etat).toBe('reussie');
    expect((await getSite(p, host(), '/contenu/prestations.json')).body).toContain('31 €');
    // Remise en ligne de la 1re publication : le brouillon n'est pas touché.
    const r = await c.call('POST', `/api/sites/${siteId}/publications/${pub1}/remettre`, {});
    const rd = await waitJob(p, r.json.id);
    expect(rd.etat).toBe('reussie');
    expect((await getSite(p, host(), '/contenu/prestations.json')).body).toContain('29 €');
    const draft = await c.call('GET', `/api/sites/${siteId}/contenus/prestations`);
    expect(draft.json.valeur.prestations[0].prix).toBe('31 €');
    // Reprendre le brouillon depuis la 1re publication.
    expect((await c.call('POST', `/api/sites/${siteId}/publications/${pub1}/reprendre`, {})).status).toBe(200);
    expect((await c.call('GET', `/api/sites/${siteId}/contenus/prestations`)).json.valeur.prestations[0].prix).toBe('29 €');
    const pubs = await c.call('GET', `/api/sites/${siteId}/publications`);
    expect(pubs.json.find((x: any) => x.enLigne).numero).toBe(pub1);
  });

  it('annule les modifications non publiées', async () => {
    const e = await c.call('GET', `/api/sites/${siteId}/contenus/faq`);
    const v = structuredClone(e.json.valeur);
    v.questions.push({ question: 'Nouvelle ?', reponse: 'Oui.' });
    await c.call('PUT', `/api/sites/${siteId}/contenus/faq`, { valeur: v, version: e.json.version });
    expect((await c.call('GET', `/api/sites/${siteId}`)).json.modificationsEnAttente).toBeGreaterThan(0);
    expect((await c.call('POST', `/api/sites/${siteId}/annuler`, {})).status).toBe(200);
    expect((await c.call('GET', `/api/sites/${siteId}`)).json.modificationsEnAttente).toBe(0);
    expect((await c.call('GET', `/api/sites/${siteId}/contenus/faq`)).json.valeur.questions).toHaveLength(2);
  });

  it('revient automatiquement à la version précédente si la vérification en ligne échoue', async () => {
    const before = await getSite(p, host());
    const e = await c.call('GET', `/api/sites/${siteId}/contenus/site`);
    await c.call('PUT', `/api/sites/${siteId}/contenus/site`, { valeur: { ...e.json.valeur, accroche: 'Version cassée' }, version: e.json.version });
    const original = hooks.verifyLive;
    hooks.verifyLive = async () => {
      throw new Error('panne simulée');
    };
    try {
      const j = await c.call('POST', `/api/sites/${siteId}/publier`, {});
      const done = await waitJob(p, j.json.id);
      expect(done.etat).toBe('echouee');
      expect(done.erreur).toMatch(/Retour automatique/);
    } finally {
      hooks.verifyLive = original;
    }
    const after = await getSite(p, host());
    expect(after.headers['x-paginity-version']).toBe(before.headers['x-paginity-version']);
    const s = await c.call('GET', `/api/sites/${siteId}`);
    expect(s.json.etat).toBe('erreur');
    const dash = await c.call('GET', '/api/tableau-de-bord');
    expect(dash.json.alertes.some((a: any) => /a échoué/.test(a.message))).toBe(true);
  });

  it('refuse une publication qui contient un JSON invalide', async () => {
    const f = await c.call('GET', `/api/sites/${siteId}/fichier?chemin=public/contenu/horaires.json`);
    await c.call('PUT', `/api/sites/${siteId}/fichier`, { chemin: 'public/contenu/horaires.json', contenu: '{ cassé', version: f.json.version, forcerJson: true });
    const j = await c.call('POST', `/api/sites/${siteId}/publier`, {});
    const done = await waitJob(p, j.json.id);
    expect(done.etat).toBe('echouee');
    expect(done.etapes.find((s) => s.nom === 'Contrôler')!.etat).toBe('echoue');
    expect(done.erreur).toMatch(/horaires\.json/);
    await c.call('POST', `/api/sites/${siteId}/annuler`, { chemin: 'public/contenu/horaires.json' });
  });

  it('gère la médiathèque (compression, types refusés, suppression contrôlée)', async () => {
    const png = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#e8a93a' } })
      .png()
      .withMetadata({ exif: { IFD0: { Copyright: 'test' } } })
      .toBuffer();
    const up = multipart({}, { name: 'fichier', filename: 'Photo Été.png', data: png, type: 'image/png' });
    const r = await c.call('POST', `/api/sites/${siteId}/medias`, up.body, up.headers);
    expect(r.status).toBe(200);
    expect(r.json.chemin).toBe('public/images/photo-ete.png');
    expect(r.json.url).toBe('/images/photo-ete.png');
    const meta = await sharp(path.join(p.ctx.sites.repoDir(p.ctx.sites.get(siteId)!), r.json.chemin)).metadata();
    expect(meta.width).toBe(2560);
    expect(meta.exif).toBeUndefined();
    const svg = multipart({}, { name: 'fichier', filename: 'x.svg', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), type: 'image/svg+xml' });
    expect((await c.call('POST', `/api/sites/${siteId}/medias`, svg.body, svg.headers)).status).toBe(400);
    const fake = multipart({}, { name: 'fichier', filename: 'image.jpg', data: Buffer.from('#!/bin/sh\necho pirate'), type: 'image/jpeg' });
    expect((await c.call('POST', `/api/sites/${siteId}/medias`, fake.body, fake.headers)).status).toBe(400);
    // Utilisée dans un contenu : suppression refusée sans confirmation.
    const e = await c.call('GET', `/api/sites/${siteId}/contenus/site`);
    await c.call('PUT', `/api/sites/${siteId}/contenus/site`, { valeur: { ...e.json.valeur, image: '/images/photo-ete.png' }, version: e.json.version });
    const del = await c.call('DELETE', `/api/sites/${siteId}/medias?chemin=public/images/photo-ete.png`);
    expect(del.status).toBe(409);
    expect(del.json.details.utilisations).toContain('public/contenu/site.json');
    expect((await c.call('DELETE', `/api/sites/${siteId}/medias?chemin=public/images/photo-ete.png&forcer=1`)).status).toBe(200);
  });

  it('applique les droits par rôle (contributeur)', async () => {
    const inv = await c.call('POST', '/api/invitations', { email: 'contrib@exemple.fr', roles: [{ siteId, role: 'contributeur' }] });
    const token = inv.json.lien.split('/invitation/')[1];
    const g = client(p);
    g.csrf = (await g.call('GET', '/api/etat')).json.csrf;
    await g.call('POST', `/api/invitations/${token}/accepter`, { nom: 'Contributrice', motDePasse: 'une autre phrase solide' });
    const d = await g.call('POST', '/api/profil/2fa/totp/debut', {});
    await g.call('POST', '/api/profil/2fa/totp/confirmer', { code: totpCode(d.json.secret) });
    const other = await c.call('POST', '/api/sites', { nom: 'Autre site', modele: 'vierge' });
    const list = await g.call('GET', '/api/sites');
    expect(list.json.map((s: any) => s.id)).toEqual([siteId]);
    expect((await g.call('GET', `/api/sites/${other.json.id}`)).status).toBe(404);
    const e = await g.call('GET', `/api/sites/${siteId}/contenus/faq`);
    expect((await g.call('PUT', `/api/sites/${siteId}/contenus/faq`, { valeur: e.json.valeur, version: e.json.version })).status).toBe(200);
    expect((await g.call('POST', `/api/sites/${siteId}/publier`, {})).status).toBe(403);
    const f = await g.call('GET', `/api/sites/${siteId}/fichier?chemin=public/style.css`);
    expect((await g.call('PUT', `/api/sites/${siteId}/fichier`, { chemin: 'public/style.css', contenu: 'x', version: f.json.version })).status).toBe(403);
    expect((await g.call('GET', '/api/utilisateurs')).status).toBe(403);
    expect((await g.call('GET', '/api/journal')).status).toBe(403);
  });

  it('exporte un site complet après confirmation d’identité', async () => {
    expect((await c.call('GET', `/api/sites/${siteId}/export`)).status).toBe(403);
    await c.call('POST', '/api/confirmation', { motDePasse: 'une phrase de passe solide', code: codes[0] });
    const r = await c.call('GET', `/api/sites/${siteId}/export`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/zip');
    expect(r.body.length).toBeGreaterThan(1000);
    void secret;
  });

  it('importe une archive ZIP et refuse les chemins dangereux', async () => {
    const dir = fs.mkdtempSync(path.join(p.dir, 'zip-'));
    const evil = path.join(dir, 'evil.zip');
    // yazl refuse « .. » ; on fabrique l'entrée dangereuse à la main.
    await makeZip({ 'site/index.html': '<h1>ok</h1>', 'site/xx/evil.txt': 'x' }, evil);
    const buf = fs.readFileSync(evil);
    const patched = Buffer.from(buf.toString('latin1').replaceAll('site/xx/evil.txt', '../../../evil.t'), 'latin1');
    const up1 = multipart({ nom: 'Pirate' }, { name: 'archive', filename: 'evil.zip', data: patched, type: 'application/zip' });
    const j1 = await c.call('POST', '/api/sites/import', up1.body, up1.headers);
    const d1 = await waitJob(p, j1.json.id);
    expect(d1.etat).toBe('echouee');
    expect(fs.existsSync(path.join(p.dir, '..', 'evil.t'))).toBe(false);

    const good = path.join(dir, 'good.zip');
    await makeZip(
      {
        'mon-site/public/index.html': '<!doctype html><title>Importé</title><a href="/page.html">p</a><a href="/manquante.html">x</a>',
        'mon-site/public/page.html': '<p>page</p>',
        'mon-site/public/data/infos.json': '{"titre":"Bonjour","ouvert":true,"tarifs":[{"nom":"A","prix":10}]}',
        'mon-site/netlify.toml': '[build]\npublish = "public"\n[[redirects]]\nfrom = "/ancien"\nto = "/page.html"\nstatus = 301\n[[headers]]\nfor = "/*"\n[headers.values]\nX-Frame-Options = "DENY"\n',
      },
      good,
    );
    const up2 = multipart({ nom: 'Site importé' }, { name: 'archive', filename: 'good.zip', data: fs.readFileSync(good), type: 'application/zip' });
    const j2 = await c.call('POST', '/api/sites/import', up2.body, up2.headers);
    const d2 = await waitJob(p, j2.json.id);
    expect(d2.erreur).toBeNull();
    const newId = (d2.resultat as any).siteId;
    const contenus = await c.call('GET', `/api/sites/${newId}/contenus`);
    expect(contenus.json.source).toBe('automatique');
    const entry = await c.call('GET', `/api/sites/${newId}/contenus/${contenus.json.rubriques[0].nom}`);
    expect(entry.json.entree.fields.map((f: any) => [f.name, f.type])).toEqual([
      ['titre', 'string'],
      ['ouvert', 'boolean'],
      ['tarifs', 'object'],
    ]);
    const pub = await c.call('POST', `/api/sites/${newId}/publier`, {});
    const pd = await waitJob(p, pub.json.id);
    expect(pd.etat).toBe('reussie');
    expect((pd.resultat as any).avertissements.join(' ')).toMatch(/manquante\.html/);
    const imported = (await c.call('GET', `/api/sites/${newId}`)).json.slug;
    const redir = await getSite(p, `${imported}.localhost`, '/ancien');
    expect(redir.status).toBe(301);
    expect(redir.headers.location).toBe('/page.html');
    expect((await getSite(p, `${imported}.localhost`, '/')).headers['x-frame-options']).toBe('DENY');
    expect((await getSite(p, `${imported}.localhost`, '/page')).status).toBe(200);
  });

  it('marque comme interrompues les activités en cours lors d’un redémarrage', () => {
    p.ctx.db
      .prepare("INSERT INTO jobs (id, type, label, status, steps, payload, created_at) VALUES ('afantome', 'publication', 'Test', 'en_cours', '[]', '{}', 0)")
      .run();
    new JobQueue(p.ctx.db, p.ctx.events, 1);
    expect(p.ctx.jobs.get('afantome')!.etat).toBe('interrompue');
  });
});
