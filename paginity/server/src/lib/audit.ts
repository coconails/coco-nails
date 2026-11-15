import type { Db } from '../db.js';
import { now } from './util.js';

/** Journal d'audit : qui a fait quoi, quand, sur quel site, depuis quelle adresse. */
export function audit(
  db: Db,
  entry: { userId?: string | null; ip?: string | null; action: string; siteId?: string | null; details?: Record<string, unknown> },
): void {
  db.prepare('INSERT INTO audit (at, user_id, ip, action, site_id, details) VALUES (?, ?, ?, ?, ?, ?)').run(
    now(),
    entry.userId ?? null,
    entry.ip ?? null,
    entry.action,
    entry.siteId ?? null,
    JSON.stringify(entry.details ?? {}),
  );
}

/** Suppression des entrées de plus d'un an (durée à revoir avant toute activité professionnelle). */
export function pruneAudit(db: Db, retentionDays = 365): void {
  db.prepare('DELETE FROM audit WHERE at < ?').run(now() - retentionDays * 86_400_000);
}
