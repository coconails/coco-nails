// PAGINITY — exécuteur des fonctions serveur d'UN site.
// Ce fichier tourne dans un conteneur (ou un processus restreint) qui ne voit que le code de ce site
// et ses propres secrets. Il imite l'environnement des « Netlify Functions » (version 2) :
//   export default async (req, context) => Response   +   export const config = { path, schedule }
// Aucune dépendance : seulement Node.js (Request/Response standard du web).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const APP = process.env.PAGINITY_APP_DIR || '/app';
const FN_DIR = path.join(APP, process.env.PAGINITY_FUNCTIONS_DIR || 'netlify/functions');
const SOCKET = process.env.PAGINITY_SOCKET || '/run/paginity/fonctions.sock';
const SITE_URL = process.env.URL || 'http://localhost';
const MAX_BODY = 20 * 1024 * 1024;

// Environnement « Netlify » attendu par les fonctions.
const envApi = {
  get: (k) => process.env[k],
  has: (k) => Object.prototype.hasOwnProperty.call(process.env, k),
  set: (k, v) => { process.env[k] = String(v); },
  delete: (k) => { delete process.env[k]; },
  toObject: () => ({ ...process.env }),
};
globalThis.Netlify = { env: envApi, context: null };

/** Correspondance d'adresse : exacte, avec paramètres (:nom) ou joker final (*). */
function compile(pattern) {
  const names = [];
  const re = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\*$|\*$/, '(?<splat>.*)')
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, n) => { names.push(n); return `(?<${n}>[^/]+)`; });
  return new RegExp(`^${re}/?$`);
}

const functions = [];
async function load() {
  if (!fs.existsSync(FN_DIR)) return;
  for (const entry of fs.readdirSync(FN_DIR, { withFileTypes: true })) {
    let file = null;
    let name = entry.name.replace(/\.(m?js|cjs)$/, '');
    if (entry.isFile() && /\.(mjs|js|cjs)$/.test(entry.name)) file = path.join(FN_DIR, entry.name);
    else if (entry.isDirectory()) {
      for (const cand of [`${entry.name}.mjs`, `${entry.name}.js`, 'index.mjs', 'index.js']) {
        if (fs.existsSync(path.join(FN_DIR, entry.name, cand))) { file = path.join(FN_DIR, entry.name, cand); break; }
      }
    }
    if (!file) continue;
    const f = { name, file, paths: [], schedule: null, handler: null, error: null };
    try {
      const mod = await import(pathToFileURL(file).href);
      const handler = mod.default;
      if (typeof handler !== 'function') {
        f.error = mod.handler ? 'Format Netlify « v1 » (exports.handler) non pris en charge : utilisez « export default ».' : 'Aucune fonction « export default » trouvée.';
      } else f.handler = handler;
      const cfg = mod.config || {};
      if (cfg.path) f.paths = (Array.isArray(cfg.path) ? cfg.path : [cfg.path]).filter((p) => typeof p === 'string');
      if (typeof cfg.schedule === 'string') f.schedule = cfg.schedule;
      if (!f.paths.length && !f.schedule) f.paths = [`/.netlify/functions/${name}`];
      f.matchers = f.paths.map(compile);
    } catch (e) {
      f.error = `Chargement impossible : ${e && e.message ? e.message : e}`;
    }
    functions.push(f);
  }
}

