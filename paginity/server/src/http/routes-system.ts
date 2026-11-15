import fs from 'node:fs';
import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';
import type { PaginityEvent } from '../lib/events.js';
import type { PublicJob } from '../jobs/queue.js';
import { now, UserError } from '../lib/util.js';
import { requireOwner, requireUser } from './helpers.js';
import { listAlerts } from '../lib/alerts.js';

export const VERSION = '0.3.0';

function readTemperature(): number | null {
  for (const p of ['/sys/class/thermal/thermal_zone0/temp']) {
    try {
      const v = Number(fs.readFileSync(p, 'utf8').trim());
      if (Number.isFinite(v) && v > 0) return Math.round(v / 100) / 10;
    } catch {
      /* pas de capteur (ordinateur ordinaire, conteneur) */
    }
  }
  return null;
}

export interface Alert {
  id?: number;
  niveau: 'information' | 'attention' | 'critique';
  message: string;
  siteId?: string | null;
}

export function serverHealth(ctx: Ctx) {
  let disque: { total: number; libre: number; utilisePct: number } | null = null;
  try {
    const s = fs.statfsSync(ctx.config.dataDir);
    const total = s.blocks * s.bsize;
    const libre = s.bavail * s.bsize;
    disque = { total, libre, utilisePct: total ? Math.round(((total - libre) / total) * 1000) / 10 : 0 };
  } catch {
    disque = null;
  }
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  return {
    version: VERSION,
    node: process.version,
    systeme: `${os.type()} ${os.release()} (${os.arch()})`,
    machine: os.hostname(),
    demarreDepuis: Math.round(process.uptime()),
    systemeDemarreDepuis: Math.round(os.uptime()),
    processeurs: os.cpus().length,
    charge: os.loadavg().map((x) => Math.round(x * 100) / 100),
    memoire: { total: memTotal, libre: memFree, utilisePct: Math.round(((memTotal - memFree) / memTotal) * 1000) / 10, paginity: process.memoryUsage().rss },
    temperature: readTemperature(),
    disque,
    isolation: ctx.functions.isolation.mode,
    messagerie: ctx.mailer.configured(),
    sauvegardes: { configurees: false, message: 'Les sauvegardes automatiques hors du serveur seront mises en place à l’installation définitive (phase 4).' },
  };
}

export function computeAlerts(ctx: Ctx, health: ReturnType<typeof serverHealth> | null, siteIds: string[] | null): Alert[] {
  const alerts: Alert[] = [];
  if (health) {
    if (health.disque && health.disque.utilisePct >= 90) alerts.push({ niveau: 'critique', message: `Disque presque plein (${health.disque.utilisePct} %).` });
    else if (health.disque && health.disque.utilisePct >= 80) alerts.push({ niveau: 'attention', message: `Disque rempli à ${health.disque.utilisePct} %.` });
    if (health.temperature !== null && health.temperature >= 80) alerts.push({ niveau: 'critique', message: `Température élevée : ${health.temperature} °C.` });
    else if (health.temperature !== null && health.temperature >= 75) alerts.push({ niveau: 'attention', message: `Température à surveiller : ${health.temperature} °C.` });
    if (!health.sauvegardes.configurees) alerts.push({ niveau: 'information', message: 'Sauvegardes automatiques pas encore configurées (prévu en phase 4).' });
    if (!health.messagerie) alerts.push({ niveau: 'information', message: 'L’envoi d’e-mails (alertes, messages des formulaires) n’est pas configuré : Réglages de la plateforme.' });
    if (health.isolation === 'processus') alerts.push({ niveau: 'information', message: 'Podman n’est pas installé : les fonctions des sites tournent dans des processus restreints (isolation plus faible).' });
  }
  for (const a of listAlerts(ctx, siteIds)) alerts.push({ id: a.id, niveau: a.niveau, message: a.message, siteId: a.siteId });
  const sites = ctx.sites.all().filter((s) => siteIds === null || siteIds.includes(s.id));
  for (const s of sites) {
    if (s.last_publication_status === 'echouee') {
      alerts.push({
        niveau: 'attention',
        siteId: s.id,
        message: `La dernière publication de « ${s.name} » a échoué${s.live_publication ? ` ; la version n°${s.live_publication} reste en ligne` : ''}.`,
      });
    }
  }
  return alerts;
}

export function registerSystemRoutes(app: FastifyInstance, ctx: Ctx): void {
  const visibleSiteIds = (user: { is_owner: number; id: string }): string[] | null =>
    user.is_owner ? null : ctx.sites.accessibleSites(user as never).map((s) => s.id);

  app.get('/api/tableau-de-bord', async (req) => {
    const { user } = requireUser(req);
    const ids = visibleSiteIds(user);
    const health = user.is_owner ? serverHealth(ctx) : null;
    return {
      sites: await Promise.all(ctx.sites.accessibleSites(user).map((s) => ctx.sites.summary(s, ctx.sites.role(user, s.id)!))),
      serveur: health,
      alertes: computeAlerts(ctx, health, ids),
      activites: ctx.jobs.list({ siteIds: ids, limit: 5 }),
    };
  });

  app.get('/api/sante', async (req) => {
    requireOwner(req);
    const h = serverHealth(ctx);
    return { ...h, alertes: computeAlerts(ctx, h, null) };
  });

  app.get('/api/activites', async (req) => {
    const { user } = requireUser(req);
    return ctx.jobs.list({ siteIds: visibleSiteIds(user), limit: 100 });
  });

  app.get('/api/activites/:id', async (req) => {
    const { user } = requireUser(req);
    const j = ctx.jobs.get((req.params as { id: string }).id);
    const ids = visibleSiteIds(user);
    if (!j || (ids !== null && !(j.siteId ? ids.includes(j.siteId) : j.utilisateur === user.name))) throw new UserError(404, 'Activité introuvable.');
    return j;
  });

  // Flux en direct (Server-Sent Events) : progression des activités.
  app.get('/api/activites/flux', (req, reply) => {
    const { user } = requireUser(req);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);
    const ids = visibleSiteIds(user);
    const onEvent = (e: PaginityEvent) => {
      if (e.type !== 'activite') return;
      const j = e.data as PublicJob;
      if (ids !== null && !(j.siteId && ids.includes(j.siteId)) && j.utilisateur !== user.name) return;
      res.write(`event: activite\ndata: ${JSON.stringify(j)}\n\n`);
    };
    ctx.events.on('event', onEvent);
    const ping = setInterval(() => res.write(`: ${now()}\n\n`), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      ctx.events.off('event', onEvent);
    });
  });

  app.get('/api/journal', async (req) => {
    requireOwner(req);
    const q = req.query as { site?: string; limite?: string };
    const limit = Math.min(Number(q.limite) || 200, 1000);
    const rows = (q.site
      ? ctx.db.prepare('SELECT a.*, u.name AS user_name FROM audit a LEFT JOIN users u ON u.id = a.user_id WHERE a.site_id = ? ORDER BY a.id DESC LIMIT ?').all(q.site, limit)
      : ctx.db.prepare('SELECT a.*, u.name AS user_name FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT ?').all(limit)) as {
      id: number;
      at: number;
      user_name: string | null;
      ip: string | null;
      action: string;
      site_id: string | null;
      details: string;
    }[];
    const names = new Map(ctx.sites.all().map((s) => [s.id, s.name]));
    return rows.map((r) => ({ id: r.id, le: r.at, utilisateur: r.user_name, ip: r.ip, action: r.action, site: r.site_id ? names.get(r.site_id) ?? r.site_id : null, details: JSON.parse(r.details) }));
  });
}
