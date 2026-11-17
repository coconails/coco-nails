import crypto from 'node:crypto';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupOwner, startPaginity, stopPaginity, type Client } from './helpers.js';
import { raiseAlert } from '../src/lib/alerts.js';

/**
 * Notifications Web Push : un « téléphone » simulé (ses propres clés) reçoit des messages chiffrés qu'il DÉCHIFFRE
 * avec une implémentation indépendante de la RFC 8291 ; la signature VAPID est vérifiée avec la clé publique.
 * Le service de notification est simulé : aucun envoi réel.
 */
type P = Awaited<ReturnType<typeof startPaginity>>;
const hmac = (k: Buffer, d: Buffer) => crypto.createHmac('sha256', k).update(d).digest();

/** Déchiffrement côté « navigateur », écrit séparément du code de PAGINITY. */
function dechiffrer(corps: Buffer, ua: crypto.ECDH, auth: Buffer): string {
  const sel = corps.subarray(0, 16);
  const idlen = corps[20];
  const asPub = corps.subarray(21, 21 + idlen);
  const donnees = corps.subarray(21 + idlen);
  const partage = ua.computeSecret(asPub);
  const prkKey = hmac(auth, partage);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub, Buffer.from([1])]));
  const prk = hmac(sel, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(donnees.subarray(donnees.length - 16));
  const clair = Buffer.concat([d.update(donnees.subarray(0, donnees.length - 16)), d.final()]);
  expect(clair.at(-1)).toBe(2); // délimiteur du dernier enregistrement
  return clair.subarray(0, clair.length - 1).toString();
}

describe('Notifications sur le téléphone (Web Push)', () => {
  let p: P;
  let c: Client;
  let service: http.Server;
  let base: string;
  let reponse = 201;
  const recus: { url: string; entetes: http.IncomingHttpHeaders; corps: Buffer }[] = [];
  const telephone = crypto.createECDH('prime256v1');
  telephone.generateKeys();
  const auth = crypto.randomBytes(16);

  beforeAll(async () => {
    service = http.createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (d) => parts.push(d));
      req.on('end', () => {
        recus.push({ url: req.url!, entetes: req.headers, corps: Buffer.concat(parts) });
        res.writeHead(reponse).end();
      });
    });
    await new Promise<void>((r) => service.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
    p = await startPaginity();
    ({ c } = await setupOwner(p));
  }, 60_000);
  afterAll(async () => {
    await stopPaginity(p);
    service.close();
  });
  const abonnement = (endpoint: string) => ({ endpoint, keys: { p256dh: telephone.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } });

  it('refuse un abonnement aux clés invalides', async () => {
    expect((await c.call('POST', '/api/push/abonnement', { endpoint: `${base}/x`, keys: { p256dh: 'abc', auth: 'abc' } })).status).toBe(400);
    expect((await c.call('POST', '/api/push/abonnement', { endpoint: 'pas une adresse', keys: {} })).status).toBe(400);
  });

  it('envoie une notification chiffrée, signée, que seul le téléphone peut lire', async () => {
    const cle = (await c.call('GET', '/api/push')).json.cle as string;
    expect((await c.call('POST', '/api/push/abonnement', abonnement(`${base}/push/tel-1`))).json.appareils).toBe(1);
    recus.length = 0;
    expect((await c.call('POST', '/api/push/essai')).json.envoyes).toBe(1);
    const r = recus[0];
    expect(r.url).toBe('/push/tel-1');
    expect(r.entetes['content-encoding']).toBe('aes128gcm');
    expect(r.corps.includes(Buffer.from('essai'))).toBe(false); // illisible en route
    expect(JSON.parse(dechiffrer(r.corps, telephone, auth))).toEqual({ titre: 'PAGINITY', texte: 'Notification d’essai : tout fonctionne.', url: '/' });
    // Signature VAPID vérifiée avec la clé publique annoncée.
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(String(r.entetes.authorization))!;
    expect(m[4]).toBe(cle);
    const pub = Buffer.from(cle, 'base64url');
    const cleV = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: cleV, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(m[2], 'base64url').toString()).aud).toBe(base);
  });

  it('une alerte critique part au propriétaire, en urgence', async () => {
    recus.length = 0;
    raiseAlert(p.ctx, 'critique', 'La sauvegarde automatique a échoué : disque absent.');
    for (let i = 0; i < 50 && !recus.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(recus[0].entetes.urgency).toBe('high');
    expect(JSON.parse(dechiffrer(recus[0].corps, telephone, auth)).texte).toBe('La sauvegarde automatique a échoué : disque absent.');
  });

  it('un appareil désabonné (410) est oublié', async () => {
    reponse = 410;
    expect((await c.call('POST', '/api/push/essai')).json.envoyes).toBe(0);
    expect((await c.call('GET', '/api/push')).json.appareils).toBe(0);
    reponse = 201;
  });
});
