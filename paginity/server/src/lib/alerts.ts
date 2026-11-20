import type { Ctx } from '../context.js';
import { now } from './util.js';
import { maskSecrets } from '../functions/secrets.js';

/**
 * Alertes : enregistrées (tableau de bord) et envoyées par e-mail si un serveur d'envoi est configuré.
 * « critique » : e-mail immédiat. « attention » : récapitulatif quotidien. « information » : tableau de bord seulement.
 */
export type AlertLevel = 'information' | 'attention' | 'critique';

export function raiseAlert(ctx: Ctx, level: AlertLevel, messageIn: string, siteId?: string | null): void {
  // Une alerte part parfois par e-mail : jamais de valeur de secret dedans.
  const message = maskSecrets(ctx, siteId, messageIn);
  // Évite les répétitions : même message non lu dans la dernière heure.
  const dup = ctx.db.prepare('SELECT 1 FROM alerts WHERE message = ? AND read_at IS NULL AND at > ?').get(message, now() - 3_600_000);
  if (dup) return;
  const r = ctx.db.prepare('INSERT INTO alerts (at, level, message, site_id) VALUES (?, ?, ?, ?)').run(now(), level, message, siteId ?? null);
  ctx.push?.surAlerte(level, message);
  if (level === 'critique' && ctx.mailer?.configured()) {
    void ctx.mailer
      .sendAlert(`PAGINITY — alerte : ${message.slice(0, 90)}`, `${message}\n\nConsultez le tableau de bord de PAGINITY pour plus de détails.`)
      .then(() => ctx.db.prepare('UPDATE alerts SET emailed_at = ? WHERE id = ?').run(now(), r.lastInsertRowid))
      .catch((e) => console.error('[alerte] e-mail non envoyé :', (e as Error).message));
  }
}

/**
 * Alertes visibles. `pour` : la personne qui regarde (hors propriétaire) — les alertes qu'elle a marquées lues
 * pour elle-même sont masquées, sans changer ce que voient les autres.
 */
export function listAlerts(ctx: Ctx, siteIds: string[] | null, unreadOnly = true, pour?: string) {
  const luesParMoi = pour ? new Set((ctx.db.prepare('SELECT alerte_id FROM alertes_lues WHERE user_id = ?').all(pour) as { alerte_id: number }[]).map((r) => r.alerte_id)) : null;
  const rows = ctx.db.prepare(`SELECT * FROM alerts ${unreadOnly ? 'WHERE read_at IS NULL' : ''} ORDER BY id DESC LIMIT 200`).all() as {
    id: number;
    at: number;
    level: AlertLevel;
    message: string;
    site_id: string | null;
    read_at: number | null;
  }[];
  return rows
    .filter((r) => siteIds === null || (r.site_id && siteIds.includes(r.site_id)))
    .filter((r) => !(unreadOnly && luesParMoi?.has(r.id)))
    .map((r) => ({ id: r.id, le: r.at, niveau: r.level, message: r.message, siteId: r.site_id, lue: !!r.read_at }));
}

/** Un membre (non propriétaire) marque une alerte lue POUR LUI SEUL. */
export function markAlertReadFor(ctx: Ctx, id: number, userId: string): void {
  ctx.db.prepare('INSERT OR IGNORE INTO alertes_lues (alerte_id, user_id, le) VALUES (?, ?, ?)').run(id, userId, now());
}

/** Le propriétaire marque une alerte lue pour tout le monde (elle ne part plus dans le récapitulatif). */
export function markAlertRead(ctx: Ctx, id: number | 'toutes'): void {
  if (id === 'toutes') ctx.db.prepare('UPDATE alerts SET read_at = ? WHERE read_at IS NULL').run(now());
  else ctx.db.prepare('UPDATE alerts SET read_at = ? WHERE id = ?').run(now(), id);
}

/** Récapitulatif quotidien des alertes « attention » pas encore envoyées. */
export async function sendDigest(ctx: Ctx): Promise<number> {
  if (!ctx.mailer?.configured()) return 0;
  const rows = ctx.db.prepare("SELECT id, at, message FROM alerts WHERE level = 'attention' AND emailed_at IS NULL AND read_at IS NULL ORDER BY id").all() as {
    id: number;
    at: number;
    message: string;
  }[];
  if (!rows.length) return 0;
  const text = rows.map((r) => `• ${new Date(r.at).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })} — ${r.message}`).join('\n');
  await ctx.mailer.sendAlert(`PAGINITY — ${rows.length} point(s) à vérifier`, `Récapitulatif du jour :\n\n${text}\n`);
  const upd = ctx.db.prepare('UPDATE alerts SET emailed_at = ? WHERE id = ?');
  for (const r of rows) upd.run(now(), r.id);
  return rows.length;
}

export function pruneAlerts(ctx: Ctx): void {
  ctx.db.prepare('DELETE FROM alerts WHERE at < ?').run(now() - 90 * 86_400_000);
}
