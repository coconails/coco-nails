import { execFile } from 'node:child_process';
import type { Ctx } from '../context.js';
import { getSetting } from '../db.js';
import { now } from '../lib/util.js';
import type { SiteRow } from '../sites/service.js';
import { raiseAlert } from '../lib/alerts.js';
import { nextRun, parseCron, slotsBetween, type Cron } from './cron.js';
import type { FunctionInfo } from './service.js';

/**
 * Planificateur des tâches des sites (rappels, etc.), en heure UTC comme Netlify.
 *
 * Protections :
 * - un créneau ne s'exécute qu'une seule fois, même après un redémarrage (enregistrement unique en base) ;
 * - jamais deux exécutions simultanées de la même tâche ;
 * - au démarrage, PAGINITY attend que l'horloge du serveur soit synchronisée ;
 * - tâches manquées (serveur éteint) : signalées, et rattrapées seulement si vous l'avez autorisé (dans les 6 h) ;
 * - aucune nouvelle tentative automatique (un rappel SMS pourrait partir deux fois) : une alerte est créée ;
 * - désactivé par défaut pour un site importé, pour ne pas doubler un hébergement existant (Netlify).
 */

const RUN_WINDOW_MS = 2 * 60_000;
const CATCH_UP_MS = 6 * 3_600_000;

export interface ScheduledTask {
  fn: string;
  cron: Cron;
  expr: string;
}

export class Scheduler {
  private last = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<string>();
  private syncedCache: { at: number; ok: boolean } | null = null;
  clock: () => number = now;
  /** Peut être remplacé (tests) ; par défaut, interroge systemd quand il existe. */
  timeSynced: () => Promise<boolean> = () => this.checkTimeSync();

  constructor(private ctx: Ctx) {}

  start(intervalMs = 20_000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private checkTimeSync(): Promise<boolean> {
    if (process.env.PAGINITY_ATTENDRE_HORLOGE === 'non') return Promise.resolve(true);
    if (this.syncedCache && now() - this.syncedCache.at < 60_000) return Promise.resolve(this.syncedCache.ok);
    return new Promise((resolve) => {
      execFile('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], { timeout: 3000 }, (err, out) => {
        // Pas de systemd (ordinateur de développement, conteneur) : on considère l'horloge fiable.
        const ok = err ? true : out.trim() === 'yes';
        this.syncedCache = { at: now(), ok };
        resolve(ok);
      });
    });
  }

  catalog(siteId: string): FunctionInfo[] {
    const v = getSetting(this.ctx.db, `catalogue:${siteId}`);
    return v ? (JSON.parse(v) as FunctionInfo[]) : [];
  }

  tasks(siteId: string): ScheduledTask[] {
    const out: ScheduledTask[] = [];
    for (const f of this.catalog(siteId)) {
      if (!f.planification || f.erreur) continue;
      try {
        out.push({ fn: f.nom, cron: parseCron(f.planification), expr: f.planification });
      } catch {
        /* expression invalide : signalée dans l'écran des fonctions */
      }
    }
    return out;
  }

  hasSchedules(siteId: string): boolean {
    const s = this.ctx.sites.get(siteId);
    return !!s && (s as SiteRow & { schedules_enabled?: number }).schedules_enabled === 1 && this.tasks(siteId).length > 0;
  }

  settings(siteId: string, fn: string): { active: boolean; catchUp: boolean } {
    const r = this.ctx.db.prepare('SELECT active, catch_up FROM schedule_settings WHERE site_id = ? AND fn = ?').get(siteId, fn) as { active: number; catch_up: number } | undefined;
    return { active: r ? r.active === 1 : true, catchUp: r ? r.catch_up === 1 : false };
  }

  private initialLast(siteId: string, fn: string, t: number): number {
    const r = this.ctx.db.prepare('SELECT MAX(slot) AS s FROM schedule_runs WHERE site_id = ? AND fn = ? AND kind != ?').get(siteId, fn, 'manuel') as { s: number | null };
    if (r.s && t - r.s < 7 * 86_400_000) return r.s;
    return t - 60_000;
  }

