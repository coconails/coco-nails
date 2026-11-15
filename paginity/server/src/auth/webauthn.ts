import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { Ctx } from '../context.js';
import { adminOrigin } from '../config.js';
import { now, UserError } from '../lib/util.js';
import type { UserRow } from './service.js';

/**
 * Passkeys (WebAuthn) : connexion par empreinte, visage ou code de l'appareil,
 * résistante à l'hameçonnage (la clé ne fonctionne que sur la vraie adresse de PAGINITY).
 */

interface PasskeyRow {
  id: string;
  user_id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string | null;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

export function listPasskeys(ctx: Ctx, userId: string) {
  return (ctx.db.prepare('SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at').all(userId) as Pick<
    PasskeyRow,
    'id' | 'name' | 'created_at' | 'last_used_at'
  >[]).map((p) => ({ id: p.id, nom: p.name, creeLe: p.created_at, utiliseeLe: p.last_used_at }));
}

export async function registrationOptions(ctx: Ctx, user: UserRow, sessionIdHash: string) {
  const existing = ctx.db.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?').all(user.id) as { id: string; transports: string | null }[];
  const options = await generateRegistrationOptions({
    rpName: ctx.config.rpName,
    rpID: ctx.config.rpId,
    userName: user.email,
    userDisplayName: user.name,
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    excludeCredentials: existing.map((e) => ({ id: e.id, transports: e.transports ? JSON.parse(e.transports) : undefined })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  ctx.db.prepare('UPDATE sessions SET webauthn_challenge = ? WHERE id_hash = ?').run(options.challenge, sessionIdHash);
  return options;
}

export async function registerPasskey(ctx: Ctx, user: UserRow, sessionIdHash: string, response: unknown, name: unknown): Promise<void> {
  const row = ctx.db.prepare('SELECT webauthn_challenge FROM sessions WHERE id_hash = ?').get(sessionIdHash) as { webauthn_challenge: string | null } | undefined;
  if (!row?.webauthn_challenge) throw new UserError(400, 'Demande d’enregistrement expirée. Recommencez.');
  ctx.db.prepare('UPDATE sessions SET webauthn_challenge = NULL WHERE id_hash = ?').run(sessionIdHash);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: response as any,
      expectedChallenge: row.webauthn_challenge,
      expectedOrigin: adminOrigin(ctx.config),
      expectedRPID: ctx.config.rpId,
      requireUserVerification: false,
    });
  } catch (e) {
    throw new UserError(400, `La passkey n’a pas pu être vérifiée : ${(e as Error).message}`);
  }
  if (!verification.verified) throw new UserError(400, 'La passkey n’a pas pu être vérifiée.');
  const cred = verification.registrationInfo.credential;
  const label = (typeof name === 'string' && name.trim() ? name.trim() : 'Passkey').slice(0, 60);
  ctx.db
    .prepare('INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(cred.id, user.id, Buffer.from(cred.publicKey), cred.counter, JSON.stringify(cred.transports ?? []), label, now());
}

export async function authenticationOptions(ctx: Ctx, userId: string) {
  const creds = ctx.db.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?').all(userId) as { id: string; transports: string | null }[];
  if (!creds.length) throw new UserError(400, 'Aucune passkey n’est enregistrée pour ce compte.');
  return generateAuthenticationOptions({
    rpID: ctx.config.rpId,
    allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
    userVerification: 'preferred',
  });
}

/** Vérifie une réponse d'authentification ; renvoie vrai si la passkey appartient bien à l'utilisateur. */
export async function verifyPasskey(ctx: Ctx, userId: string, expectedChallenge: string, response: unknown): Promise<boolean> {
  const id = (response as { id?: unknown })?.id;
  if (typeof id !== 'string') return false;
  const pk = ctx.db.prepare('SELECT * FROM passkeys WHERE id = ? AND user_id = ?').get(id, userId) as PasskeyRow | undefined;
  if (!pk) return false;
  try {
    const v = await verifyAuthenticationResponse({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: response as any,
      expectedChallenge,
      expectedOrigin: adminOrigin(ctx.config),
      expectedRPID: ctx.config.rpId,
      credential: {
        id: pk.id,
        publicKey: new Uint8Array(pk.public_key),
        counter: pk.counter,
        transports: pk.transports ? JSON.parse(pk.transports) : undefined,
      },
      requireUserVerification: false,
    });
    if (!v.verified) return false;
    ctx.db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(v.authenticationInfo.newCounter, now(), pk.id);
    return true;
  } catch {
    return false;
  }
}

export function deletePasskey(ctx: Ctx, user: UserRow, id: string): void {
  const count = (ctx.db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(user.id) as { n: number }).n;
  if (count <= 1 && user.totp_enabled !== 1) {
    throw new UserError(400, 'Impossible : c’est votre seule méthode de double authentification. Activez d’abord les codes à 6 chiffres.');
  }
  const r = ctx.db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(id, user.id);
  if (r.changes === 0) throw new UserError(404, 'Passkey introuvable.');
}
