import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'node:net';
import { getSite, setupOwner, startPaginity, stopPaginity, waitJob, type Client } from './helpers.js';
import { cronMatches, nextRun, parseCron, slotsBetween } from '../src/functions/cron.js';
import { Scheduler } from '../src/functions/scheduler.js';
import { raiseAlert, sendDigest } from '../src/lib/alerts.js';

const require = createRequire(import.meta.url);
type P = Awaited<ReturnType<typeof startPaginity>>;

const FONCTIONS: Record<string, string> = {
  'paginity.yml': 'dossier_publie: public\nfonctions:\n  dossier: netlify/functions\n  format: netlify-v2\n',
  'netlify/lib/outil.mjs': 'export const saluer = (n) => `Bonjour ${n}`;\n',
  'netlify/functions/echo.mjs': `import { saluer } from "../lib/outil.mjs";
export default async (req, context) => {
  context.cookies.set({ name: "vu", value: "oui", path: "/" });
  return Response.json({
    message: saluer(context.params.nom),
    ip: context.ip,
    secret: Netlify.env.get("MA_CLE") ? "present" : "absent",
    url: process.env.URL,
    contexte: process.env.CONTEXT,
    methode: req.method,
    cookie: context.cookies.get("a") ?? null,
  }, { headers: { "x-test": "1" } });
};
export const config = { path: "/api/echo/:nom" };
`,
  'netlify/functions/espion.mjs': `import fs from "node:fs";
export default async (req) => {
  const cible = new URL(req.url).searchParams.get("fichier");
  let lecture = "ok";
  try { fs.readFileSync(cible); } catch (e) { lecture = e.code || "erreur"; }
  let processus = "ok";
  try { (await import("node:child_process")).execSync("id"); } catch (e) { processus = e.code || "erreur"; }
  let ecriture = "ok";
  try { fs.writeFileSync("/tmp/../" + "paginity-intrusion.txt", "x"); } catch (e) { ecriture = e.code || "erreur"; }
  return Response.json({ lecture, processus, ecriture });
};
export const config = { path: "/api/espion" };
`,
  'netlify/functions/tache.mjs': `export default async () => { console.log("tâche exécutée avec la clé " + process.env.MA_CLE); return new Response("ok"); };
export const config = { schedule: "*/5 * * * *" };
`,
  'netlify/functions/lent.mjs': 'export default async () => { await new Promise((r) => setTimeout(r, 5000)); return new Response("trop tard"); };\nexport const config = { path: "/api/lent" };\n',
  'netlify/functions/classique.mjs': 'export default async () => new Response("adresse par défaut");\n',
  'public/contact.html': '<!doctype html><title>Contact</title><form name="contact" method="POST" action="/merci.html" data-netlify="true" netlify-honeypot="piege"><input name="nom"><textarea name="message"></textarea><input name="piege"></form>',
  'public/merci.html': '<!doctype html><title>Merci</title><p>Merci</p>',
};

async function writeFiles(c: Client, siteId: string, files: Record<string, string>) {
  for (const [chemin, contenu] of Object.entries(files)) {
    const cur = await c.call('GET', `/api/sites/${siteId}/fichier?chemin=${encodeURIComponent(chemin)}`);
    if (cur.status !== 200) {
      const n = await c.call('POST', `/api/sites/${siteId}/fichiers/nouveau`, { chemin });
      if (n.status !== 200) throw new Error(`${chemin} : ${n.body}`);
    }
    const v = (await c.call('GET', `/api/sites/${siteId}/fichier?chemin=${encodeURIComponent(chemin)}`)).json.version;
    const w = await c.call('PUT', `/api/sites/${siteId}/fichier`, { chemin, contenu, version: v });
    if (w.status !== 200) throw new Error(`${chemin} : ${w.body}`);
  }
}

