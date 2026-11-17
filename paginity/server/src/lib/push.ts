import crypto from 'node:crypto';
import type { Ctx } from '../context.js';
import { getSetting, setSetting } from '../db.js';
import { now, randomId, UserError } from './util.js';

/**
 * Notifications sur le téléphone (« Web Push », norme des navigateurs, sans service payant ni dépendance) :
 * PAGINITY chiffre chaque notification pour l'appareil (RFC 8291, aes128gcm) et la signe avec sa propre clé
 * (VAPID, RFC 8292). Le service de notification du navigateur (Google, Apple, Mozilla) ne voit qu'un message chiffré.
 * Envoyées : les alertes (au propriétaire) et les nouveaux messages des formulaires (aux personnes qui gèrent le site).
 */
const b64u = (b: Buffer) => b.toString('base64url');
const hmac = (cle: Buffer, d: Buffer) => crypto.createHmac('sha256', cle).update(d).digest();
/** HKDF-Expand limité à un bloc (≤ 32 octets), suffisant ici. */
const expand = (prk: Buffer, info: Buffer, n: number) => hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, n);

export interface Notification {
  titre: string;
  texte: string;
  url?: string;
  urgent?: boolean;
}

/** Chiffre un message pour un abonnement (RFC 8291). Exporté pour les tests. */
export function chiffrer(contenu: Buffer, uaPublic: Buffer, auth: Buffer, sel = crypto.randomBytes(16)): Buffer {
  const ephemere = crypto.createECDH('prime256v1');
  ephemere.generateKeys();
  const asPublic = ephemere.getPublicKey();
  const partage = ephemere.computeSecret(uaPublic);
  const ikm = expand(hmac(auth, partage), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const prk = hmac(sel, ikm);
  const cek = expand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = expand(prk, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const chiffre = Buffer.concat([c.update(Buffer.concat([contenu, Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([sel, rs, Buffer.from([asPublic.length]), asPublic, chiffre]);
}

export class Push {
  constructor(private ctx: Ctx) {}

  /** Clés VAPID de cette installation (créées une fois, gardées chiffrées dans le coffre). */
  private cles(): { publique: Buffer; privee: crypto.KeyObject } {
    let v = getSetting(this.ctx.db, 'push_vapid');
    if (!v) {
      const e = crypto.createECDH('prime256v1');
      e.generateKeys();
      v = this.ctx.vault.encrypt(JSON.stringify({ d: b64u(e.getPrivateKey()), pub: b64u(e.getPublicKey()) }));
      setSetting(this.ctx.db, 'push_vapid', v);
    }
    const o = JSON.parse(this.ctx.vault.decrypt(v)) as { d: string; pub: string };
    const pub = Buffer.from(o.pub, 'base64url');
    const privee = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: o.d, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
    return { publique: pub, privee };
  }
  clePublique(): string {
    return b64u(this.cles().publique);
  }

  abonner(userId: string, input: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }): void {
    const endpoint = String(input.endpoint ?? '');
    let u: URL;
    try {
      u = new URL(endpoint);
    } catch {
      throw new UserError(400, 'Abonnement invalide.');
    }
    const local = ['localhost', '127.0.0.1'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(local && process.env.NODE_ENV === 'test')) throw new UserError(400, 'Abonnement invalide (adresse non sécurisée).');
    const p256dh = Buffer.from(String(input.keys?.p256dh ?? ''), 'base64url');
    const auth = Buffer.from(String(input.keys?.auth ?? ''), 'base64url');
    if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) throw new UserError(400, 'Abonnement invalide (clés).');
    this.ctx.db
      .prepare('INSERT INTO push_abonnements (id, user_id, endpoint, p256dh, auth, cree_le) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth')
      .run(randomId('push'), userId, endpoint, b64u(p256dh), b64u(auth), now());
  }
  desabonner(userId: string, endpoint: unknown): void {
    this.ctx.db.prepare('DELETE FROM push_abonnements WHERE user_id = ? AND endpoint = ?').run(userId, String(endpoint ?? ''));
  }
  nombre(userId: string): number {
    return (this.ctx.db.prepare('SELECT COUNT(*) AS n FROM push_abonnements WHERE user_id = ?').get(userId) as { n: number }).n;
  }

  /** Envoie à tous les appareils d'une personne. Renvoie le nombre d'envois réussis. */
  async envoyer(userId: string, n: Notification): Promise<number> {
    const abos = this.ctx.db.prepare('SELECT * FROM push_abonnements WHERE user_id = ?').all(userId) as { id: string; endpoint: string; p256dh: string; auth: string }[];
    if (!abos.length) return 0;
    const { publique, privee } = this.cles();
    const contenu = Buffer.from(JSON.stringify({ titre: n.titre.slice(0, 80), texte: n.texte.slice(0, 240), url: n.url ?? '/' }));
    let ok = 0;
    for (const a of abos) {
      try {
        const aud = new URL(a.endpoint).origin;
        const entete = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
        const charge = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: `mailto:alertes@${new URL(this.ctx.config.publicUrl).hostname}` })));
        const signature = crypto.sign('sha256', Buffer.from(`${entete}.${charge}`), { key: privee, dsaEncoding: 'ieee-p1363' });
        const corps = chiffrer(contenu, Buffer.from(a.p256dh, 'base64url'), Buffer.from(a.auth, 'base64url'));
        const r = await fetch(a.endpoint, {
          method: 'POST',
          headers: {
            authorization: `vapid t=${entete}.${charge}.${b64u(signature)}, k=${b64u(publique)}`,
            'content-encoding': 'aes128gcm',
            'content-type': 'application/octet-stream',
            ttl: '86400',
            urgency: n.urgent ? 'high' : 'normal',
          },
          body: new Uint8Array(corps),
          signal: AbortSignal.timeout(10_000),
        });
        if (r.status === 404 || r.status === 410) this.ctx.db.prepare('DELETE FROM push_abonnements WHERE id = ?').run(a.id); // appareil désabonné
        else if (r.ok) ok++;
      } catch {
        /* appareil injoignable : on réessaiera à la prochaine notification */
      }
    }
    return ok;
  }

  /** Alerte : au(x) propriétaire(s). */
  surAlerte(niveau: string, message: string): void {
    if (niveau === 'information') return;
    for (const u of this.ctx.db.prepare('SELECT id FROM users WHERE is_owner = 1 AND disabled = 0').all() as { id: string }[]) {
      void this.envoyer(u.id, { titre: niveau === 'critique' ? 'PAGINITY — alerte' : 'PAGINITY — à surveiller', texte: message, url: '/', urgent: niveau === 'critique' }).catch(() => {});
    }
  }
  /** Nouveau message d'un formulaire : aux personnes qui peuvent le lire (Éditeur ou plus, et propriétaire). */
  surMessage(siteId: string, siteNom: string, formulaire: string): void {
    for (const u of this.ctx.db.prepare('SELECT * FROM users WHERE disabled = 0').all() as unknown as Parameters<Ctx['sites']['role']>[0][]) {
      const role = this.ctx.sites.role(u, siteId);
      if (!role || !['proprietaire', 'admin_site', 'editeur'].includes(role)) continue;
      void this.envoyer(u.id, { titre: `Nouveau message — ${siteNom}`, texte: `Formulaire « ${formulaire} ». Ouvrez PAGINITY pour le lire.`, url: `/sites/${siteId}/formulaires` }).catch(() => {});
    }
  }
}
