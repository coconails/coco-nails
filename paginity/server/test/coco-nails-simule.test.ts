import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import yazl from 'yazl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSite, setupOwner, startPaginity, stopPaginity, totpCode, waitJob, type Client } from './helpers.js';

/**
 * P1-7 : les vraies fonctions de Coco Nail's, exécutées par PAGINITY, avec Google, OVHcloud et SumUp SIMULÉS.
 * Aucune réservation, aucun e-mail, aucun SMS, aucun paiement réel : le module de simulation refuse toute adresse
 * extérieure qu'il ne connaît pas, et le test vérifie qu'aucune n'a été tentée.
 * Ignoré si le dépôt de Coco Nail's n'est pas présent (variable COCO_NAILS_DIR).
 */
const SRC = process.env.COCO_NAILS_DIR ?? '/home/user/coco-nails1';
const present = fs.existsSync(path.join(SRC, '.pages.yml'));
const PRELOAD = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'simulation', 'services-simules.mjs');
const HOTE = 'coco-nails.localhost';

function zipDir(dir: string, dest: string): Promise<void> {
  return new Promise((resolve) => {
    const z = new yazl.ZipFile();
    const walk = (d: string, rel: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else z.addFile(path.join(d, e.name), r);
      }
    };
    walk(dir, '');
    z.end();
    z.outputStream.pipe(fs.createWriteStream(dest)).on('close', () => resolve());
  });
}

interface Etat {
  evs: Record<string, any>;
  mails: string[];
  sms: any[];
  feuilles: Record<string, any[]>;
  sumup: any[];
  refuses: string[];
}

