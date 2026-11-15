import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Ctx } from '../context.js';
import type { SiteRow } from '../sites/service.js';
import os from 'node:os';
import { now, randomId, UserError } from '../lib/util.js';
import { mergeEnforced, readRules } from '../servers/static.js';
import { Isolation, type RunningWorker } from './isolation.js';
import { secretValues, type SecretEnv } from './secrets.js';

/**
 * Gestion des exécuteurs de fonctions : un par site et par environnement (production, aperçu),
 * démarré à la demande, arrêté après inactivité, remplacé sans coupure à chaque publication.
 */

export const APP_DIR = '.app';

export interface FunctionInfo {
  nom: string;
  chemins: string[];
  planification: string | null;
  erreur: string | null;
}

interface WorkerEntry {
  key: string;
  siteId: string;
  env: SecretEnv;
  versionDir: string;
  worker: RunningWorker;
  functions: FunctionInfo[];
  startedAt: number;
  lastUsed: number;
}

const IDLE_MS: Record<SecretEnv, number> = { production: 60 * 60_000, test: 15 * 60_000 };

export class FunctionService {
  private workers = new Map<string, WorkerEntry>();
  private starting = new Map<string, Promise<WorkerEntry>>();
  private logs = new Map<string, string[]>();
  private timer: NodeJS.Timeout;
  isolation!: Isolation;
  /** Durée maximale d'un appel (comme Netlify : les fonctions sont prévues pour être courtes). */
  requestTimeoutMs = 30_000;

  constructor(private ctx: Ctx) {
    this.timer = setInterval(() => void this.reapIdle(), 60_000);
    this.timer.unref();
  }

  // ------------------------------------------------------------------ journaux
  private logFile(siteId: string): string | null {
    const site = this.ctx.sites.get(siteId);
    return site ? path.join(this.ctx.sites.dir(site), 'journaux', 'fonctions.log') : null;
  }

  /** Ajoute une ligne au journal du site, en masquant toute valeur de secret. */
  log(key: string, line: string): void {
    const [siteId, env] = key.split(':') as [string, SecretEnv];
    let text = line;
    try {
      for (const v of Object.values(secretValues(this.ctx, siteId, env))) {
        if (v.length >= 6) text = text.split(v).join('[secret masqué]');
      }
    } catch {
      /* site supprimé */
    }
    const stamped = `${new Date().toISOString()} [${env === 'test' ? 'aperçu' : 'production'}] ${text.slice(0, 4000)}`;
    const buf = this.logs.get(siteId) ?? [];
    buf.push(stamped);
    if (buf.length > 500) buf.splice(0, buf.length - 500);
    this.logs.set(siteId, buf);
    const f = this.logFile(siteId);
    if (!f) return;
    try {
      if (fs.existsSync(f) && fs.statSync(f).size > 5 * 1024 * 1024) fs.renameSync(f, `${f}.1`);
      fs.appendFileSync(f, stamped + '\n');
    } catch {
      /* journal indisponible */
    }
  }

