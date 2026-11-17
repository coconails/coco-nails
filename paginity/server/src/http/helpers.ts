import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import type { SessionRow, UserRow } from '../auth/service.js';
import { now, randomToken, UserError } from '../lib/util.js';
import { realIp } from '../lib/ip.js';
import { DEVICE_DAYS, newDeviceToken, readDevice, type Device } from '../auth/devices.js';

export const SESSION_COOKIE = 'paginity_session';
export const CSRF_COOKIE = 'paginity_csrf';

declare module 'fastify' {
  interface FastifyRequest {
    auth: { user: UserRow; session: SessionRow } | null;
  }
}

export const DEVICE_COOKIE = 'paginity_appareil';

export function ipOf(req: FastifyRequest): string {
  return realIp(req.socket?.remoteAddress ?? req.ip, req.headers);
}

/** Appareil reconnu (cookie signé posé après une connexion réussie), ou null. */
export function deviceOf(ctx: Ctx, req: FastifyRequest): Device | null {
  return readDevice(ctx, req.cookies?.[DEVICE_COOKIE]);
}

/** Marque ce navigateur comme appareil habituel de la personne (180 jours). Ne donne aucun accès à lui seul. */
export function setDeviceCookie(ctx: Ctx, reply: FastifyReply, userId: string, current: Device | null): void {
  if (current && current.userId === userId) return;
  reply.setCookie(DEVICE_COOKIE, newDeviceToken(ctx, userId), {
    path: '/api/',
    httpOnly: true,
    sameSite: 'strict',
    secure: ctx.config.secureCookies,
    maxAge: DEVICE_DAYS * 86_400,
  });
}

/** Utilisateur connecté avec double authentification validée (sinon refus). */
export function requireUser(req: FastifyRequest): { user: UserRow; session: SessionRow } {
  if (!req.auth) throw new UserError(401, 'Vous devez être connecté.');
  if (!req.auth.session.mfa_ok) throw new UserError(403, 'Terminez d’abord la configuration de la double authentification.', { configurer2fa: true });
  return req.auth;
}

/** Connecté, même si la double authentification n'est pas encore configurée (écrans de configuration uniquement). */
export function requireSession(req: FastifyRequest): { user: UserRow; session: SessionRow } {
  if (!req.auth) throw new UserError(401, 'Vous devez être connecté.');
  return req.auth;
}

export function requireOwner(req: FastifyRequest): { user: UserRow; session: SessionRow } {
  const a = requireUser(req);
  if (!a.user.is_owner) throw new UserError(403, 'Réservé au propriétaire de la plateforme.');
  return a;
}

/** Actions sensibles : l'identité doit avoir été confirmée il y a moins de quelques minutes. */
export function requireSudo(req: FastifyRequest): { user: UserRow; session: SessionRow } {
  const a = requireUser(req);
  if (a.session.sudo_until < now()) throw new UserError(403, 'Pour cette action sensible, confirmez votre identité.', { confirmation: true });
  return a;
}

/** Propriétaire de la plateforme ET identité confirmée récemment (réglages sensibles de la plateforme). */
export function requireSudoOwner(req: FastifyRequest): { user: UserRow; session: SessionRow } {
  requireOwner(req);
  return requireSudo(req);
}

export function setSessionCookie(ctx: Ctx, reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: ctx.config.secureCookies,
    maxAge: ctx.config.sessionMaxHours * 3600,
  });
}

export function clearSessionCookie(ctx: Ctx, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'strict', secure: ctx.config.secureCookies });
}

export function ensureCsrfCookie(ctx: Ctx, req: FastifyRequest, reply: FastifyReply): string {
  const existing = req.cookies[CSRF_COOKIE];
  if (existing && /^[A-Za-z0-9_-]{20,80}$/.test(existing)) return existing;
  const token = randomToken(24);
  reply.setCookie(CSRF_COOKIE, token, { path: '/', httpOnly: false, sameSite: 'strict', secure: ctx.config.secureCookies });
  return token;
}

export function body<T = Record<string, unknown>>(req: FastifyRequest): T {
  const b = req.body;
  if (!b || typeof b !== 'object') return {} as T;
  return b as T;
}
