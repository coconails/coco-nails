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

export interface Paginity {
  ctx: Ctx;
  admin: FastifyInstance;
  sitesServer: http.Server;
  previewServer: http.Server;
  setupCode: string | null;
  close(): Promise<void>;
}

/** Assemble PAGINITY (sans ouvrir de port). */
export async function createPaginity(overrides: Partial<Config> = {}): Promise<Paginity> {
  const config = loadConfig(overrides);
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  // Nettoyage des fichiers temporaires laissés par un arrêt brutal.
  removeTree(path.join(config.dataDir, 'temporaire'));
  const db = openDb(config.dataDir);
  const events = new Events();
  const sites = new SiteService();
  const ctx: Ctx = { config, db, vault: new Vault(config.dataDir), events, jobs: new JobQueue(db, events, config.maxConcurrentJobs), sites };
  sites.ctx = ctx;
  defineSiteJobs(ctx);
  ctx.jobs.define('import', { steps: IMPORT_STEPS, run: (r) => runImport(ctx, r) });
  const admin = await createAdminApp(ctx);
  const sitesServer = createSitesServer(ctx);
  const previewServer = createPreviewServer(ctx);
  const setupCode = ensureSetupCode(ctx);
  const timer = setInterval(() => {
    pruneExpired(ctx);
    pruneAudit(db);
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