  recentLogs(siteId: string, limit = 200): string[] {
    let lines = this.logs.get(siteId);
    if (!lines) {
      const f = this.logFile(siteId);
      lines = f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-500) : [];
      this.logs.set(siteId, lines);
    }
    return lines.slice(-limit);
  }

  // ------------------------------------------------------------------ démarrage / arrêt
  siteUrl(site: SiteRow): string {
    const domains = this.ctx.sites.domains(site);
    return domains.length ? `https://${domains[0]}` : this.ctx.sites.urls(site).test;
  }

  /** Démarre un exécuteur pour une version précise (sans l'activer). */
  async startFor(site: SiteRow, env: SecretEnv, versionDir: string): Promise<WorkerEntry> {
    const appDir = path.join(versionDir, APP_DIR);
    if (!fs.existsSync(appDir)) throw new UserError(404, 'Cette version ne contient pas de fonctions serveur.');
    const rules = readRules(versionDir);
    const key = `${site.id}:${env}`;
    // Les adresses de « sockets » Unix sont limitées à 108 caractères : dossier court.
    let socketDir = path.join(this.ctx.config.dataDir, 'x', randomId());
    if (socketDir.length > 80) socketDir = path.join(os.tmpdir(), `paginity-${process.getuid?.() ?? 0}`, randomId());
    const worker = await this.isolation.startWorker({
      key,
      appDir,
      functionsDir: (rules as { functionsDir?: string }).functionsDir ?? 'netlify/functions',
      socketDir,
      memoryMb: 256,
      env: {
        ...secretValues(this.ctx, site.id, env),
        URL: env === 'test' ? this.ctx.sites.urls(site).apercu : this.siteUrl(site),
        DEPLOY_URL: this.siteUrl(site),
        SITE_ID: site.id,
        SITE_NAME: site.slug,
        DEPLOY_ID: path.basename(versionDir),
        CONTEXT: env === 'test' ? 'deploy-preview' : 'production',
      },
    });
    const functions = await this.fetchRoutes(worker.socket).catch(async (e) => {
      await worker.stop();
      throw e;
    });
    const entry: WorkerEntry = { key, siteId: site.id, env, versionDir, worker, functions, startedAt: now(), lastUsed: now() };
    worker.exited.then(() => {
      if (this.workers.get(key) === entry) this.workers.delete(key);
      fs.rmSync(socketDir, { recursive: true, force: true });
    });
    return entry;
  }

  /** Remplace l'exécuteur actif par un nouveau (après une publication réussie). */
  activate(entry: WorkerEntry): void {
    const old = this.workers.get(entry.key);
    this.workers.set(entry.key, entry);
    if (old && old !== entry) void old.worker.stop();
  }

  async discard(entry: WorkerEntry): Promise<void> {
    if (this.workers.get(entry.key) !== entry) await entry.worker.stop();
  }

  /** Exécuteur prêt pour la version actuellement servie (démarré si besoin). */
  async ensure(site: SiteRow, env: SecretEnv): Promise<WorkerEntry> {
    const link = env === 'test' ? this.ctx.sites.previewLink(site) : this.ctx.sites.liveLink(site);
    let versionDir: string;
    try {
      versionDir = fs.realpathSync(link);
    } catch {
      throw new UserError(503, 'Le site n’est pas publié.');
    }
    const key = `${site.id}:${env}`;
    const cur = this.workers.get(key);
    if (cur && cur.versionDir === versionDir) {
      cur.lastUsed = now();
      return cur;
    }
    const pending = this.starting.get(key);
    if (pending) return pending;
    const p = this.startFor(site, env, versionDir)
      .then((e) => {
        this.activate(e);
        return e;
      })
      .finally(() => this.starting.delete(key));
    this.starting.set(key, p);
    return p;
  }

  async stopSite(siteId: string, env?: SecretEnv): Promise<void> {
    for (const [k, e] of this.workers) {
      if (e.siteId === siteId && (!env || e.env === env)) {
        this.workers.delete(k);
        await e.worker.stop();
      }
    }
  }

  async stopAll(): Promise<void> {
    clearInterval(this.timer);
    await Promise.all([...this.workers.values()].map((e) => e.worker.stop()));
    this.workers.clear();
  }

  private async reapIdle(): Promise<void> {
    const t = now();
    for (const [k, e] of this.workers) {
      if (t - e.lastUsed > IDLE_MS[e.env] && !this.ctx.scheduler?.hasSchedules(e.siteId)) {
        this.workers.delete(k);
        await e.worker.stop();
      }
    }
  }

  status(siteId: string) {
    return (['production', 'test'] as SecretEnv[]).map((env) => {
      const e = this.workers.get(`${siteId}:${env}`);
      return { environnement: env, actif: !!e, depuis: e?.startedAt ?? null, version: e ? path.basename(e.versionDir) : null };
    });
  }

  // ------------------------------------------------------------------ appels
  private fetchRoutes(socket: string): Promise<FunctionInfo[]> {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: socket, path: '/__paginity/routes', timeout: 10_000 }, (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (b += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(b).fonctions);
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('délai dépassé')));
      req.on('error', reject);
      req.end();
    });
  }

  /** Liste des fonctions de la version servie, sans démarrer d'exécuteur. */
  declared(versionDir: string): { functionsDir: string | null } {
    const r = readRules(versionDir) as { functionsDir?: string };
    return { functionsDir: fs.existsSync(path.join(versionDir, APP_DIR)) ? r.functionsDir ?? 'netlify/functions' : null };
  }

  hasFunctions(site: SiteRow, env: SecretEnv): boolean {
    try {
      const dir = fs.realpathSync(env === 'test' ? this.ctx.sites.previewLink(site) : this.ctx.sites.liveLink(site));
      return fs.existsSync(path.join(dir, APP_DIR));
    } catch {
      return false;
    }
  }

  record(siteId: string, fn: string, kind: 'appel' | 'planifiee' | 'manuel', status: number, durationMs: number, message?: string): void {
    this.ctx.db
      .prepare('INSERT INTO function_log (site_id, at, fn, kind, status, duration_ms, message) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(siteId, now(), fn, kind, status, durationMs, message ?? null);
  }

  /** Transmet une requête de visiteur à l'exécuteur du site et renvoie sa réponse. */
  async proxy(site: SiteRow, env: SecretEnv, req: http.IncomingMessage, res: http.ServerResponse, clientIp: string, enforced?: Record<string, string>): Promise<void> {
    let entry: WorkerEntry;
    try {
      entry = await this.ensure(site, env);
    } catch (e) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', ...enforced });
      res.end(JSON.stringify({ erreur: e instanceof UserError ? e.message : 'Fonctions indisponibles.' }));
      return;
    }
    const started = now();
    const headers = { ...req.headers, 'x-nf-client-connection-ip': clientIp, 'x-forwarded-for': clientIp };
    await new Promise<void>((resolve) => {
      const up = http.request({ socketPath: entry.worker.socket, path: req.url, method: req.method, headers, timeout: this.requestTimeoutMs }, (r) => {
        const fn = String(r.headers['x-paginity-fonction'] ?? '-');
        const h = { ...r.headers };
        delete h['x-paginity-fonction'];
        delete h['x-paginity-duree'];
        res.writeHead(r.statusCode ?? 502, mergeEnforced(h as Record<string, string | string[]>, enforced));
        r.pipe(res);
        r.on('end', () => {
          if (fn !== '-') this.record(site.id, fn, 'appel', r.statusCode ?? 0, now() - started);
          resolve();
        });
        r.on('error', () => resolve());
      });
      up.on('timeout', () => up.destroy(new Error('timeout')));
      up.on('error', (e) => {
        if (!res.headersSent) {
          const timeout = e.message === 'timeout';
          res.writeHead(timeout ? 504 : 502, { 'content-type': 'application/json; charset=utf-8', ...enforced });
          res.end(JSON.stringify({ erreur: timeout ? 'La fonction a mis trop de temps à répondre.' : 'Fonction indisponible.' }));
        } else res.destroy();
        this.record(site.id, '?', 'appel', 504, now() - started, e.message);
        resolve();
      });
      req.pipe(up);
    });
  }

  /** Exécute une fonction planifiée (ou un lancement manuel). */
  async runScheduled(site: SiteRow, fn: string, kind: 'planifiee' | 'manuel', timeoutMs = 120_000): Promise<{ status: number; body: string; ms: number }> {
    const entry = await this.ensure(site, 'production');
    const started = now();
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: entry.worker.socket, path: `/__paginity/planifiee/${encodeURIComponent(fn)}`, method: 'POST', timeout: timeoutMs }, (r) => {
        let b = '';
        r.setEncoding('utf8');
        r.on('data', (d) => (b.length < 4000 ? (b += d) : undefined));
        r.on('end', () => {
          const ms = now() - started;
          this.record(site.id, fn, kind, r.statusCode ?? 0, ms, b.slice(0, 500));
          resolve({ status: r.statusCode ?? 0, body: b, ms });
        });
      });
      req.on('timeout', () => req.destroy(new Error(`délai dépassé (${Math.round(timeoutMs / 1000)} s)`)));
      req.on('error', (e) => {
        this.record(site.id, fn, kind, 504, now() - started, e.message);
        reject(new UserError(504, `La tâche n’a pas pu s’exécuter : ${e.message}`));
      });
      req.end();
    });
  }

  stats(siteId: string) {
    const since = now() - 86_400_000;
    const rows = this.ctx.db
      .prepare(
        "SELECT fn, COUNT(*) AS appels, SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS erreurs, AVG(duration_ms) AS moyenne, MAX(at) AS dernier FROM function_log WHERE site_id = ? AND at > ? GROUP BY fn",
      )
      .all(siteId, since) as { fn: string; appels: number; erreurs: number; moyenne: number; dernier: number }[];
    return rows.map((r) => ({ fonction: r.fn, appels24h: r.appels, erreurs24h: r.erreurs, dureeMoyenneMs: Math.round(r.moyenne), dernierAppel: r.dernier }));
  }

  prune(): void {
    this.ctx.db.prepare('DELETE FROM function_log WHERE at < ?').run(now() - 30 * 86_400_000);
  }
}
