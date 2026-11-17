import { SauvegardeAuto } from './lib/sauvegarde-auto.js';
import { Battement } from './lib/battement.js';
import fs from 'node:fs';
import type http from 'node:http';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from './config.js';
import { openDb } from './db.js';
import { Vault } from './lib/vault.js';
import { Events } from './lib/events.js';
import { JobQueue } from './jobs/queue.js';
import { SiteService } from './sites/service.js';
import type { Ctx } from './context.js';
import { defineSiteJobs } from './publish/pipeline.js';
import { IMPORT_STEPS, runImport } from './sites/import.js';
import { createAdminApp } from './http/app.js';
import { createPreviewServer, createSitesServer } from './servers/sites.js';
import { ensureSetupCode } from './http/routes-auth.js';
import { pruneExpired } from './auth/service.js';
import { pruneAudit } from './lib/audit.js';
import { removeTree } from './publish/build.js';
import path from 'node:path';
import { FunctionService } from './functions/service.js';
import { Isolation, detectIsolation, type IsolationOptions } from './functions/isolation.js';
import { Assistant } from './ia/assistant.js';
import { Scheduler } from './functions/scheduler.js';
import { Mailer } from './lib/mail.js';
import { pruneAlerts, sendDigest } from './lib/alerts.js';
import { pruneSubmissions } from './functions/forms.js';
import { recoverOnStartup } from './publish/recovery.js';

export interface Paginity {
  ctx: Ctx;
  admin: FastifyInstance;
  sitesServer: http.Server;
  previewServer: http.Server;
  setupCode: string | null;
  close(): Promise<void>;
}

/** Assemble PAGINITY (sans ouvrir de port). */
export async function createPaginity(
  overrides: Partial<Config> & { isolation?: 'podman' | 'processus'; scheduler?: boolean; simulation?: IsolationOptions['simulation']; cerveaux?: Assistant['cerveaux'] } = {},
): Promise<Paginity> {
  const { isolation: _i, scheduler: _s, simulation: _sim, cerveaux: _c, ...cfg } = overrides;
  const config = loadConfig(cfg);
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  // Nettoyage des fichiers temporaires laissés par un arrêt brutal.
  removeTree(path.join(config.dataDir, 'temporaire'));
  const db = openDb(config.dataDir);
  const events = new Events();
  const sites = new SiteService();
  const ctx = { config, db, vault: new Vault(config.dataDir), events, jobs: new JobQueue(db, events, config.maxConcurrentJobs), sites } as Ctx;
  sites.ctx = ctx;
  ctx.mailer = new Mailer(ctx);
  ctx.functions = new FunctionService(ctx);
  ctx.functions.isolation = new Isolation({
    mode: overrides.isolation ?? detectIsolation(process.env.PAGINITY_ISOLATION),
    image: process.env.PAGINITY_CONTAINER_IMAGE ?? 'docker.io/library/node:22-slim',
    network: process.env.PAGINITY_CONTAINER_NETWORK ?? 'slirp4netns',
    onLog: (key, line) => ctx.functions.log(key, line),
    simulation: overrides.simulation,
  });
  ctx.scheduler = new Scheduler(ctx);
  // PAGINITY AI : aucun cerveau branché par défaut (les tests en fournissent des simulés).
  ctx.ia = new Assistant(ctx);
  ctx.sauvegardeAuto = new SauvegardeAuto(ctx);
  if (overrides.cerveaux) {
    ctx.ia.cerveaux = overrides.cerveaux;
    ctx.ia.surcharge = true;
  }
  ctx.ia.reprise();
  // Remise en ordre après un éventuel arrêt brutal pendant une publication (avant d'accepter des visiteurs).
  const reprise = recoverOnStartup(ctx);
  if (reprise.publicationsInterrompues || reprise.sitesCorriges.length) {
    console.warn(`[reprise] ${reprise.publicationsInterrompues} publication(s) interrompue(s), ${reprise.sitesCorriges.length} site(s) remis en ordre.`);
  }
  if (overrides.scheduler !== false) ctx.scheduler.start();
  defineSiteJobs(ctx);
  ctx.jobs.define('import', { steps: IMPORT_STEPS, run: (r) => runImport(ctx, r) });
  const admin = await createAdminApp(ctx);
  const sitesServer = createSitesServer(ctx);
  ctx.battement = new Battement(ctx, () => sitesServer.listening);
  if (overrides.scheduler !== false) ctx.battement.demarrer();
  const previewServer = createPreviewServer(ctx);
  const setupCode = ensureSetupCode(ctx);
  let lastDigest = '';
  const timer = setInterval(() => {
    pruneExpired(ctx);
    pruneAudit(db);
    pruneAlerts(ctx);
    pruneSubmissions(ctx);
    ctx.functions.prune();
    void ctx.sauvegardeAuto.tic().catch((e) => console.error('[sauvegarde] ', (e as Error).message));
    // Récapitulatif quotidien des alertes, vers 6 h UTC.
    const d = new Date();
    const day = d.toISOString().slice(0, 10);
    if (d.getUTCHours() === 6 && lastDigest !== day) {
      lastDigest = day;
      void sendDigest(ctx).catch((e) => console.error('[récapitulatif] ', (e as Error).message));
    }
  }, 10 * 60_000);
  timer.unref();
  return {
    ctx,
    admin,
    sitesServer,
    previewServer,
    setupCode,
    async close() {
      clearInterval(timer);
      ctx.battement.arreter();
      ctx.scheduler.stop();
      await ctx.functions.stopAll();
      await admin.close();
      await new Promise((r) => sitesServer.close(() => r(null)));
      await new Promise((r) => previewServer.close(() => r(null)));
      sitesServer.closeAllConnections?.();
      previewServer.closeAllConnections?.();
      db.close();
    },
  };
}

export async function listen(p: Paginity): Promise<void> {
  const { config } = p.ctx;
  await p.admin.listen({ host: config.host, port: config.adminPort });
  await new Promise<void>((r) => p.sitesServer.listen(config.sitesPort, config.host, () => r()));
  await new Promise<void>((r) => p.previewServer.listen(config.previewPort, config.host, () => r()));
}
