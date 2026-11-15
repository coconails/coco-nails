import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSite, setupOwner, startPaginity, stopPaginity, waitJob, type Client } from './helpers.js';

/**
 * Export puis réimport d'un site (P1-4) : le site doit pouvoir être reconstruit sur une installation propre,
 * avec son historique, ses données et les messages de ses formulaires. Les secrets ne voyagent jamais.
 */
type P = Awaited<ReturnType<typeof startPaginity>>;

function multipartZip(nom: string, data: Buffer) {
  const boundary = '----export';
  return {
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="nom"\r\n\r\n${nom}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="export.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function zipEntries(buf: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const out = new Map<string, Buffer>();
      zip.on('entry', (e: yauzl.Entry) => {
        zip.openReadStream(e, (e2, s) => {
          if (e2 || !s) return reject(e2);
          const chunks: Buffer[] = [];
          s.on('data', (c) => chunks.push(c));
          s.on('end', () => {
            out.set(e.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(out));
      zip.readEntry();
    });
  });
}

describe('Export puis réimport d’un site sur une installation propre', () => {
  let a: P;
  let b: P;
  let ca: Client;
  let cb: Client;
  let codesA: string[];
  let codesB: string[];
  let siteId: string;
  let archive: Buffer;
  let commitsAvant: number;

  beforeAll(async () => {
    a = await startPaginity();
    ({ c: ca, codes: codesA } = await setupOwner(a));
    b = await startPaginity();
    ({ c: cb, codes: codesB } = await setupOwner(b));
  });
  afterAll(async () => {
    await stopPaginity(a);
    await stopPaginity(b);
  });

  it('prépare un site avec historique, données, message de formulaire et secret', async () => {
    const s = await ca.call('POST', '/api/sites', { nom: 'Salon Export', modele: 'vitrine' });
    siteId = s.json.id;
    const e = await ca.call('GET', `/api/sites/${siteId}/contenus/prestations`);
    const v = structuredClone(e.json.valeur);
    v.prestations[0].prix = '33 €';
    await ca.call('PUT', `/api/sites/${siteId}/contenus/prestations`, { valeur: v, version: e.json.version });
    // Formulaire déclaré dans une page, pour recevoir un message.
    const n = await ca.call('POST', `/api/sites/${siteId}/fichiers/nouveau`, { chemin: 'public/contact.html' });
    expect(n.status).toBe(200);
    const f = await ca.call('GET', `/api/sites/${siteId}/fichier?chemin=public/contact.html`);
    await ca.call('PUT', `/api/sites/${siteId}/fichier`, {
      chemin: 'public/contact.html',
      contenu: '<form name="contact" method="POST" data-netlify="true"><input name="nom"></form>',
      version: f.json.version,
    });
    const j = await ca.call('POST', `/api/sites/${siteId}/publier`, {});
    expect((await waitJob(a, j.json.id)).etat).toBe('reussie');
    await new Promise<void>((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: a.ctx.config.sitesPort, path: '/', method: 'POST', headers: { host: 'salon-export.localhost', 'content-type': 'application/x-www-form-urlencoded' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve());
        },
      );
      req.end('form-name=contact&nom=Cliente%20Export');
    });
    fs.writeFileSync(path.join(a.ctx.sites.dataDir(a.ctx.sites.get(siteId)!), 'fichier-donnees.json'), '{"x":1}');
    await ca.call('POST', '/api/confirmation', { motDePasse: 'une phrase de passe solide', code: codesA[0] });
    expect((await ca.call('PUT', `/api/sites/${siteId}/secrets/production/CLE_EXPORT`, { valeur: 'valeur-qui-ne-doit-pas-voyager' })).status).toBe(200);
    commitsAvant = Number(execFileSync('git', ['-C', a.ctx.sites.repoDir(a.ctx.sites.get(siteId)!), 'rev-list', '--count', 'HEAD']).toString().trim());
    expect(commitsAvant).toBeGreaterThanOrEqual(4);
  });

  it('exporte une archive complète, sans aucun secret', async () => {
    const r = await ca.call('GET', `/api/sites/${siteId}/export`);
    expect(r.status).toBe(200);
    archive = r.raw;
    const entries = await zipEntries(archive);
    expect([...entries.keys()]).toEqual(expect.arrayContaining(['paginity-export.json', 'historique.bundle', 'formulaires.json', 'donnees/fichier-donnees.json', 'site/public/index.html']));
    const manifeste = JSON.parse(entries.get('paginity-export.json')!.toString());
    expect(manifeste).toMatchObject({ format: 'paginity-export', version: 1, nom: 'Salon Export', secretsARessaisir: ['CLE_EXPORT'] });
    const tout = Buffer.concat([...entries.values()]).toString('latin1');
    expect(tout).not.toContain('valeur-qui-ne-doit-pas-voyager');
    expect(JSON.parse(entries.get('formulaires.json')!.toString())[0].donnees.nom).toBe('Cliente Export');
  });

  it('réimporte l’archive sur une autre installation, avec l’historique, les données et les messages', async () => {
    const up = multipartZip('Salon Réimporté', archive);
    const j = await cb.call('POST', '/api/sites/import', up.body, up.headers);
    const done = await waitJob(b, j.json.id);
    expect(done.erreur).toBeNull();
    const id = (done.resultat as any).siteId;
    const site = b.ctx.sites.get(id)!;
    const commitsApres = Number(execFileSync('git', ['-C', b.ctx.sites.repoDir(site), 'rev-list', '--count', 'HEAD']).toString().trim());
    expect(commitsApres).toBe(commitsAvant);
    expect((done.resultat as any).remarques.join(' ')).toMatch(/CLE_EXPORT/);
    expect(fs.readFileSync(path.join(b.ctx.sites.dataDir(site), 'fichier-donnees.json'), 'utf8')).toBe('{"x":1}');
    const m = await cb.call('GET', `/api/sites/${id}/formulaires`);
    expect(m.json.messages.map((x: any) => x.donnees.nom)).toEqual(['Cliente Export']);
    const contenu = await cb.call('GET', `/api/sites/${id}/contenus/prestations`);
    expect(contenu.json.valeur.prestations[0].prix).toBe('33 €');
    // Aucun secret transféré ; aucune origine Git vers l'ancienne archive.
    expect(b.ctx.db.prepare('SELECT COUNT(*) AS n FROM site_secrets').get()).toEqual({ n: 0 });
    expect(execFileSync('git', ['-C', b.ctx.sites.repoDir(site), 'remote']).toString().trim()).toBe('');
    // Le site réimporté se publie normalement.
    const p = await cb.call('POST', `/api/sites/${id}/publier`, {});
    expect((await waitJob(b, p.json.id)).etat).toBe('reussie');
    expect((await getSite(b, `${site.slug}.localhost`, '/contenu/prestations.json')).body).toContain('33 €');
    void codesB;
  });

  it('refuse une archive d’export dont l’historique contient un lien symbolique', async () => {
    const dir = fs.mkdtempSync(path.join(b.dir, 'piege-'));
    const repo = path.join(dir, 'depot');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    fs.mkdirSync(path.join(repo, 'public'));
    fs.writeFileSync(path.join(repo, 'public', 'index.html'), 'ok');
    fs.symlinkSync('/etc/passwd', path.join(repo, 'public', 'piege'));
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A']);
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x']);
    execFileSync('git', ['-C', repo, 'bundle', 'create', path.join(dir, 'historique.bundle'), '--all']);
    const zipPath = path.join(dir, 'piege.zip');
    await new Promise<void>((resolve) => {
      const z = new yazl.ZipFile();
      z.addFile(path.join(dir, 'historique.bundle'), 'historique.bundle');
      z.addBuffer(Buffer.from(JSON.stringify({ format: 'paginity-export', version: 1, nom: 'Piège' })), 'paginity-export.json');
      z.addBuffer(Buffer.from('ok'), 'site/public/index.html');
      z.end();
      z.outputStream.pipe(fs.createWriteStream(zipPath)).on('close', () => resolve());
    });
    const up = multipartZip('Piège', fs.readFileSync(zipPath));
    const j = await cb.call('POST', '/api/sites/import', up.body, up.headers);
    const done = await waitJob(b, j.json.id);
    expect(done.etat).toBe('echouee');
    expect(done.erreur).toMatch(/lien symbolique/i);
  });
});
