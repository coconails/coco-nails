import crypto from 'node:crypto';
import type { Ctx } from '../context.js';
import { now } from '../lib/util.js';

/**
 * Appareils reconnus (protection contre le blocage volontaire d'un compte).
 * Après une connexion réussie, le navigateur reçoit un cookie signé « cet appareil a déjà été utilisé par telle personne ».
 * Ce cookie NE DONNE AUCUN ACCÈS : mot de passe et double authentification restent exigés.
 * Il sert seulement à compter les erreurs à part : un inconnu qui se trompe de mot de passe bloque les nouveaux
 * appareils pour ce compte, mais pas les appareils habituels de la personne.
 */
export const DEVICE_DAYS = 180;

export interface Device {
  userId: string;
  /** Identifiant propre à cet appareil (pour compter ses erreurs). */
  id: string;
}

export function newDeviceToken(ctx: Ctx, userId: string): string {
  const id = crypto.randomBytes(12).toString('base64url');
  const payload = `v1.${userId}.${id}.${now()}`;
  return `${payload}.${ctx.vault.sign(`appareil:${payload}`)}`;
}

export function readDevice(ctx: Ctx, token: unknown): Device | null {
  if (typeof token !== 'string' || token.length > 300) return null;
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') return null;
  const [, userId, id, issued, sig] = parts;
  const expected = ctx.vault.sign(`appareil:${parts.slice(0, 4).join('.')}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (!(Number(issued) > now() - DEVICE_DAYS * 86_400_000)) return null;
  return { userId, id };
}
