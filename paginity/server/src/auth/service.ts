import crypto from 'node:crypto';
import { TOTP, Secret } from 'otpauth';
import QRCode from 'qrcode';
import type { Ctx } from '../context.js';
import { now, randomId, randomToken, sha256, UserError, timingSafeEqualStr } from '../lib/util.js';
import { checkPasswordPolicy, dummyVerify, hashPassword, verifyPassword } from './passwords.js';
import { tx } from '../db.js';
import { raiseAlert } from '../lib/alerts.js';
import type { Device } from './devices.js';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  is_owner: number;
  totp_secret_enc: string | null;
  totp_pending_enc: string | null;
  totp_enabled: number;
  totp_last_step: number;
  disabled: number;
  created_at: number;
}

export interface SessionRow {
  id_hash: string;
  user_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  mfa_ok: number;
  sudo_until: number;
  ip: string | null;
  user_agent: string | null;
  webauthn_challenge: string | null;
}

export interface LoginChallengeRow {
  token_hash: string;
  user_id: string;
  expires_at: number;
  attempts: number;
  webauthn_challenge: string | null;
}

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60_000;
const CHALLENGE_MS = 5 * 60_000;

export function normalizeEmail(email: unknown): string {
  if (typeof email !== 'string') throw new UserError(400, 'Adresse e-mail manquante.');
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 200) throw new UserError(400, 'Adresse e-mail invalide.');
  return e;
}

// ---------------------------------------------------------------------------
// Limitation des tentatives (par adresse IP et par compte)
// ---------------------------------------------------------------------------

export function assertNotLocked(ctx: Ctx, keys: string[]): void {
  for (const key of keys) {
    const r = ctx.db.prepare('SELECT locked_until FROM login_attempts WHERE key = ?').get(key) as { locked_until: number } | undefined;
    if (r && r.locked_until > now()) {
      const minutes = Math.ceil((r.locked_until - now()) / 60_000);
      throw new UserError(429, `Trop de tentatives. Par sécurité, réessayez dans ${minutes} minute${minutes > 1 ? 's' : ''}.`);
    }
  }
}

/** Compte une erreur pour chaque clé. Renvoie les clés qui viennent d'être bloquées. */
export function recordFailure(ctx: Ctx, keys: string[]): string[] {
  const t = now();
  const lockedKeys: string[] = [];
  for (const key of keys) {
    const r = ctx.db.prepare('SELECT failures, first_at FROM login_attempts WHERE key = ?').get(key) as { failures: number; first_at: number } | undefined;
    let failures = 1;
    let firstAt = t;
    if (r && t - r.first_at < WINDOW_MS) {
      failures = r.failures + 1;
      firstAt = r.first_at;
    }
    // Blocage progressif : 1, 2, 4, 8… minutes (60 maximum) à partir de la 5e erreur.
    const locked = failures >= MAX_FAILURES ? t + Math.min(60, 2 ** (failures - MAX_FAILURES)) * 60_000 : 0;
    ctx.db
      .prepare(
        'INSERT INTO login_attempts (key, failures, first_at, locked_until) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, first_at = excluded.first_at, locked_until = excluded.locked_until',
      )
      .run(key, failures, firstAt, locked);
    if (locked) lockedKeys.push(key);
  }
  return lockedKeys;
}

/**
 * Clés de comptage des erreurs de connexion.
 * - Depuis un appareil reconnu de CE compte : seulement cet appareil (un inconnu ne peut pas le bloquer).
 * - Sinon : l'adresse IP et le compte visé (« nouvel appareil »).
 */
export function loginKeys(ip: string, email: string, user: { id: string } | undefined, device: Device | null): string[] {
  if (device && user && device.userId === user.id) return [`appareil:${device.id}`];
  return [`ip:${ip}`, `email:${email}`];
}

function warnIfAccountLocked(ctx: Ctx, locked: string[], email: string): void {
  if (!locked.some((k) => k.startsWith('email:'))) return;
  raiseAlert(
    ctx,
    'attention',
    `Plusieurs mots de passe erronés pour le compte ${email} : les connexions depuis un nouvel appareil sont bloquées un moment. Les appareils habituels ne sont pas concernés.`,
  );
}

export function clearFailures(ctx: Ctx, keys: string[]): void {
  for (const key of keys) ctx.db.prepare('DELETE FROM login_attempts WHERE key = ?').run(key);
}

// ---------------------------------------------------------------------------
// Utilisateurs
// ---------------------------------------------------------------------------

