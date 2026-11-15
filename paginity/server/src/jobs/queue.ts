import type { Db } from '../db.js';
import type { Events } from '../lib/events.js';
import { now, randomId, UserError } from '../lib/util.js';

/**
 * Centre d'activités : toutes les opérations longues (publication, import, restauration, aperçu…)
 * sont exécutées par le serveur, enregistrées dans la base, et continuent même si le navigateur est fermé.
 * Après un redémarrage, une opération qui était en cours est marquée « interrompue » (jamais reprise à moitié).
 */

export type JobStatus = 'en_attente' | 'en_cours' | 'reussie' | 'echouee' | 'interrompue';
export type StepStatus = 'a_faire' | 'en_cours' | 'reussi' | 'echoue' | 'ignore';

export interface Step {
  nom: string;
  etat: StepStatus;
  message?: string;
  debut?: number;
  fin?: number;
}

export interface JobRow {
  id: string;
  type: string;
  label: string;
  site_id: string | null;
  user_id: string | null;
  status: JobStatus;
  steps: string;
  payload: string;
  result: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface PublicJob {
  id: string;
  type: string;
  libelle: string;
  siteId: string | null;
  utilisateur: string | null;
  etat: JobStatus;
  etapes: Step[];
  resultat: unknown;
  erreur: string | null;
  creeLe: number;
  debutLe: number | null;
  finLe: number | null;
}

export interface JobRun {
  id: string;
  payload: Record<string, unknown>;
  userId: string | null;
  siteId: string | null;
  /** Exécute une étape nommée ; son état est mis à jour et diffusé en direct. */
  step<T>(name: string, fn: () => Promise<T>, message?: (r: T) => string | undefined): Promise<T>;
  skip(name: string, message: string): void;
  note(name: string, message: string): void;
}

export interface JobDefinition {
  steps: string[];
  run: (job: JobRun) => Promise<unknown>;
}

export class JobQueue {
  private defs = new Map<string, JobDefinition>();
  private running = new Set<string>();
  private runningSites = new Set<string>();
  private waiting: string[] = [];
  private waiters = new Map<string, ((j: PublicJob) => void)[]>();

  constructor(private db: Db, private events: Events, private maxConcurrent: number) {
    // Toute opération restée « en cours » ou « en attente » lors d'un arrêt est marquée interrompue.
    db.prepare(
      "UPDATE jobs SET status = 'interrompue', finished_at = ?, error = COALESCE(error, 'Opération interrompue par un redémarrage du serveur. Elle peut être relancée.') WHERE status IN ('en_attente', 'en_cours')",
    ).run(now());
  }

  define(type: string, def: JobDefinition): void {
    this.defs.set(type, def);
  }

