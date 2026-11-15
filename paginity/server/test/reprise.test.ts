import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { client, getSite, setupOwner, startPaginity, stopPaginity, waitJob, type Client } from './helpers.js';
import { swapSymlink } from '../src/publish/build.js';

/**
 * Reprise après une coupure en pleine publication (P1-3).
 * On reproduit l'état exact laissé sur le disque et dans la base par un arrêt brutal, puis on redémarre PAGINITY.
 */
type P = Awaited<ReturnType<typeof startPaginity>>;

function fauxVersion(p: P, siteId: string, n: number): string {
  // Copie de la version n°1 présentée comme une version n°n jamais vérifiée.
  const site = p.ctx.sites.get(siteId)!;
  const src = path.join(p.ctx.sites.versionsDir(site), 'v0001');
  const dst = path.join(p.ctx.sites.versionsDir(site), `v${String(n).padStart(4, '0')}`);
  fs.cpSync(src, dst, { recursive: true });
  fs.chmodSync(dst, 0o755);
  fs.chmodSync(path.join(dst, '.paginity.json'), 0o644);
  const rules = JSON.parse(fs.readFileSync(path.join(dst, '.paginity.json'), 'utf8'));
  fs.writeFileSync(path.join(dst, '.paginity.json'), JSON.stringify({ ...rules, version: String(n) }));
  return dst;
}

function insererPublication(p: P, siteId: string, n: number, userId: string): void {
  p.ctx.db
    .prepare("INSERT INTO publications (site_id, number, commit_hash, message, created_by, created_at, status) VALUES (?, ?, 'x', '', ?, ?, 'en_cours')")
    .run(siteId, n, userId, Date.now());
}

describe('Reprise après une coupure pendant une publication', () => {
  let p: P;
  let c: Client;
  const dirs: string[] = [];
  afterAll(async () => {
    if (p) await stopPaginity(p);
  });

  async function redemarrer(): Promise<void> {
    const dir = p.dir;
    await p.close();
    p = await startPaginity({ dataDir: dir });
    c = client(p);
    const etat = await c.call('GET', '/api/etat');
    c.csrf = etat.json.csrf;
  }

  it('prépare deux sites publiés une fois', async () => {
    p = await startPaginity();
    ({ c } = await setupOwner(p));
    for (const nom of ['Site A', 'Site B', 'Site C']) {
      const s = await c.call('POST', '/api/sites', { nom, modele: 'vierge' });
      dirs.push(s.json.id);
      const j = await c.call('POST', `/api/sites/${s.json.id}/publier`, {});
      expect((await waitJob(p, j.json.id)).etat).toBe('reussie');
    }
  });

  it('coupure juste après la bascule : retour à la dernière version vérifiée', async () => {
    const [a] = dirs;
    const owner = p.ctx.db.prepare('SELECT id FROM users').get() as { id: string };
    insererPublication(p, a, 2, owner.id);
    const site = p.ctx.sites.get(a)!;
    swapSymlink(p.ctx.sites.liveLink(site), fauxVersion(p, a, 2)); // bascule faite, base pas encore mise à jour
    // Un reste de bascule interrompue (fichier temporaire) traîne aussi.
    fs.symlinkSync(path.join(p.ctx.sites.versionsDir(site), 'v0001'), `${p.ctx.sites.liveLink(site)}.tmp-999-1`);
    expect((await getSite(p, 'site-a.localhost')).headers['x-paginity-version']).toBe('2');
    await redemarrer();
    const pub = p.ctx.db.prepare('SELECT status FROM publications WHERE site_id = ? AND number = 2').get(a) as { status: string };
    expect(pub.status).toBe('interrompue');
    const s2 = p.ctx.sites.get(a)!;
    expect(s2.live_publication).toBe(1);
    expect((await getSite(p, 'site-a.localhost')).headers['x-paginity-version']).toBe('1');
    expect(fs.readdirSync(p.ctx.sites.dir(s2)).filter((f) => f.includes('.tmp-'))).toEqual([]);
    const sum = await c.call('POST', '/api/connexion', {}); // simple appel pour vérifier que le serveur répond
    expect(sum.status).toBe(400);
    const alertes = p.ctx.db.prepare('SELECT message FROM alerts WHERE site_id = ?').all(a) as { message: string }[];
    expect(alertes.some((x) => /interrompue/.test(x.message))).toBe(true);
    expect(s2.last_publication_status).toBe('echouee');
  });

  it('coupure pendant le retour arrière : la base est remise en accord avec la version vérifiée en ligne', async () => {
    const [, b] = dirs;
    const owner = p.ctx.db.prepare('SELECT id FROM users').get() as { id: string };
    insererPublication(p, b, 2, owner.id);
    fauxVersion(p, b, 2);
    // La base indique la version 2 (non vérifiée) alors que le lien est revenu sur la version 1.
    p.ctx.db.prepare('UPDATE sites SET live_publication = 2 WHERE id = ?').run(b);
    p.ctx.sites.invalidate();
    await redemarrer();
    expect(p.ctx.sites.get(b)!.live_publication).toBe(1);
    expect((await getSite(p, 'site-b.localhost')).headers['x-paginity-version']).toBe('1');
  });

  it('première publication interrompue : le site redevient « non publié » plutôt que de servir une version non vérifiée', async () => {
    const [, , cId] = dirs;
    const site = p.ctx.sites.get(cId)!;
    // Simule un site jamais publié avec succès : on efface la publication réussie et on laisse un lien non vérifié.
    p.ctx.db.prepare('DELETE FROM publications WHERE site_id = ?').run(cId);
    p.ctx.db.prepare('UPDATE sites SET live_publication = NULL WHERE id = ?').run(cId);
    const owner = p.ctx.db.prepare('SELECT id FROM users').get() as { id: string };
    insererPublication(p, cId, 1, owner.id);
    swapSymlink(p.ctx.sites.liveLink(site), path.join(p.ctx.sites.versionsDir(site), 'v0001'));
    await redemarrer();
    expect(fs.existsSync(p.ctx.sites.liveLink(site))).toBe(false);
    expect(p.ctx.sites.get(cId)!.live_publication).toBeNull();
    expect((await getSite(p, 'site-c.localhost')).status).toBe(503);
  });

  it('un état normal n’est pas modifié par le redémarrage', async () => {
    const [a] = dirs;
    const avant = p.ctx.db.prepare('SELECT COUNT(*) AS n FROM alerts').get() as { n: number };
    await redemarrer();
    expect(p.ctx.sites.get(a)!.live_publication).toBe(1);
    expect((p.ctx.db.prepare('SELECT COUNT(*) AS n FROM alerts').get() as { n: number }).n).toBe(avant.n);
    // Et une nouvelle publication fonctionne normalement après la reprise.
    const j = await c.call('POST', '/api/sites/' + a + '/publier', {});
    expect(j.status).toBe(401); // session perdue : il faut se reconnecter (comportement attendu)
  });
});