export function getUser(ctx: Ctx, id: string): UserRow | undefined {
  return ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function getUserByEmail(ctx: Ctx, email: string): UserRow | undefined {
  return ctx.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
}

export function userCount(ctx: Ctx): number {
  return (ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

export async function createUser(ctx: Ctx, input: { email: string; name: string; password: string; isOwner: boolean }): Promise<UserRow> {
  const email = normalizeEmail(input.email);
  const name = String(input.name ?? '').trim().slice(0, 80);
  if (!name) throw new UserError(400, 'Le nom est obligatoire.');
  checkPasswordPolicy(input.password, email);
  if (getUserByEmail(ctx, email)) throw new UserError(409, 'Un compte existe déjà avec cette adresse e-mail.');
  const id = randomId('u');
  const passwordHash = await hashPassword(input.password);
  ctx.db
    .prepare('INSERT INTO users (id, email, name, password_hash, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, email, name, passwordHash, input.isOwner ? 1 : 0, now());
  return getUser(ctx, id)!;
}

export function userHas2fa(ctx: Ctx, user: UserRow): { totp: boolean; passkey: boolean } {
  const pk = (ctx.db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(user.id) as { n: number }).n;
  return { totp: user.totp_enabled === 1, passkey: pk > 0 };
}

export function publicUser(ctx: Ctx, user: UserRow) {
  const f = userHas2fa(ctx, user);
  const recovery = (ctx.db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(user.id) as { n: number }).n;
  return {
    id: user.id,
    email: user.email,
    nom: user.name,
    proprietaire: user.is_owner === 1,
    doubleAuthentification: { totp: f.totp, passkey: f.passkey, codesSecoursRestants: recovery },
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function createSession(ctx: Ctx, userId: string, opts: { mfaOk: boolean; ip?: string; userAgent?: string }): string {
  const token = randomToken(32);
  const t = now();
  ctx.db
    .prepare('INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, mfa_ok, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sha256(token), userId, t, t, t + ctx.config.sessionMaxHours * 3_600_000, opts.mfaOk ? 1 : 0, opts.ip ?? null, (opts.userAgent ?? '').slice(0, 200));
  return token;
}

export function loadSession(ctx: Ctx, token: string | undefined): { session: SessionRow; user: UserRow } | null {
  if (!token || token.length > 100) return null;
  const session = ctx.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(sha256(token)) as SessionRow | undefined;
  if (!session) return null;
  const t = now();
  const idleLimit = session.last_seen_at + ctx.config.sessionIdleMinutes * 60_000;
  if (session.expires_at < t || idleLimit < t) {
    ctx.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(session.id_hash);
    return null;
  }
  const user = getUser(ctx, session.user_id);
  if (!user || user.disabled) return null;
  if (t - session.last_seen_at > 30_000) {
    ctx.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(t, session.id_hash);
  }
  return { session, user };
}

export function destroySession(ctx: Ctx, idHash: string): void {
  ctx.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
}

export function destroyAllSessions(ctx: Ctx, userId: string, exceptIdHash?: string): void {
  if (exceptIdHash) ctx.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(userId, exceptIdHash);
  else ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function markMfa(ctx: Ctx, idHash: string): void {
  ctx.db.prepare('UPDATE sessions SET mfa_ok = 1 WHERE id_hash = ?').run(idHash);
}

export function grantSudo(ctx: Ctx, idHash: string): void {
  ctx.db.prepare('UPDATE sessions SET sudo_until = ? WHERE id_hash = ?').run(now() + ctx.config.sudoMinutes * 60_000, idHash);
}

export function pruneExpired(ctx: Ctx): void {
  const t = now();
  ctx.db.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?').run(t, t - ctx.config.sessionIdleMinutes * 60_000);
  ctx.db.prepare('DELETE FROM login_challenges WHERE expires_at < ?').run(t);
  ctx.db.prepare('DELETE FROM login_attempts WHERE first_at < ? AND locked_until < ?').run(t - WINDOW_MS, t);
}

// ---------------------------------------------------------------------------
// Étape 1 : mot de passe
// ---------------------------------------------------------------------------

export async function checkCredentials(ctx: Ctx, emailInput: unknown, password: unknown, ip: string, device: Device | null = null): Promise<UserRow> {
  const email = normalizeEmail(emailInput);
  const user = getUserByEmail(ctx, email);
  const keys = loginKeys(ip, email, user, device);
  assertNotLocked(ctx, keys);
  const pw = typeof password === 'string' ? password : '';
  let ok = false;
  if (user && !user.disabled) ok = await verifyPassword(user.password_hash, pw);
  else await dummyVerify(pw);
  if (!ok || !user) {
    warnIfAccountLocked(ctx, recordFailure(ctx, keys), email);
    throw new UserError(401, 'Adresse e-mail ou mot de passe incorrect.');
  }
  return user;
}

export function createLoginChallenge(ctx: Ctx, userId: string): string {
  const token = randomToken(24);
  ctx.db.prepare('INSERT INTO login_challenges (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, now() + CHALLENGE_MS);
  return token;
}

export function getLoginChallenge(ctx: Ctx, token: unknown): LoginChallengeRow {
  if (typeof token !== 'string') throw new UserError(400, 'Demande de connexion invalide.');
  const row = ctx.db.prepare('SELECT * FROM login_challenges WHERE token_hash = ?').get(sha256(token)) as LoginChallengeRow | undefined;
  if (!row || row.expires_at < now()) throw new UserError(401, 'La demande de connexion a expiré. Recommencez depuis le début.');
  if (row.attempts >= MAX_FAILURES) {
    ctx.db.prepare('DELETE FROM login_challenges WHERE token_hash = ?').run(row.token_hash);
    throw new UserError(429, 'Trop de codes incorrects. Recommencez la connexion depuis le début.');
  }
  return row;
}

export function failChallenge(ctx: Ctx, row: LoginChallengeRow, ip: string, device: Device | null = null): void {
  ctx.db.prepare('UPDATE login_challenges SET attempts = attempts + 1 WHERE token_hash = ?').run(row.token_hash);
  const user = getUser(ctx, row.user_id);
  if (!user) return void recordFailure(ctx, [`ip:${ip}`]);
  warnIfAccountLocked(ctx, recordFailure(ctx, loginKeys(ip, user.email, user, device)), user.email);
}

export function consumeChallenge(ctx: Ctx, row: LoginChallengeRow): void {
  ctx.db.prepare('DELETE FROM login_challenges WHERE token_hash = ?').run(row.token_hash);
}

// ---------------------------------------------------------------------------
// Codes à 6 chiffres (TOTP)
// ---------------------------------------------------------------------------

function totpFor(secret: string, email: string): TOTP {
  return new TOTP({ issuer: 'PAGINITY', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) });
}

export async function startTotpSetup(ctx: Ctx, user: UserRow): Promise<{ secret: string; uri: string; qr: string }> {
  const secret = new Secret({ size: 20 }).base32;
  ctx.db.prepare('UPDATE users SET totp_pending_enc = ? WHERE id = ?').run(ctx.vault.encrypt(secret), user.id);
  const uri = totpFor(secret, user.email).toString();
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
  return { secret, uri, qr };
}

/** Vérifie un code ; refuse la réutilisation d'un code déjà accepté. */
export function verifyTotp(ctx: Ctx, user: UserRow, code: unknown, opts: { pending?: boolean } = {}): boolean {
  if (typeof code !== 'string') return false;
  const token = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(token)) return false;
  const enc = opts.pending ? user.totp_pending_enc : user.totp_secret_enc;
  if (!enc) return false;
  const secret = ctx.vault.decrypt(enc);
  const delta = totpFor(secret, user.email).validate({ token, window: 1 });
  if (delta === null) return false;
  const step = Math.floor(now() / 30_000) + delta;
  if (step <= user.totp_last_step) return false;
  ctx.db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
  user.totp_last_step = step;
  return true;
}

export function confirmTotpSetup(ctx: Ctx, user: UserRow, code: unknown): void {
  if (!user.totp_pending_enc) throw new UserError(400, "Commencez par afficher le QR code.");
  if (!verifyTotp(ctx, user, code, { pending: true })) throw new UserError(400, 'Code incorrect. Vérifiez l’heure de votre téléphone et réessayez.');
  ctx.db.prepare('UPDATE users SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_enabled = 1 WHERE id = ?').run(user.id);
}

export function disableTotp(ctx: Ctx, user: UserRow): void {
  const f = userHas2fa(ctx, user);
  if (!f.passkey) throw new UserError(400, 'Impossible : la double authentification est obligatoire. Ajoutez d’abord une passkey.');
  ctx.db.prepare('UPDATE users SET totp_secret_enc = NULL, totp_enabled = 0 WHERE id = ?').run(user.id);
}

// ---------------------------------------------------------------------------
// Codes de secours
// ---------------------------------------------------------------------------

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function generateRecoveryCodes(ctx: Ctx, userId: string): string[] {
  const codes: string[] = [];
  for (let i = 0; i < 10; i++) {
    let c = '';
    const bytes = crypto.randomBytes(10);
    for (let j = 0; j < 10; j++) c += ALPHABET[bytes[j] % ALPHABET.length];
    codes.push(`${c.slice(0, 5)}-${c.slice(5)}`);
  }
  tx(ctx.db, () => {
    ctx.db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
    const ins = ctx.db.prepare('INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)');
    for (const c of codes) ins.run(randomId('rc'), userId, sha256(c));
  });
  return codes;
}

export function useRecoveryCode(ctx: Ctx, userId: string, code: unknown): boolean {
  if (typeof code !== 'string') return false;
  const norm = code.trim().toLowerCase().replace(/\s+/g, '');
  const h = sha256(norm.includes('-') ? norm : `${norm.slice(0, 5)}-${norm.slice(5)}`);
  const rows = ctx.db.prepare('SELECT id, code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').all(userId) as { id: string; code_hash: string }[];
  const match = rows.find((r) => timingSafeEqualStr(r.code_hash, h));
  if (!match) return false;
  ctx.db.prepare('UPDATE recovery_codes SET used_at = ? WHERE id = ?').run(now(), match.id);
  return true;
}

export async function changePassword(ctx: Ctx, user: UserRow, current: unknown, next: unknown): Promise<void> {
  if (typeof current !== 'string' || !(await verifyPassword(user.password_hash, current))) {
    throw new UserError(400, 'Le mot de passe actuel est incorrect.');
  }
  if (typeof next !== 'string') throw new UserError(400, 'Nouveau mot de passe manquant.');
  checkPasswordPolicy(next, user.email);
  ctx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(next), user.id);
}
