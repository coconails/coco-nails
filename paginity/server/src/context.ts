import type { Config } from './config.js';
import type { Db } from './db.js';
import type { Vault } from './lib/vault.js';
import type { JobQueue } from './jobs/queue.js';
import type { SiteService } from './sites/service.js';
import type { Events } from './lib/events.js';
import type { FunctionService } from './functions/service.js';
import type { Scheduler } from './functions/scheduler.js';
import type { Mailer } from './lib/mail.js';
import type { Assistant } from './ia/assistant.js';
import type { SauvegardeAuto } from './lib/sauvegarde-auto.js';
import type { Battement } from './lib/battement.js';
import type { MisesAJour } from './lib/mises-a-jour.js';
import type { Push } from './lib/push.js';
import type { Referencement } from './marketing/service.js';
import type { SearchConsole } from './marketing/searchconsole.js';

/** Tout ce dont les différentes parties de PAGINITY ont besoin, regroupé en un seul objet. */
export interface Ctx {
  config: Config;
  db: Db;
  vault: Vault;
  events: Events;
  jobs: JobQueue;
  sites: SiteService;
  functions: FunctionService;
  scheduler: Scheduler;
  mailer: Mailer;
  ia: Assistant;
  sauvegardeAuto: SauvegardeAuto;
  battement: Battement;
  misesAJour: MisesAJour;
  push: Push;
  referencement: Referencement;
  searchConsole: SearchConsole;
}
