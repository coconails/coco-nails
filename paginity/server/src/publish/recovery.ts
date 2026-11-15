import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../context.js';
import type { SiteRow } from '../sites/service.js';
import { audit } from '../lib/audit.js';
import { raiseAlert } from '../lib/alerts.js';
import { now } from '../lib/util.js';
import { readLink, swapSymlink } from './build.js';

/**
 * Remise en ordre au démarrage, après un arrêt brutal (coupure de courant, plantage) pendant une publication.
 *
 * Règle : seule une publication RÉUSSIE (vérifiée en ligne) peut être servie. Si la base et la version servie
 * ne sont pas d'accord, on revient à la dernière version réussie connue ; s'il n'y en a aucune, le site
 * redevient « non publié » plutôt que de servir une version jamais vérifiée.
 * Les données métier (réservations, comptabilité…) ne sont jamais concernées.
 */

function versionNumber(target: string | null): number | null {
  if (!target) return null;
  const m = /v(\d{4,})$/.exec(target.replace(/\/+$/, ''));
  return m ? Number(m[1]) : null;
}

function versionDir(ctx: Ctx, site: SiteRow, n: number): string {
  return path.join(ctx.sites.versionsDir(site), `v${String(n).padStart(4, '0')}`);
}

function isGood(ctx: Ctx, site: SiteRow, n: number | null): boolean {
  if (!n) return false;
  const r = ctx.db.prepare('SELECT status FROM publications WHERE site_id = ? AND number = ?').get(site.id, n) as { status: string } | undefined;
  return r?.status === 'reussie' && fs.existsSync(path.join(versionDir(ctx, site, n), 'index.html'));
}

export interface RecoveryReport {
  publicationsInterrompues: number;
  sitesCorriges: string[];
}

export function recoverOnStartup(ctx: Ctx): RecoveryReport {
  const report: RecoveryReport = { publicationsInterrompues: 0, sitesCorriges: [] };

  // 1. Publications restées « en cours » : interrompues (elles n'ont jamais été validées).
  const stuck = ctx.db.prepare("SELECT site_id, number FROM publications WHERE status = 'en_cours'").all() as { site_id: string; number: number }[];
  for (const p of stuck) {
    ctx.db.prepare("UPDATE publications SET status = 'interrompue', duration_ms = NULL WHERE site_id = ? AND number = ?").run(p.site_id, p.number);
    ctx.db.prepare("UPDATE sites SET last_publication_status = 'echouee' WHERE id = ?").run(p.site_id);
    const site = ctx.sites.get(p.site_id);
    raiseAlert(
      ctx,
      'attention',
      `La publication n°${p.number} de « ${site?.name ?? p.site_id} » a été interrompue par un arrêt du serveur. Relancez-la depuis l’écran Publier.`,
      p.site_id,
    );
    audit(ctx.db, { action: 'publication_interrompue', siteId: p.site_id, details: { numero: p.number } });
  }
  report.publicationsInterrompues = stuck.length;

  // 2. Accord entre la version servie (lien « en-ligne ») et la base.
  for (const site of ctx.sites.all()) {
    const dir = ctx.sites.dir(site);
    if (!fs.existsSync(dir)) continue;
    // Restes d'une bascule interrompue (liens temporaires).
    for (const f of fs.readdirSync(dir)) {
      if (/^en-ligne\.tmp-/.test(f) || /^apercu\.tmp-/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
    }
    const link = ctx.sites.liveLink(site);
    const served = versionNumber(readLink(link));
    const recorded = site.live_publication;
    const servedOk = isGood(ctx, site, served);
    const recordedOk = isGood(ctx, site, recorded);
    if (served === recorded && (servedOk || served === null)) continue;

    let keep: number | null;
    if (recordedOk) keep = recorded;
    else if (servedOk) keep = served;
    else {
      // Aucune version vérifiée disponible : dernière publication réussie encore présente, sinon aucune.
      const last = ctx.db
        .prepare("SELECT number FROM publications WHERE site_id = ? AND status = 'reussie' ORDER BY number DESC")
        .all(site.id) as { number: number }[];
      keep = last.map((r) => r.number).find((n) => isGood(ctx, site, n)) ?? null;
    }

    if (keep === null) fs.rmSync(link, { force: true });
    else if (keep !== served) swapSymlink(link, versionDir(ctx, site, keep));
    ctx.db.prepare('UPDATE sites SET live_publication = ? WHERE id = ?').run(keep, site.id);
    report.sitesCorriges.push(site.id);
    raiseAlert(
      ctx,
      'attention',
      keep === null
        ? `« ${site.name} » : aucune version vérifiée n’était disponible après l’arrêt du serveur ; le site est repassé « non publié ». Publiez-le à nouveau.`
        : `« ${site.name} » : après l’arrêt du serveur, la version n°${keep} (dernière version vérifiée) a été remise en ligne.`,
      site.id,
    );
    audit(ctx.db, { action: 'reprise_apres_arret', siteId: site.id, details: { servie: served, enregistree: recorded, retenue: keep, le: now() } });
  }
  if (report.sitesCorriges.length) ctx.sites.invalidate();
  return report;
}