function findRoute(pathname) {
  for (const f of functions) {
    if (!f.handler) continue;
    for (const m of f.matchers || []) {
      const r = m.exec(pathname);
      if (r) return { f, params: { ...(r.groups || {}) } };
    }
  }
  return null;
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function makeContext(req, params, outCookies) {
  const cookies = parseCookies(req.headers.cookie);
  const ip = String(req.headers['x-nf-client-connection-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const waits = [];
  return {
    ctx: {
      ip,
      requestId: randomUUID(),
      params,
      geo: {},
      account: { id: 'paginity' },
      server: { region: 'paginity' },
      site: { id: process.env.SITE_ID || '', name: process.env.SITE_NAME || '', url: SITE_URL },
      deploy: { id: process.env.DEPLOY_ID || '', context: process.env.CONTEXT || 'production', published: process.env.CONTEXT !== 'deploy-preview' },
      cookies: {
        get: (n) => cookies[n],
        set: (opt, val) => {
          const o = typeof opt === 'string' ? { name: opt, value: val } : opt;
          let c = `${o.name}=${encodeURIComponent(o.value ?? '')}`;
          if (o.path) c += `; Path=${o.path}`;
          if (o.domain) c += `; Domain=${o.domain}`;
          if (o.expires) c += `; Expires=${new Date(o.expires).toUTCString()}`;
          if (o.maxAge !== undefined) c += `; Max-Age=${o.maxAge}`;
          if (o.httpOnly) c += '; HttpOnly';
          if (o.secure) c += '; Secure';
          if (o.sameSite) c += `; SameSite=${o.sameSite}`;
          outCookies.push(c);
        },
        delete: (opt) => {
          const name = typeof opt === 'string' ? opt : opt.name;
          outCookies.push(`${name}=; Path=${(typeof opt === 'object' && opt.path) || '/'}; Max-Age=0`);
        },
      },
      json: (data, init) => Response.json(data, init),
      log: (...a) => console.log(...a),
      next: async () => new Response('Introuvable', { status: 404 }),
      rewrite: async () => new Response('Non pris en charge par PAGINITY', { status: 501 }),
      waitUntil: (p) => waits.push(Promise.resolve(p).catch((e) => console.error(e))),
    },
    waits,
  };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Contenu trop volumineux'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function invoke(f, req, res, params, bodyOverride) {
  const started = Date.now();
  const proto = req.headers['x-forwarded-proto'] || new URL(SITE_URL).protocol.replace(':', '');
  const host = req.headers['x-forwarded-host'] || req.headers.host || new URL(SITE_URL).host;
  const url = `${proto}://${host}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.startsWith('x-paginity-')) continue;
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const body = bodyOverride ?? (hasBody ? await readBody(req) : undefined);
  const request = new Request(url, { method: req.method, headers, body: hasBody || bodyOverride ? body : undefined });
  const cookies = [];
  const { ctx, waits } = makeContext(req, params, cookies);
  globalThis.Netlify.context = ctx;
  let response;
  try {
    response = await f.handler(request, ctx);
  } catch (e) {
    console.error(`[${f.name}] erreur :`, e && e.stack ? e.stack : e);
    response = new Response(JSON.stringify({ erreur: 'Erreur interne de la fonction.' }), { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  if (!(response instanceof Response)) {
    if (response === undefined) response = new Response(null, { status: 204 });
    else if (typeof response === 'string') response = new Response(response);
    else response = new Response(JSON.stringify({ erreur: 'La fonction n’a pas renvoyé de réponse valide.' }), { status: 500 });
  }
  const outHeaders = {};
  response.headers.forEach((v, k) => {
    if (k === 'set-cookie') return;
    outHeaders[k] = v;
  });
  const setCookies = [...(response.headers.getSetCookie ? response.headers.getSetCookie() : []), ...cookies];
  if (setCookies.length) outHeaders['set-cookie'] = setCookies;
  outHeaders['x-paginity-fonction'] = f.name;
  outHeaders['x-paginity-duree'] = String(Date.now() - started);
  res.writeHead(response.status, outHeaders);
  if (response.body && req.method !== 'HEAD') {
    for await (const chunk of response.body) res.write(chunk);
  }
  res.end();
  await Promise.allSettled(waits);
}

await load();

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://fonctions.invalid');
    if (u.pathname === '/__paginity/routes') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ node: process.version, fonctions: functions.map((f) => ({ nom: f.name, chemins: f.paths, planification: f.schedule, erreur: f.error })) }));
      return;
    }
    const sched = /^\/__paginity\/planifiee\/([A-Za-z0-9_.-]+)$/.exec(u.pathname);
    if (sched) {
      const f = functions.find((x) => x.name === sched[1] && x.handler);
      if (!f) { res.writeHead(404).end(); return; }
      const body = Buffer.from(JSON.stringify({ next_run: u.searchParams.get('prochaine') || null }));
      req.url = `/.netlify/functions/${f.name}`;
      req.method = 'POST';
      await invoke(f, req, res, {}, body);
      return;
    }
    const route = findRoute(u.pathname);
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'x-paginity-fonction': '-' });
      res.end(JSON.stringify({ erreur: 'Aucune fonction à cette adresse.' }));
      return;
    }
    await invoke(route.f, req, res, route.params);
  } catch (e) {
    console.error('[paginity] erreur :', e && e.stack ? e.stack : e);
    if (!res.headersSent) res.writeHead(e.status || 500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ erreur: e.status === 413 ? 'Contenu trop volumineux.' : 'Erreur interne.' }));
  }
});

try { fs.rmSync(SOCKET, { force: true }); } catch {}
server.listen(SOCKET, () => {
  try { fs.chmodSync(SOCKET, 0o660); } catch {}
  console.log(`[paginity] ${functions.length} fonction(s) prête(s)`);
});
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('unhandledRejection', (e) => console.error('[paginity] promesse rejetée :', e));