  enqueue(input: { type: string; label: string; siteId?: string | null; userId?: string | null; payload?: Record<string, unknown> }): PublicJob {
    const def = this.defs.get(input.type);
    if (!def) throw new Error(`Type d'activité inconnu : ${input.type}`);
    const id = randomId('a');
    const steps: Step[] = def.steps.map((nom) => ({ nom, etat: 'a_faire' }));
    this.db
      .prepare('INSERT INTO jobs (id, type, label, site_id, user_id, status, steps, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.type, input.label, input.siteId ?? null, input.userId ?? null, 'en_attente', JSON.stringify(steps), JSON.stringify(input.payload ?? {}), now());
    this.waiting.push(id);
    this.emit(id);
    setImmediate(() => this.pump());
    return this.get(id)!;
  }

  hasActive(siteId: string, type?: string): boolean {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE site_id = ? AND status IN ('en_attente','en_cours')${type ? ' AND type = ?' : ''}`)
      .get(...(type ? [siteId, type] : [siteId])) as { n: number };
    return r.n > 0;
  }

  get(id: string): PublicJob | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? this.toPublic(row) : null;
  }

  list(opts: { siteIds?: string[] | null; limit?: number } = {}): PublicJob[] {
    const limit = Math.min(opts.limit ?? 50, 200);
    let rows: JobRow[];
    if (opts.siteIds === null || opts.siteIds === undefined) {
      rows = this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as JobRow[];
    } else if (opts.siteIds.length === 0) {
      rows = [];
    } else {
      const ph = opts.siteIds.map(() => '?').join(',');
      rows = this.db.prepare(`SELECT * FROM jobs WHERE site_id IN (${ph}) ORDER BY created_at DESC LIMIT ?`).all(...opts.siteIds, limit) as unknown as JobRow[];
    }
    return rows.map((r) => this.toPublic(r));
  }

  /** Attend la fin d'une activité (utilisé par les tests et certaines opérations internes). */
  wait(id: string): Promise<PublicJob> {
    const j = this.get(id);
    if (j && ['reussie', 'echouee', 'interrompue'].includes(j.etat)) return Promise.resolve(j);
    return new Promise((resolve) => {
      const list = this.waiters.get(id) ?? [];
      list.push(resolve);
      this.waiters.set(id, list);
    });
  }

  private toPublic(row: JobRow): PublicJob {
    const user = row.user_id ? (this.db.prepare('SELECT name FROM users WHERE id = ?').get(row.user_id) as { name: string } | undefined) : undefined;
    return {
      id: row.id,
      type: row.type,
      libelle: row.label,
      siteId: row.site_id,
      utilisateur: user?.name ?? null,
      etat: row.status,
      etapes: JSON.parse(row.steps),
      resultat: row.result ? JSON.parse(row.result) : null,
      erreur: row.error,
      creeLe: row.created_at,
      debutLe: row.started_at,
      finLe: row.finished_at,
    };
  }

  private emit(id: string): void {
    const j = this.get(id);
    if (j) this.events.publish({ type: 'activite', siteId: j.siteId, data: j });
  }

  private pump(): void {
    if (this.running.size >= this.maxConcurrent) return;
    for (let i = 0; i < this.waiting.length; i++) {
      const id = this.waiting[i];
      const row = this.db.prepare('SELECT site_id, status FROM jobs WHERE id = ?').get(id) as { site_id: string | null; status: string } | undefined;
      if (!row || row.status !== 'en_attente') {
        this.waiting.splice(i, 1);
        i--;
        continue;
      }
      // Une seule opération à la fois par site.
      if (row.site_id && this.runningSites.has(row.site_id)) continue;
      this.waiting.splice(i, 1);
      this.start(id, row.site_id);
      if (this.running.size >= this.maxConcurrent) return;
      i--;
    }
  }

  private start(id: string, siteId: string | null): void {
    this.running.add(id);
    if (siteId) this.runningSites.add(siteId);
    void this.execute(id).finally(() => {
      this.running.delete(id);
      if (siteId) this.runningSites.delete(siteId);
      const j = this.get(id);
      if (j) for (const w of this.waiters.get(id) ?? []) w(j);
      this.waiters.delete(id);
      setImmediate(() => this.pump());
    });
  }

  private async execute(id: string): Promise<void> {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow;
    const def = this.defs.get(row.type)!;
    const steps: Step[] = JSON.parse(row.steps);
    const save = () => {
      this.db.prepare('UPDATE jobs SET steps = ? WHERE id = ?').run(JSON.stringify(steps), id);
      this.emit(id);
    };
    const find = (name: string) => {
      let s = steps.find((x) => x.nom === name);
      if (!s) {
        s = { nom: name, etat: 'a_faire' };
        steps.push(s);
      }
      return s;
    };
    this.db.prepare("UPDATE jobs SET status = 'en_cours', started_at = ? WHERE id = ?").run(now(), id);
    this.emit(id);
    const run: JobRun = {
      id,
      payload: JSON.parse(row.payload),
      userId: row.user_id,
      siteId: row.site_id,
      step: async (name, fn, message) => {
        const s = find(name);
        s.etat = 'en_cours';
        s.debut = now();
        save();
        try {
          const r = await fn();
          s.etat = 'reussi';
          s.fin = now();
          const m = message?.(r);
          if (m) s.message = m;
          save();
          return r;
        } catch (e) {
          s.etat = 'echoue';
          s.fin = now();
          s.message = e instanceof UserError ? e.message : `Erreur inattendue : ${(e as Error).message}`;
          save();
          throw e;
        }
      },
      skip: (name, message) => {
        const s = find(name);
        s.etat = 'ignore';
        s.message = message;
        save();
      },
      note: (name, message) => {
        const s = find(name);
        s.message = message;
        save();
      },
    };
    try {
      const result = await def.run(run);
      for (const s of steps) if (s.etat === 'a_faire') s.etat = 'ignore';
      this.db
        .prepare("UPDATE jobs SET status = 'reussie', finished_at = ?, result = ?, steps = ? WHERE id = ?")
        .run(now(), JSON.stringify(result ?? null), JSON.stringify(steps), id);
    } catch (e) {
      const msg = e instanceof UserError ? e.message : `Erreur inattendue : ${(e as Error).message}`;
      if (!(e instanceof UserError)) console.error(`[activité ${id}]`, e);
      this.db.prepare("UPDATE jobs SET status = 'echouee', finished_at = ?, error = ?, steps = ? WHERE id = ?").run(now(), msg, JSON.stringify(steps), id);
    }
    this.emit(id);
  }
}