describe('Expressions cron (heure UTC, comme Netlify)', () => {
  it('calcule les prochains créneaux', () => {
    const c = parseCron('0 9 * * *');
    expect(new Date(nextRun(c, Date.UTC(2026, 10, 15, 9, 0))!).toISOString()).toBe('2026-11-16T09:00:00.000Z');
    expect(new Date(nextRun(c, Date.UTC(2026, 10, 15, 8, 59, 30))!).toISOString()).toBe('2026-11-15T09:00:00.000Z');
    expect(slotsBetween(parseCron('*/5 * * * *'), Date.UTC(2026, 0, 1, 12, 0), Date.UTC(2026, 0, 1, 12, 20))).toHaveLength(4);
    expect(cronMatches(parseCron('0 7 * * MON-FRI'), Date.UTC(2026, 10, 16, 7, 0))).toBe(true); // lundi
    expect(cronMatches(parseCron('0 7 * * MON-FRI'), Date.UTC(2026, 10, 15, 7, 0))).toBe(false); // dimanche
    expect(cronMatches(parseCron('@daily'), Date.UTC(2026, 10, 15, 0, 0))).toBe(true);
    expect(cronMatches(parseCron('0 0 1,15 * 1'), Date.UTC(2026, 10, 16, 0, 0))).toBe(true); // règle « OU »
    expect(() => parseCron('61 * * * *')).toThrow();
    expect(() => parseCron('* * *')).toThrow();
  });
});