describe.skipIf(!present)('Coco Nail’s avec services simulés (aucune action réelle)', () => {
  let p: Awaited<ReturnType<typeof startPaginity>>;
  let c: Client;
  let id: string;
  let simDir: string;
  const simEnv: Record<string, string> = { PAGINITY_SIMULATION_MAINTENANT: '2026-11-23T10:00:00+01:00' };
  const etat = (): Etat => JSON.parse(fs.readFileSync(path.join(simDir, 'etat.json'), 'utf8'));
  const sujet = (raw: string) => Buffer.from(raw.match(/^Subject: =\?UTF-8\?B\?(.+?)\?=/m)![1], 'base64').toString();
  const destinataire = (raw: string) => raw.match(/^To: (.*)$/m)![1];

  function envoyer(chemin: string, corps: string, type: string, cookie = ''): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: p.ctx.config.sitesPort, path: chemin, method: 'POST', headers: { host: HOTE, 'content-type': type, ...(cookie ? { cookie } : {}) } },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
        },
      );
      req.on('error', reject);
      req.end(corps);
    });
  }
  const json = (chemin: string, donnees: unknown, cookie = '') => envoyer(chemin, JSON.stringify(donnees), 'application/json', cookie);

  beforeAll(async () => {
    simDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paginity-sim-'));
    p = await startPaginity({ simulation: { preload: PRELOAD, dir: simDir, env: simEnv } });
    simEnv.PAGINITY_SIMULATION_SITES = `127.0.0.1:${p.ctx.config.sitesPort}`;
    let secret: string;
    ({ c, secret } = await setupOwner(p));
    expect((await c.call('POST', '/api/confirmation', { motDePasse: 'une phrase de passe solide', code: totpCode(secret, 1) })).status).toBe(200);
    const zip = path.join(p.dir, 'coco.zip');
    await zipDir(SRC, zip);
    const boundary = '----coco';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="nom"\r\n\r\nCoco Nail's\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="coco.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      fs.readFileSync(zip),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const j = await c.call('POST', '/api/sites/import', body, { 'content-type': `multipart/form-data; boundary=${boundary}` });
    const imp = await waitJob(p, j.json.id);
    expect(imp.erreur).toBeNull();
    id = (imp.resultat as any).siteId;
    // Fausses clés, reconnues seulement par le simulateur.
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const secrets: Record<string, string> = {
      GOOGLE_CLIENT_EMAIL: 'site@test.iam.gserviceaccount.com',
      GOOGLE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      GOOGLE_CALENDAR_ID: 'agenda-test@exemple.fr',
      COMPTA_SHEET_ID: 'tableau-test',
      COMPTA_MOT_DE_PASSE: 'Vernis-Rouge-2026',
      OVH_APPLICATION_KEY: 'appli-ovh',
      OVH_APPLICATION_SECRET: 'secret-ovh',
      OVH_CONSUMER_KEY: 'conso-ovh',
      OVH_SMS_SERVICE: 'sms-test-1',
      OVH_SMS_EXPEDITEUR: 'CocoNails',
      SUMUP_API_KEY: 'sup_sk_test',
    };
    for (const [nom, valeur] of Object.entries(secrets)) {
      const r = await c.call('PUT', `/api/sites/${id}/secrets/production/${nom}`, { valeur });
      expect(r.status, `${nom} : ${r.body}`).toBe(200);
    }
    const pub = await c.call('POST', `/api/sites/${id}/publier`, {});
    expect((await waitJob(p, pub.json.id)).erreur).toBeNull();
  }, 240_000);
  afterAll(async () => {
    await stopPaginity(p);
    fs.rmSync(simDir, { recursive: true, force: true });
  });

  it('affiche les disponibilités lues dans l’agenda (simulé)', async () => {
    const r = await getSite(p, HOTE, '/api/disponibilites?du=2026-11-24&au=2026-11-30');
    expect(r.status, r.body).toBe(200);
    expect(JSON.parse(r.body)).toBeTypeOf('object');
  });

  it('réserve : rendez-vous « À confirmer » dans l’agenda, e-mail à Coralie et accusé à la cliente', async () => {
    const r = await json('/api/reserver', { nom: 'Julie Test', email: 'julie@exemple.fr', telephone: '06 12 34 56 78', soin: 'Pose semi-permanent', options: [], date: '2026-11-24', debut: 600, ok_prochain: false });
    expect(r.status, r.body).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, mail: true });
    const e = etat();
    const evs = Object.values(e.evs);
    expect(evs).toHaveLength(1);
    expect(evs[0].summary).toMatch(/^À confirmer : Julie Test, Pose semi-permanent/);
    expect(evs[0].extendedProperties.private).toMatchObject({ email: 'julie@exemple.fr', ok_veille: 'oui', ok_prochain: 'non' });
    expect(e.mails.map(destinataire).sort()).toEqual(['agenda-test@exemple.fr', 'julie@exemple.fr'].sort());
    // Même créneau : refusé (il vient d'être pris). Piège à robots : rien n'est créé.
    expect((await json('/api/reserver', { nom: 'Autre', email: 'a@exemple.fr', telephone: '0601020304', soin: 'Pose semi-permanent', options: [], date: '2026-11-24', debut: 600 })).status).toBe(409);
    expect((await json('/api/reserver', { 'bot-field': 'x', nom: 'Robot', email: 'r@exemple.fr', telephone: '0601020304', soin: 'Pose semi-permanent', options: [], date: '2026-11-25', debut: 600 })).status).toBe(200);
    expect(Object.keys(etat().evs)).toHaveLength(1);
  });

  it('Coralie confirme depuis l’e-mail : bouton d’abord (lien pré-ouvert par les messageries), puis confirmation', async () => {
    const ev = Object.values(etat().evs)[0];
    const lien = new URL(ev.description.match(/https?:\S+a=confirmer\S+/)[0]);
    const page = await getSite(p, HOTE, lien.pathname + lien.search);
    expect(page.status).toBe(200);
    expect(etat().evs[ev.id].summary).toMatch(/^À confirmer/); // un simple affichage ne confirme rien
    const q = lien.searchParams;
    const r = await envoyer('/api/rdv', new URLSearchParams({ id: q.get('id')!, a: 'confirmer', s: q.get('s')! }).toString(), 'application/x-www-form-urlencoded');
    expect(r.status, r.body).toBe(200);
    const e = etat();
    expect(e.evs[ev.id].summary).toBe('Julie Test, Pose semi-permanent');
    const confirmation = e.mails.at(-1)!;
    expect(destinataire(confirmation)).toBe('julie@exemple.fr');
    expect(confirmation).toMatch(/text\/calendar/);
    // Lien falsifié : refusé, rien ne change.
    const faux = await envoyer('/api/rdv', new URLSearchParams({ id: q.get('id')!, a: 'refuser', s: 'faux' }).toString(), 'application/x-www-form-urlencoded');
    expect(faux.status).toBe(403);
    expect(etat().evs[ev.id]).toBeDefined();
  });

  it('Coralie refuse une autre demande : le créneau se libère et la cliente est invitée à rechoisir', async () => {
    const r = await json('/api/reserver', { nom: 'Léa Test', email: 'lea@exemple.fr', telephone: '06 98 76 54 32', soin: 'Pose semi-permanent', options: [], date: '2026-11-24', debut: 840 });
    expect(r.status, r.body).toBe(200);
    const ev = Object.values(etat().evs).find((x: any) => /Léa/.test(x.summary));
    const q = new URL(ev.description.match(/https?:\S+a=refuser\S+/)[0]).searchParams;
    const nb = etat().mails.length;
    expect((await envoyer('/api/rdv', new URLSearchParams({ id: q.get('id')!, a: 'refuser', s: q.get('s')! }).toString(), 'application/x-www-form-urlencoded')).status).toBe(200);
    const e = etat();
    expect(e.evs[ev.id]).toBeUndefined();
    expect(e.mails).toHaveLength(nb + 1);
    expect(destinataire(e.mails.at(-1)!)).toBe('lea@exemple.fr');
  });

  it('rappel de la veille par SMS (OVHcloud simulé, signature vérifiée), lancé à la main comme le ferait le planificateur', async () => {
    const r = await c.call('POST', `/api/sites/${id}/taches/rappels/lancer`, {});
    expect(r.status, r.body).toBe(200);
    const e = etat();
    expect(e.sms).toHaveLength(1);
    expect(e.sms[0].receivers).toEqual(['+33612345678']);
    expect(e.sms[0].message).toMatch(/rappel de votre RDV demain à 10h/);
    expect(e.sms[0].sender).toBe('CocoNails');
    // Relancé une seconde fois le même jour : aucun doublon.
    await c.call('POST', `/api/sites/${id}/taches/rappels/lancer`, {});
    expect(etat().sms).toHaveLength(1);
  });

  it('compta : connexion, rendez-vous confirmé importé, paiements SumUp (simulés) lus', async () => {
    const mauvais = await json('/api/compta', { action: 'connexion', motdepasse: 'faux' });
    expect(mauvais.status).toBe(401);
    const cx = await json('/api/compta', { action: 'connexion', motdepasse: 'Vernis-Rouge-2026' });
    expect(cx.status, cx.body).toBe(200);
    const cookie = String(cx.headers['set-cookie']).split(';')[0];
    const vue = JSON.parse(cx.body).vue;
    expect(JSON.stringify(vue)).toContain('Julie Test');
    expect(JSON.stringify(vue)).not.toContain('Léa Test'); // refusée : jamais importée
    // Un paiement par carte apparaît dans SumUp (simulé).
    const e = JSON.parse(fs.readFileSync(path.join(simDir, 'etat.json'), 'utf8'));
    e.sumup.push({ id: 'id-TX1', transaction_code: 'TX1', amount: 31, currency: 'EUR', timestamp: '2026-11-23T08:30:00Z', status: 'SUCCESSFUL', type: 'PAYMENT', card_type: 'VISA' });
    fs.writeFileSync(path.join(simDir, 'etat.json'), JSON.stringify(e));
    const r = await getSite(p, HOTE, '/api/compta', { cookie });
    expect(r.status, r.body).toBe(200);
    const v2 = JSON.parse(r.body).vue;
    expect(v2.sumup.actif).toBe(true);
    expect(v2.sumup.libres.map((x: any) => x.code)).toContain('TX1');
  });

  it('aucun appel vers un service réel n’a été tenté', () => {
    expect(etat().refuses).toEqual([]);
  });

  it('le simulateur bloque vraiment toute adresse extérieure (fetch et http/https)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paginity-sim-bloc-'));
    try {
      const code = `
        const r = [];
        try { await fetch("https://example.com/"); r.push("fetch:passe"); } catch (e) { r.push("fetch:bloque"); }
        try { (await import("node:https")).get("https://example.com/"); r.push("https:passe"); } catch (e) { r.push("https:bloque"); }
        console.log(r.join(","));`;
      const out = execFileSync(process.execPath, ['--import', PRELOAD, '--input-type=module', '-e', code], {
        env: { PATH: process.env.PATH, PAGINITY_SIMULATION_DIR: dir, PAGINITY_SIMULATION_SITES: '127.0.0.1:1' },
        encoding: 'utf8',
      });
      expect(out.trim()).toBe('fetch:bloque,https:bloque');
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'etat.json'), 'utf8')).refuses).toEqual(['https://example.com/']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
