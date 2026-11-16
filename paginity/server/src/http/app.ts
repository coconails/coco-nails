import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { Ctx } from '../context.js';
import { adminOrigin, previewOriginPattern } from '../config.js';
import { loadSession } from '../auth/service.js';
import { timingSafeEqualStr, UserError } from '../lib/util.js';
import { CSRF_COOKIE, SESSION_COOKIE } from './helpers.js';
import { registerAuthRoutes } from './routes-auth.js';
import { registerSiteRoutes } from './routes-sites.js';
import { registerSystemRoutes } from './routes-system.js';
import { registerFunctionRoutes } from './routes-functions.js';
import { registerIaRoutes } from './routes-ia.js';

/** Serveur de l'administration : interface web + API, avec les protections communes à toutes les requêtes. */
export async function createAdminApp(ctx: Ctx, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ? { level: 'warn' } : false,
    bodyLimit: 3 * 1024 * 1024,
    // L'adresse IP réelle derrière le tunnel est lue par lib/ip.ts (seulement pour une connexion locale).
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024, files: 1, fields: 10 } });

  app.decorateRequest('auth', null);

  const origin = adminOrigin(ctx.config);
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    `frame-src ${previewOriginPattern(ctx.config)}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');

  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    if (ctx.config.secureCookies) reply.header('Strict-Transport-Security', 'max-age=31536000');
    if (req.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      // Protection contre la falsification de requêtes : origine vérifiée + jeton.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const o = req.headers.origin;
        if (o && o !== origin) throw new UserError(403, 'Requête refusée (origine inattendue).');
        if (req.headers['sec-fetch-site'] === 'cross-site') throw new UserError(403, 'Requête refusée (autre site).');
        const header = req.headers['x-csrf-token'];
        const cookieVal = req.cookies[CSRF_COOKIE];
        if (typeof header !== 'string' || !cookieVal || !timingSafeEqualStr(header, cookieVal)) {
          throw new UserError(403, 'Jeton de sécurité manquant ou expiré. Rechargez la page.');
        }
      }
      req.auth = loadSession(ctx, req.cookies[SESSION_COOKIE]);
    } else {
      reply.header('Content-Security-Policy', csp);
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof UserError) {
      return reply.status(err.status).send({ erreur: err.message, details: err.details ?? null });
    }
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.code === 'FST_REQ_FILE_TOO_LARGE' || e.statusCode === 413) return reply.status(413).send({ erreur: 'Fichier ou contenu trop volumineux.' });
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) return reply.status(e.statusCode).send({ erreur: 'Requête invalide.' });
    req.log.error(err);
    console.error('[erreur]', err);
    return reply.status(500).send({ erreur: 'Erreur interne du serveur. Le détail a été enregistré dans le journal.' });
  });

  registerAuthRoutes(app, ctx);
  registerSiteRoutes(app, ctx);
  registerSystemRoutes(app, ctx);
  registerFunctionRoutes(app, ctx);
  registerIaRoutes(app, ctx);

  // Interface web (déjà fabriquée dans web/dist).
  const hasWeb = fs.existsSync(path.join(ctx.config.webDir, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, { root: ctx.config.webDir, wildcard: false, index: false, maxAge: '1h', immutable: false });
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.status(404).send({ erreur: 'Adresse inconnue.' });
    if (!hasWeb) return reply.status(503).type('text/plain; charset=utf-8').send("L'interface n'est pas encore fabriquée : lancez « npm run build ».");
    reply.header('Cache-Control', 'no-cache');
    return reply.type('text/html; charset=utf-8').send(fs.readFileSync(path.join(ctx.config.webDir, 'index.html')));
  });

  return app;
}
