import type { Config } from './config.js';
import type { Db } from './db.js';
import type { Vault } from './lib/vault.js';
import type { JobQueue } from './jobs/queue.js';
import type { SiteService } from './sites/service.js';
import type { Events } from './lib/events.js';

/** Tout ce dont les différentes parties de PAGINITY ont besoin, regroupé en un seul objet. */
export interface Ctx {
  config: Config;
  db: Db;
  vault: Vault;
  events: Events;
  jobs: JobQueue;
  sites: SiteService;
}