describe('Fonctions serveur, secrets, formulaires, tâches planifiées', () => {
  let p: P;
  let c: Client;
  let codes: string[];
  let siteId: string;
  let slug: string;
  let autreId: string;
  let smtp: SMTPServer;
  const mails: string[] = [];

  beforeAll(async () => {
    p = await startPaginity();
    ({ c, codes } = await setupOwner(p));
    await c.call('POST', '/api/confirmation', { motDePasse: 'une phrase de passe solide', code: codes[0] });
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
  });
  afterAll(async () => {
    smtp.close();
    await stopPaginity(p);
  });

  it('publie un site avec fonctions et démarre son exécuteur isolé', async () => {
    const s = await c.call('POST', '/api/sites', { nom: 'Fonctions Test', modele: 'vierge' });
    siteId = s.json.id;
    slug = s.json.slug;
    await writeFiles(c, siteId, FONCTIONS);
    const sec = await c.call('PUT', `/api/sites/${siteId}/secrets/production/MA_CLE`, { valeur: 'valeur-tres-secrete-123' });
    expect(sec.status).toBe(200);
    const j = await c.call('POST', `/api/sites/${siteId}/publier`, {});
    const done = await waitJob(p, j.json.id);
    expect(done.erreur).toBeNull();
    expect(done.etapes.find((e) => e.nom === 'Fonctions serveur')!.message).toMatch(/5 fonction\(s\) prête\(s\) \(processus restreint\)/);
  });

  it('imite l’environnement Netlify (paramètres, cookies, variables, adresse par défaut)', async () => {
    const r = await getSite(p, `${slug}.localhost`, '/api/echo/Marie');
    expect(r.status).toBe(200);
    expect(r.headers['x-test']).toBe('1');
    expect(String(r.headers['set-cookie'])).toContain('vu=oui');
    const b = JSON.parse(r.body);
    expect(b).toMatchObject({ message: 'Bonjour Marie', secret: 'present', contexte: 'production', methode: 'GET', url: `http://${slug}.localhost:${p.ctx.config.sitesPublicPort}` });
    expect(b.ip).toMatch(/127\.0\.0\.1/);
    expect((await getSite(p, `${slug}.localhost`, '/.netlify/functions/classique')).body).toBe('adresse par défaut');
    expect((await getSite(p, `${slug}.localhost`, '/api/inexistante')).status).toBe(404);
  });

  it('isole le code du site : pas d’accès aux fichiers de PAGINITY, ni aux sous-processus, ni en écriture', async () => {
    const cle = `${p.dir}/coffre/cle-maitre`;
    const r = await getSite(p, `${slug}.localhost`, `/api/espion?fichier=${encodeURIComponent(cle)}`);
    const b = JSON.parse(r.body);
    expect(b.lecture).toBe('ERR_ACCESS_DENIED');
    expect(b.processus).toBe('ERR_ACCESS_DENIED');
    expect(b.ecriture).toBe('ERR_ACCESS_DENIED');
    const db = await getSite(p, `${slug}.localhost`, `/api/espion?fichier=${encodeURIComponent(`${p.dir}/plateforme/paginity.db`)}`);
    expect(JSON.parse(db.body).lecture).toBe('ERR_ACCESS_DENIED');
  });

  it('ne donne pas les secrets d’un site aux fonctions d’un autre site', async () => {
    const s = await c.call('POST', '/api/sites', { nom: 'Autre site', modele: 'vierge' });
    autreId = s.json.id;
    await writeFiles(c, autreId, { 'paginity.yml': FONCTIONS['paginity.yml'], 'netlify/lib/outil.mjs': FONCTIONS['netlify/lib/outil.mjs'], 'netlify/functions/echo.mjs': FONCTIONS['netlify/functions/echo.mjs'] });
    const j = await c.call('POST', `/api/sites/${autreId}/publier`, {});
    expect((await waitJob(p, j.json.id)).etat).toBe('reussie');
    const r = await getSite(p, `${s.json.slug}.localhost`, '/api/echo/x');
    expect(JSON.parse(r.body).secret).toBe('absent');
  });

  it('coupe une fonction trop lente', async () => {
    p.ctx.functions.requestTimeoutMs = 1000;
    const r = await getSite(p, `${slug}.localhost`, '/api/lent');
    expect(r.status).toBe(504);
    p.ctx.functions.requestTimeoutMs = 30_000;
  });

  it('refuse de publier une version dont une fonction ne se charge pas, l’ancienne reste en ligne', async () => {
    await writeFiles(c, siteId, { 'netlify/functions/casse.mjs': 'export default async () => { return new Response("x") \n}}\n' });
    const j = await c.call('POST', `/api/sites/${siteId}/publier`, {});
    const done = await waitJob(p, j.json.id);
    expect(done.etat).toBe('echouee');
    expect(done.etapes.find((e) => e.nom === 'Fonctions serveur')!.etat).toBe('echoue');
    expect(done.etapes.find((e) => e.nom === 'Basculer')!.etat).not.toBe('reussi');
    expect((await getSite(p, `${slug}.localhost`, '/api/echo/Paul')).status).toBe(200);
    const f = await c.call('GET', `/api/sites/${siteId}/fichier?chemin=netlify/functions/casse.mjs`);
    await c.call('DELETE', `/api/sites/${siteId}/fichier?chemin=netlify/functions/casse.mjs`);
    void f;
  });

  it('reçoit les formulaires déclarés et ignore les robots', async () => {
    const post = (body: string, path = '/merci.html') =>
      new Promise<{ status: number; location?: string }>((resolve) => {
        const req = require('node:http').request(
          { host: '127.0.0.1', port: p.ctx.config.sitesPort, path, method: 'POST', headers: { host: `${slug}.localhost`, 'content-type': 'application/x-www-form-urlencoded' } },
          (res: any) => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location }));
          },
        );
        req.end(body);
      });
    const ok = await post('form-name=contact&nom=Alice&message=Bonjour');
    expect(ok.status).toBe(303);
    expect(ok.location).toBe('/merci.html');
    await post('form-name=contact&nom=Robot&piege=oui');
    const m = await c.call('GET', `/api/sites/${siteId}/formulaires`);
    expect(m.json.messages.map((x: any) => x.donnees.nom)).toEqual(['Alice']);
  });

  it('envoie les alertes et les messages des formulaires par e-mail (serveur SMTP de test)', async () => {
    const port = (smtp.server.address() as AddressInfo).port;
    const r = await c.call('PUT', '/api/reglages/messagerie', { hote: '127.0.0.1', port, securise: false, expediteur: 'paginity@exemple.fr', destinataireAlertes: 'moi@exemple.fr' });
    expect(r.status).toBe(200);
    expect((await c.call('POST', '/api/reglages/messagerie/test', {})).status).toBe(200);
    await c.call('PATCH', `/api/sites/${siteId}/notification`, { email: 'gerante@exemple.fr' });
    p.ctx.sites.invalidate();
    await new Promise<void>((resolve) => {
      const req = require('node:http').request(
        { host: '127.0.0.1', port: p.ctx.config.sitesPort, path: '/merci.html', method: 'POST', headers: { host: `${slug}.localhost`, 'content-type': 'application/x-www-form-urlencoded' } },
        (res: any) => {
          res.resume();
          res.on('end', () => resolve());
        },
      );
      req.end('form-name=contact&nom=Bob&message=Rendez-vous%20samedi');
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(mails.some((m) => m.includes('To: moi@exemple.fr'))).toBe(true);
    expect(mails.some((m) => m.includes('To: gerante@exemple.fr') && m.includes('Bob'))).toBe(true);
    // Alerte critique : e-mail immédiat ; alerte « attention » : récapitulatif quotidien.
    raiseAlert(p.ctx, 'critique', 'Panne simulée pour le test');
    raiseAlert(p.ctx, 'attention', 'Point à vérifier pour le test');
    await new Promise((r) => setTimeout(r, 500));
    expect(mails.filter((m) => m.includes('Panne simul')).length).toBe(1);
    expect(await sendDigest(p.ctx)).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(mails.some((m) => m.includes('Point') && m.includes('pour le test'))).toBe(true);
  });

  it('planifie les tâches : une seule exécution par créneau, tâches manquées signalées, rattrapage sur demande', async () => {
    const site = p.ctx.sites.get(siteId)!;
    const sched = new Scheduler(p.ctx);
    sched.timeSynced = async () => true;
    // Désactivées par défaut : rien ne se passe.
    const t0 = Date.UTC(2030, 0, 1, 12, 0, 30);
    await sched.tick(t0 - 60_000);
    await sched.tick(t0);
    expect(p.ctx.db.prepare('SELECT COUNT(*) AS n FROM schedule_runs').get()).toEqual({ n: 0 });
    // Activation (action sensible, confirmée plus haut).
    expect((await c.call('POST', `/api/sites/${siteId}/planification`, { active: true })).status).toBe(200);
    const s2 = new Scheduler(p.ctx);
    s2.timeSynced = async () => true;
    await s2.tick(t0 - 40_000);
    await s2.tick(t0);
    await s2.tick(t0); // même créneau : pas de doublon
    const waitDone = async () => {
      for (let i = 0; i < 100; i++) {
        const r = p.ctx.db.prepare("SELECT COUNT(*) AS n FROM schedule_runs WHERE status = 'en_cours'").get() as { n: number };
        if (r.n === 0) return;
        await new Promise((x) => setTimeout(x, 100));
      }
    };
    await waitDone();
    let runs = p.ctx.db.prepare('SELECT slot, status, kind FROM schedule_runs ORDER BY slot').all() as { slot: number; status: string; kind: string }[];
    expect(runs).toEqual([{ slot: Date.UTC(2030, 0, 1, 12, 0), status: 'reussie', kind: 'planifiee' }]);
    // Le secret n'apparaît jamais dans le journal.
    const logs = p.ctx.functions.recentLogs(siteId).join('\n');
    expect(logs).toContain('tâche exécutée avec la clé [secret masqué]');
    expect(logs).not.toContain('valeur-tres-secrete-123');
    // Redémarrage après une panne de 23 minutes : les créneaux manqués sont signalés, pas exécutés.
    const s3 = new Scheduler(p.ctx);
    s3.timeSynced = async () => true;
    await s3.tick(Date.UTC(2030, 0, 1, 12, 23, 0));
    await waitDone();
    runs = p.ctx.db.prepare('SELECT slot, status FROM schedule_runs ORDER BY slot').all() as { slot: number; status: string }[];
    expect(runs.map((r) => r.status)).toEqual(['reussie', 'manquee', 'manquee', 'manquee', 'manquee']);
    // Avec le rattrapage autorisé : seul le dernier créneau manqué est exécuté.
    await c.call('PUT', `/api/sites/${siteId}/taches/tache`, { rattrapage: true });
    const s4 = new Scheduler(p.ctx);
    s4.timeSynced = async () => true;
    await s4.tick(Date.UTC(2030, 0, 1, 12, 34, 0));
    await waitDone();
    runs = p.ctx.db.prepare('SELECT slot, status, kind FROM schedule_runs WHERE slot > ? ORDER BY slot').all(Date.UTC(2030, 0, 1, 12, 20)) as { slot: number; status: string; kind: string }[];
    expect(runs).toEqual([
      { slot: Date.UTC(2030, 0, 1, 12, 25), status: 'manquee', kind: 'planifiee' },
      { slot: Date.UTC(2030, 0, 1, 12, 30), status: 'reussie', kind: 'rattrapage' },
    ]);
    // Horloge non synchronisée : on attend.
    const s5 = new Scheduler(p.ctx);
    s5.timeSynced = async () => false;
    await s5.tick(Date.UTC(2030, 0, 1, 12, 40, 30));
    expect((p.ctx.db.prepare('SELECT COUNT(*) AS n FROM schedule_runs WHERE slot = ?').get(Date.UTC(2030, 0, 1, 12, 40)) as { n: number }).n).toBe(0);
    const alertes = await c.call('GET', '/api/alertes');
    expect(alertes.json.some((a: any) => /manquée/.test(a.message))).toBe(true);
    void site;
  });

  it('lance une tâche à la demande', async () => {
    const r = await c.call('POST', `/api/sites/${siteId}/taches/tache/lancer`, {});
    expect(r.status).toBe(200);
    expect(r.json.taches[0].executions.find((x: any) => x.type === 'manuel')).toMatchObject({ etat: 'reussie' });
  });

  it('aperçu : fonctions désactivées sans secrets de test, actives avec', async () => {
    const a1 = await c.call('POST', `/api/sites/${siteId}/apercu`, {});
    const host1 = new URL(a1.json.url).hostname;
    const off = await getSite(p, host1, '/api/echo/x', { port: p.ctx.config.previewPort });
    expect(off.status).toBe(503);
    await c.call('PUT', `/api/sites/${siteId}/secrets/test/MA_CLE`, { valeur: 'cle-de-test-456' });
    const on = await getSite(p, host1, '/api/echo/x', { port: p.ctx.config.previewPort });
    expect(on.status).toBe(200);
    expect(JSON.parse(on.body)).toMatchObject({ secret: 'present', contexte: 'deploy-preview' });
    // Les formulaires de l'aperçu n'enregistrent rien.
    const before = (p.ctx.db.prepare('SELECT COUNT(*) AS n FROM form_submissions').get() as { n: number }).n;
    await new Promise<void>((resolve) => {
      const req = require('node:http').request(
        { host: '127.0.0.1', port: p.ctx.config.previewPort, path: '/merci.html', method: 'POST', headers: { host: host1, 'content-type': 'application/x-www-form-urlencoded' } },
        (res: any) => {
          res.resume();
          res.on('end', () => resolve());
        },
      );
      req.end('form-name=contact&nom=Apercu');
    });
    expect((p.ctx.db.prepare('SELECT COUNT(*) AS n FROM form_submissions').get() as { n: number }).n).toBe(before);
  });

  it('ne renvoie jamais la valeur d’un secret à l’interface', async () => {
    const r = await c.call('GET', `/api/sites/${siteId}/secrets`);
    expect(JSON.stringify(r.json)).not.toContain('valeur-tres-secrete-123');
    expect(r.json.find((x: any) => x.nom === 'MA_CLE')).toMatchObject({ utiliseParLeCode: true });
    expect(r.json.find((x: any) => x.nom === 'MA_CLE').production).not.toBeNull();
  });
});

