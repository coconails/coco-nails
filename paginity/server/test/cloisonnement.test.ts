import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, setupOwner, startPaginity, stopPaginity, totpCode, waitJob, type Client } from './helpers.js';

/**
 * Cloisonnement (suite du plan, leçons de Coolify et Dokploy) :
 * 1. Une personne qui a un rôle sur le site A n'obtient RIEN du site B, quelle que soit l'adresse de l'API essayée.
 * 2. Les activités (publications…) d'un autre site ne sont jamais visibles, même en prenant le même nom affiché.
 * 3. Aucun secret ne sort dans une alerte, un e-mail, l'historique des tâches ou le journal.
 */
type P = Awaited<ReturnType<typeof startPaginity>>;
const SECRET = 'secret-de-production-987';

async function ecrire(c: Client, siteId: string, files: Record<string, string>) {
  for (const [chemin, contenu] of Object.entries(files)) {
    if ((await c.call('GET', `/api/sites/${siteId}/fichier?chemin=${encodeURIComponent(chemin)}`)).status !== 200) {
      await c.call('POST', `/api/sites/${siteId}/fichiers/nouveau`, { chemin });
    }
    const v = (await c.call('GET', `/api/sites/${siteId}/fichier?chemin=${encodeURIComponent(chemin)}`)).json.version;
    const w = await c.call('PUT', `/api/sites/${siteId}/fichier`, { chemin, contenu, version: v });
    if (w.status !== 200) throw new Error(`${chemin} : ${w.body}`);
  }
}

/** Toutes les adresses /api/sites/:id… déclarées dans le code du serveur (lues dans les fichiers sources). */
function routesDeSite(): { methode: string; chemin: string }[] {
  const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'http');
  const out: { methode: string; chemin: string }[] = [];
  for (const f of fs.readdirSync(dir)) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of t.matchAll(/app\.(get|post|put|patch|delete)\('(\/api\/sites\/:id[^']*)'/g)) out.push({ methode: m[1].toUpperCase(), chemin: m[2] });
  }
  return out;
}