  /** Un passage du planificateur (appelé toutes les 20 secondes). */
  async tick(at?: number): Promise<void> {
    const t = at ?? this.clock();
    if (!(await this.timeSynced())) return;
    const sites = this.ctx.db.prepare('SELECT * FROM sites WHERE schedules_enabled = 1 AND live_publication IS NOT NULL').all() as unknown as SiteRow[];
    for (const site of sites) {
      for (const task of this.tasks(site.id)) {
        const key = `${site.id}:${task.fn}`;
        const st = this.settings(site.id, task.fn);
        const from = this.last.get(key) ?? this.initialLast(site.id, task.fn, t);
        this.last.set(key, t);
        if (!st.active) continue;
        const slots = slotsBetween(task.cron, from, t);
        if (!slots.length) continue;
        const missed = slots.filter((s) => t - s > RUN_WINDOW_MS);
        const due = slots.filter((s) => t - s <= RUN_WINDOW_MS);
        for (const s of missed) {
          const isLatest = s === missed[missed.length - 1] && due.length === 0;
          if (st.catchUp && isLatest && t - s <= CATCH_UP_MS) {
            this.launch(site, task.fn, s, 'rattrapage');
          } else if (this.insertRun(site.id, task.fn, s, 'planifiee', 'manquee', 'Serveur indisponible à l’heure prévue.')) {
            raiseAlert(this.ctx, 'attention', `Tâche « ${task.fn} » de « ${site.name} » manquée (prévue le ${new Date(s).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}).`, site.id);
          }
        }
        for (const s of due) this.launch(site, task.fn, s, 'planifiee');
      }
    }
  }

  /** Enregistre un créneau ; renvoie faux s'il existait déjà (protection contre les doublons). */
  private insertRun(siteId: string, fn: string, slot: number, kind: string, status: string, message: string | null = null): boolean {
    const r = this.ctx.db
      .prepare('INSERT OR IGNORE INTO schedule_runs (site_id, fn, slot, kind, status, started_at, message) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(siteId, fn, slot, kind, status, now(), message);
    return r.changes === 1;
  }

  private launch(site: SiteRow, fn: string, slot: number, kind: 'planifiee' | 'rattrapage' | 'manuel'): Promise<void> | null {
    const key = `${site.id}:${fn}`;
    if (this.running.has(key)) {
      this.insertRun(site.id, fn, slot, kind, 'ignoree', 'L’exécution précédente n’était pas terminée.');
      return null;
    }
    if (!this.insertRun(site.id, fn, slot, kind, 'en_cours')) return null;
    this.running.add(key);
    return (async () => {
      let status = 'echouee';
      let message: string | null = null;
      try {
        const r = await this.ctx.functions.runScheduled(site, fn, kind === 'manuel' ? 'manuel' : 'planifiee');
        status = r.status < 400 ? 'reussie' : 'echouee';
        message = `Réponse ${r.status} en ${(r.ms / 1000).toFixed(1)} s${r.body ? ` : ${r.body.slice(0, 300)}` : ''}`;
      } catch (e) {
        message = (e as Error).message;
      } finally {
        this.running.delete(key);
        this.ctx.db.prepare('UPDATE schedule_runs SET status = ?, finished_at = ?, message = ? WHERE site_id = ? AND fn = ? AND slot = ?').run(status, now(), message, site.id, fn, slot);
        if (status !== 'reussie') {
          raiseAlert(this.ctx, 'critique', `La tâche « ${fn} » du site « ${site.name} » a échoué : ${message ?? 'erreur inconnue'}. Elle n’a pas été relancée automatiquement.`, site.id);
        }
      }
    })();
  }

  /** Lancement manuel (« Lancer maintenant »). */
  async runNow(site: SiteRow, fn: string): Promise<void> {
    if (!this.tasks(site.id).some((t) => t.fn === fn) && !this.catalog(site.id).some((f) => f.nom === fn)) throw new Error('Tâche inconnue.');
    const p = this.launch(site, fn, now(), 'manuel');
    if (!p) throw new Error('Cette tâche est déjà en cours.');
    await p;
  }

  overview(site: SiteRow) {
    const t = now();
    return this.catalog(site.id)
      .filter((f) => f.planification)
      .map((f) => {
        const st = this.settings(site.id, f.nom);
        let prochaine: number | null = null;
        let erreur = f.erreur;
        try {
          prochaine = nextRun(parseCron(f.planification!), t);
        } catch (e) {
          erreur = `Expression invalide : ${(e as Error).message}`;
        }
        const runs = this.ctx.db
          .prepare('SELECT slot, kind, status, started_at, finished_at, message FROM schedule_runs WHERE site_id = ? AND fn = ? ORDER BY slot DESC LIMIT 10')
          .all(site.id, f.nom) as { slot: number; kind: string; status: string; started_at: number; finished_at: number | null; message: string | null }[];
        return {
          fonction: f.nom,
          planification: f.planification,
          prochaine,
          prochaineParis: prochaine ? new Date(prochaine).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'full', timeStyle: 'short' }) : null,
          active: st.active,
          rattrapage: st.catchUp,
          erreur,
          executions: runs.map((r) => ({ creneau: r.slot, type: r.kind, etat: r.status, debut: r.started_at, fin: r.finished_at, message: r.message })),
        };
      });
  }
}