const podmanOk = spawnSync('podman', ['--version']).status === 0 && process.env.PAGINITY_TEST_PODMAN !== 'non';

describe.skipIf(!podmanOk)('Isolation par conteneur Podman', () => {
  let p: P;
  let c: Client;
  let slug: string;

  beforeAll(async () => {
    process.env.PAGINITY_CONTAINER_NETWORK = process.env.PAGINITY_CONTAINER_NETWORK ?? 'host';
    p = await startPaginity({ isolation: 'podman' });
    ({ c } = await setupOwner(p));
  }, 300_000);
  afterAll(async () => stopPaginity(p));

  it('exécute les fonctions dans un conteneur qui ne voit que le code du site', async () => {
    const s = await c.call('POST', '/api/sites', { nom: 'Conteneur', modele: 'vierge' });
    slug = s.json.slug;
    await writeFiles(c, s.json.id, {
      'paginity.yml': FONCTIONS['paginity.yml'],
      'netlify/lib/outil.mjs': FONCTIONS['netlify/lib/outil.mjs'],
      'netlify/functions/echo.mjs': FONCTIONS['netlify/functions/echo.mjs'],
      'netlify/functions/espion.mjs': FONCTIONS['netlify/functions/espion.mjs'],
    });
    const j = await c.call('POST', `/api/sites/${s.json.id}/publier`, {});
    const done = await waitJob(p, j.json.id);
    if (done.erreur) console.log(p.ctx.functions.recentLogs(s.json.id).join('\n'));
    expect(done.erreur).toBeNull();
    expect(done.etapes.find((e) => e.nom === 'Fonctions serveur')!.message).toMatch(/conteneur isolé/);
    const r = await getSite(p, `${slug}.localhost`, '/api/echo/Conteneur');
    expect(JSON.parse(r.body).message).toBe('Bonjour Conteneur');
    const spy = JSON.parse((await getSite(p, `${slug}.localhost`, `/api/espion?fichier=${encodeURIComponent(`${p.dir}/coffre/cle-maitre`)}`)).body);
    expect(spy.lecture).toBe('ENOENT'); // le fichier n'existe tout simplement pas dans le conteneur
    expect(spy.ecriture).not.toBe('ok'); // système de fichiers en lecture seule
  }, 300_000);
});