describe('Cloisonnement entre sites et secrets', () => {
  let p: P;
  let c: Client;
  let admin: Client;
  let siteA: string;
  let siteB: string;
  let fidB: string;
  let smtp: SMTPServer;
  const mails: string[] = [];

  /** Ce que l'on observe du site B : rien ne doit changer pendant les essais de la personne du site A. */
  const etatB = async () => {
    const s = p.ctx.sites.get(siteB)!;
    return JSON.stringify({
      head: await p.ctx.sites.repo(s).head(),
      nom: s.name,
      domaines: s.domains,
      secrets: p.ctx.db.prepare('SELECT env, name, value_enc FROM site_secrets WHERE site_id = ? ORDER BY name').all(siteB),
      messages: p.ctx.db.prepare('SELECT id, read_at FROM form_submissions WHERE site_id = ?').all(siteB),
      membres: p.ctx.db.prepare('SELECT user_id, role FROM site_members WHERE site_id = ?').all(siteB),
      publications: p.ctx.db.prepare('SELECT COUNT(*) AS n FROM publications WHERE site_id = ?').get(siteB),
      taches: p.ctx.db.prepare('SELECT schedules_enabled FROM sites WHERE id = ?').get(siteB),
    });
  };

  beforeAll(async () => {
    p = await startPaginity();
    let codes: string[];
    ({ c, codes } = await setupOwner(p));
    expect((await c.call('POST', '/api/confirmation', { motDePasse: 'une phrase de passe solide', code: codes[0] })).status).toBe(200);
    smtp = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS', 'AUTH'],
      onData(stream, _s, cb) {
        let d = '';
        stream.on('data', (x) => (d += x));
        stream.on('end', () => {
          mails.push(d);
          cb();
        });
      },
    });
    await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', () => r()));
    const port = (smtp.server.address() as AddressInfo).port;
    expect((await c.call('PUT', '/api/reglages/messagerie', { hote: '127.0.0.1', port, securise: false, expediteur: 'paginity@exemple.fr', destinataireAlertes: 'moi@exemple.fr' })).status).toBe(200);

    siteA = (await c.call('POST', '/api/sites', { nom: 'Site A', modele: 'vierge' })).json.id;
    await ecrire(c, siteA, {
      'paginity.yml': 'dossier_publie: public\nfonctions:\n  dossier: netlify/functions\n  format: netlify-v2\n',
      'netlify/functions/panne.mjs':
        'export default async () => { console.error("connexion refusée avec la clé " + process.env.CLE_PANNE); return new Response("Échec : clé " + process.env.CLE_PANNE + " refusée", { status: 500 }); };\nexport const config = { schedule: "0 3 * * *" };\n',
    });
    expect((await c.call('PUT', `/api/sites/${siteA}/secrets/production/CLE_PANNE`, { valeur: SECRET })).status).toBe(200);
    expect((await waitJob(p, (await c.call('POST', `/api/sites/${siteA}/publier`, {})).json.id)).etat).toBe('reussie');

    siteB = (await c.call('POST', '/api/sites', { nom: 'Site B', modele: 'vitrine' })).json.id;
    expect((await waitJob(p, (await c.call('POST', `/api/sites/${siteB}/publier`, {})).json.id)).etat).toBe('reussie');
    expect((await c.call('PUT', `/api/sites/${siteB}/secrets/production/CLE_B`, { valeur: 'cle-du-site-b-123' })).status).toBe(200);
    fidB = 'fB1';
    p.ctx.db.prepare('INSERT INTO form_submissions (id, site_id, form, at, data_enc) VALUES (?, ?, ?, ?, ?)').run(fidB, siteB, 'contact', Date.now(), p.ctx.vault.encrypt('{"nom":"Cliente B"}'));

    // Une personne « administratrice du site A » seulement, identité confirmée (elle a donc tous ses droits sur A).
    const inv = await c.call('POST', '/api/invitations', { email: 'admin-a@exemple.fr', roles: [{ siteId: siteA, role: 'admin_site' }] });
    const token = inv.json.lien.split('/invitation/')[1];
    admin = client(p, { remoteAddress: '10.2.2.2' });
    admin.csrf = (await admin.call('GET', '/api/etat')).json.csrf;
    await admin.call('POST', `/api/invitations/${token}/accepter`, { nom: 'Admin A', motDePasse: 'une autre phrase solide' });
    const d = await admin.call('POST', '/api/profil/2fa/totp/debut', {});
    await admin.call('POST', '/api/profil/2fa/totp/confirmer', { code: totpCode(d.json.secret) });
    expect((await admin.call('POST', '/api/confirmation', { motDePasse: 'une autre phrase solide', code: totpCode(d.json.secret, 1) })).status).toBe(200);
  }, 120_000);
  afterAll(async () => {
    smtp.close();
    await stopPaginity(p);
  });

  it('toutes les adresses de l’API refusent le site B à une personne du site A (et rien ne change sur B)', async () => {
    const routes = routesDeSite();
    expect(routes.length).toBeGreaterThanOrEqual(40);
    const avant = await etatB();
    const parametres: Record<string, string> = { id: siteB, fn: 'panne', env: 'production', nom: 'CLE_B', fid: fidB, numero: '1', userId: 'x' };
    const fuites: string[] = [];
    for (const r of routes) {
      const url = r.chemin.replace(/:(\w+)/g, (_m, k) => encodeURIComponent(parametres[k] ?? 'x')) + (r.chemin.endsWith('/fichier') || r.chemin.endsWith('/brut') ? '?chemin=index.html' : '');
      const res = await admin.call(r.methode, url, ['GET', 'DELETE'].includes(r.methode) ? undefined : { valeur: 'piratage', nom: 'Piraté', chemin: 'public/index.html', contenu: 'x', version: null, active: true, email: 'pirate@exemple.fr', role: 'admin_site' });
      if (res.status < 400 || ![403, 404].includes(res.status)) fuites.push(`${r.methode} ${r.chemin} → ${res.status}`);
      if (res.body.includes('cle-du-site-b-123') || res.body.includes('Cliente B')) fuites.push(`${r.methode} ${r.chemin} : donnée de B renvoyée`);
    }
    expect(fuites).toEqual([]);
    expect(await etatB()).toBe(avant);
  });

  it('un identifiant de B glissé dans une adresse du site A ne touche pas B', async () => {
    const avant = await etatB();
    expect((await admin.call('DELETE', `/api/sites/${siteA}/formulaires/${fidB}`)).status).toBe(404);
    expect((await admin.call('POST', `/api/sites/${siteA}/formulaires/${fidB}/lu`, {})).status).toBe(404);
    expect((await admin.call('PUT', `/api/sites/${siteA}/membres/${encodeURIComponent('inconnu')}`, { role: 'admin_site' })).status).toBeGreaterThanOrEqual(400);
    // Inviter quelqu'un sur le site B : refusé.
    expect((await admin.call('POST', '/api/invitations', { email: 'complice@exemple.fr', roles: [{ siteId: siteB, role: 'editeur' }] })).status).toBe(404);
    expect(await etatB()).toBe(avant);
  });

  it('les alertes et les activités du site B restent invisibles, même en prenant le nom du propriétaire', async () => {
    const proprio = p.ctx.db.prepare('SELECT id, name FROM users WHERE is_owner = 1').get() as { id: string; name: string };
    p.ctx.db.prepare("INSERT INTO alerts (at, level, message, site_id) VALUES (?, 'attention', 'Alerte réservée au site B', ?)").run(Date.now(), siteB);
    expect(JSON.stringify((await admin.call('GET', '/api/alertes')).json)).not.toContain('réservée au site B');
    // La personne du site A prend le même nom affiché que le propriétaire.
    expect((await admin.call('PATCH', '/api/profil', { nom: proprio.name })).status).toBe(200);
    // Activité sans site (ex. import) lancée par le propriétaire.
    p.ctx.db
      .prepare("INSERT INTO jobs (id, type, label, site_id, user_id, status, steps, payload, created_at) VALUES ('jsecret', 'import', 'Import privé du propriétaire', NULL, ?, 'reussie', '[]', '{}', ?)")
      .run(proprio.id, Date.now());
    expect((await admin.call('GET', '/api/activites/jsecret')).status).toBe(404);
    expect(JSON.stringify((await admin.call('GET', '/api/activites')).json)).not.toContain('Import privé');
    // Flux en direct : une publication du site B ne doit pas lui parvenir.
    await p.admin.listen({ port: 0, host: '127.0.0.1' });
    const port = (p.admin.server.address() as AddressInfo).port;
    const recu: string[] = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/api/activites/flux', headers: { cookie: [...admin.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d) => recu.push(d));
    });
    await new Promise((r) => setTimeout(r, 300));
    const j = await c.call('POST', `/api/sites/${siteB}/publier`, {});
    await waitJob(p, j.json.id);
    await new Promise((r) => setTimeout(r, 300));
    req.destroy();
    expect(recu.join('')).toMatch(/retry:/); // le flux était bien ouvert
    expect(recu.join('')).not.toContain(siteB);
  });

  it('une alerte marquée lue par un membre reste visible pour le propriétaire et pour le récapitulatif', async () => {
    const id = Number(p.ctx.db.prepare("INSERT INTO alerts (at, level, message, site_id) VALUES (?, 'attention', 'Alerte du site A à lire', ?)").run(Date.now(), siteA).lastInsertRowid);
    expect(JSON.stringify((await admin.call('GET', '/api/alertes')).json)).toContain('Alerte du site A à lire');
    expect((await admin.call('POST', `/api/alertes/${id}/lue`, {})).status).toBe(200);
    // Masquée pour ce membre (liste et tableau de bord)…
    expect(JSON.stringify((await admin.call('GET', '/api/alertes')).json)).not.toContain('Alerte du site A à lire');
    expect(JSON.stringify((await admin.call('GET', '/api/tableau-de-bord')).json.alertes)).not.toContain('Alerte du site A à lire');
    // … mais toujours non lue pour le propriétaire et pour l'e-mail quotidien.
    expect((p.ctx.db.prepare('SELECT read_at FROM alerts WHERE id = ?').get(id) as { read_at: number | null }).read_at).toBeNull();
    expect(JSON.stringify((await c.call('GET', '/api/alertes')).json)).toContain('Alerte du site A à lire');
    // Le propriétaire, lui, la marque lue pour tout le monde.
    expect((await c.call('POST', `/api/alertes/${id}/lue`, {})).status).toBe(200);
    expect((p.ctx.db.prepare('SELECT read_at FROM alerts WHERE id = ?').get(id) as { read_at: number | null }).read_at).not.toBeNull();
  });

  it('une tâche en échec ne divulgue pas son secret (alerte, e-mail, historique, journal)', async () => {
    const r = await c.call('POST', `/api/sites/${siteA}/taches/panne/lancer`, {});
    expect(r.status, r.body).toBe(200);
    for (let i = 0; i < 50 && !mails.some((m) => m.includes('panne')); i++) await new Promise((res) => setTimeout(res, 100));
    const alertes = p.ctx.db.prepare('SELECT message FROM alerts').all() as { message: string }[];
    const alerte = alertes.find((a) => a.message.includes('panne'));
    expect(alerte, 'une alerte doit être levée').toBeDefined();
    expect(alerte!.message).toContain('[secret masqué]');
    const tout = JSON.stringify({
      alertes,
      mails,
      executions: p.ctx.db.prepare('SELECT message FROM schedule_runs').all(),
      journalBase: p.ctx.db.prepare('SELECT message FROM function_log').all(),
      journal: p.ctx.functions.recentLogs(siteA),
      api: (await c.call('GET', `/api/sites/${siteA}/fonctions`)).json,
    });
    expect(mails.some((m) => m.includes('panne')), 'l’alerte doit partir par e-mail').toBe(true);
    expect(tout).not.toContain(SECRET);
  });
});
