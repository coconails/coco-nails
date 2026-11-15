import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HeaderRule, Redirect } from '../sites/manifest.js';

/**
 * Service des fichiers d'une version publiée (ou d'un aperçu).
 * Les fichiers commençant par « . » ne sont jamais servis. Redirections et en-têtes au format Netlify (cas courants).
 */

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8', webmanifest: 'application/manifest+json; charset=utf-8',
  txt: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', pdf: 'application/pdf',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg',
  ics: 'text/calendar; charset=utf-8', csv: 'text/csv; charset=utf-8', map: 'application/json; charset=utf-8',
};

export interface VersionRules {
  version: string;
  redirects: Redirect[];
  headers: HeaderRule[];
  forms?: { nom: string; piege: string | null; champs: string[] }[];
  functionsDir?: string | null;
}

export const RULES_FILE = '.paginity.json';

const rulesCache = new Map<string, VersionRules>();

export function readRules(root: string): VersionRules {
  const cached = rulesCache.get(root);
  if (cached) return cached;
  let r: VersionRules = { version: '', redirects: [], headers: [] };
  try {
    r = { ...r, ...JSON.parse(fs.readFileSync(path.join(root, RULES_FILE), 'utf8')) };
  } catch {
    /* pas de règles */
  }
  if (rulesCache.size > 500) rulesCache.clear();
  rulesCache.set(root, r);
  return r;
}

function globToRegex(glob: string): RegExp {
  const esc = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${esc}$`);
}

function matchRedirect(rules: Redirect[], pathname: string): { to: string; status: number } | null {
  for (const r of rules) {
    if (r.from.endsWith('/*')) {
      const base = r.from.slice(0, -2);
      if (pathname === base || pathname.startsWith(`${base}/`)) {
        const splat = pathname.slice(base.length + 1);
        return { to: r.to.replace(':splat', splat), status: r.status };
      }
    } else if (r.from === pathname || r.from === pathname.replace(/\/$/, '')) {
      return { to: r.to, status: r.status };
    }
  }
  return null;
}

const SAFE_HEADER = /^[A-Za-z0-9-]{1,64}$/;

type Headers = Record<string, string | string[]>;

export interface ServeOptions {
  extraHeaders?: Record<string, string>;
  /**
   * En-têtes imposés par PAGINITY, que les réglages du site ne peuvent pas remplacer (aperçus).
   * Une politique de sécurité (CSP) du site est gardée en plus de la nôtre : le navigateur applique les deux.
   */
  enforcedHeaders?: Record<string, string>;
  /** Réponse pour les appels de fonctions serveur (non disponibles en phase 2). */
  functionsMessage: string;
}

export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse, opts: ServeOptions): void {
  const rules = readRules(root);
  const baseHeaders: Headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Paginity-Version': rules.version,
    ...opts.extraHeaders,
    ...opts.enforcedHeaders,
  };
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://site.invalid');
  } catch {
    res.writeHead(400, baseHeaders).end('Adresse invalide');
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, baseHeaders).end('Adresse invalide');
    return;
  }

  if (pathname.startsWith('/.netlify/functions/') || pathname.startsWith('/api/')) {
    res.writeHead(503, { ...baseHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ erreur: opts.functionsMessage }));
    return;
  }

  const redirect = matchRedirect(rules.redirects, pathname);
  if (redirect && [301, 302, 303, 307, 308].includes(redirect.status)) {
    res.writeHead(redirect.status, { ...baseHeaders, Location: redirect.to + (redirect.to.includes('?') || !url.search ? '' : url.search) });
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...baseHeaders, Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Méthode non autorisée. (Les formulaires Netlify seront pris en charge par un module PAGINITY à partir de la phase 3.)');
    return;
  }

  const segments = pathname.split('/').filter(Boolean);
  if (segments.some((s) => s === '..' || (s.startsWith('.') && s !== '.well-known') || s.includes('\0'))) {
    return notFound(root, res, baseHeaders, req.method === 'HEAD');
  }
  let file = path.join(root, ...segments);
  if (!file.startsWith(root)) return notFound(root, res, baseHeaders, req.method === 'HEAD');
  try {
    let st = fs.statSync(file, { throwIfNoEntry: false });
    if (st?.isDirectory()) {
      if (!pathname.endsWith('/')) {
        res.writeHead(301, { ...baseHeaders, Location: `${url.pathname}/${url.search}` });
        res.end();
        return;
      }
      file = path.join(file, 'index.html');
      st = fs.statSync(file, { throwIfNoEntry: false });
    } else if (!st && !path.extname(file)) {
      const withHtml = `${file}.html`;
      const s2 = fs.statSync(withHtml, { throwIfNoEntry: false });
      if (s2?.isFile()) {
        file = withHtml;
        st = s2;
      }
    }
    if (!st || !st.isFile() || fs.lstatSync(file).isSymbolicLink()) return notFound(root, res, baseHeaders, req.method === 'HEAD');
    sendFile(file, st, req, res, mergeEnforced({ ...baseHeaders, ...headersFor(rules.headers, pathname) }, opts.enforcedHeaders));
  } catch {
    notFound(root, res, baseHeaders, req.method === 'HEAD');
  }
}

/** Remet par-dessus les en-têtes imposés ; une CSP du site est conservée à côté de la nôtre (les deux s'appliquent). */
export function mergeEnforced(h: Headers, enforced: Record<string, string> | undefined): Headers {
  if (!enforced) return h;
  const imposed = new Set(Object.keys(enforced).map((k) => k.toLowerCase()));
  const out: Headers = {};
  const siteCsp: string[] = [];
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (!imposed.has(lk)) out[k] = v;
    else if (lk === 'content-security-policy') for (const x of [v].flat()) if (!Object.values(enforced).includes(x)) siteCsp.push(x);
  }
  for (const [k, v] of Object.entries(enforced)) out[k] = k.toLowerCase() === 'content-security-policy' && siteCsp.length ? [...siteCsp, v] : v;
  return out;
}

function headersFor(rules: HeaderRule[], pathname: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rules) {
    if (!globToRegex(r.for).test(pathname)) continue;
    for (const [k, v] of Object.entries(r.values)) if (SAFE_HEADER.test(k) && !/[\r\n]/.test(v)) out[k] = v;
  }
  return out;
}

function sendFile(file: string, st: fs.Stats, req: IncomingMessage, res: ServerResponse, headers: Headers, status = 200): void {
  const ext = path.extname(file).slice(1).toLowerCase();
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const isHtml = ext === 'html' || ext === 'htm';
  const h: Headers = {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': String(st.size),
    'Cache-Control': isHtml || ext === 'json' ? 'no-cache' : 'public, max-age=3600',
    ETag: etag,
    ...headers,
  };
  if (status === 200 && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': h['Cache-Control'] });
    res.end();
    return;
  }
  res.writeHead(status, h);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

function notFound(root: string, res: ServerResponse, headers: Headers, head: boolean): void {
  const page = path.join(root, '404.html');
  const st = fs.statSync(page, { throwIfNoEntry: false });
  if (st?.isFile()) {
    res.writeHead(404, { ...headers, 'Content-Type': TYPES.html, 'Cache-Control': 'no-cache', 'Content-Length': String(st.size) });
    if (head) res.end();
    else fs.createReadStream(page).pipe(res);
    return;
  }
  res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(head ? undefined : 'Page introuvable');
}

export function simplePage(res: ServerResponse, status: number, title: string, text: string): void {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  res.end(
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
      `<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0b1626;color:#e6eaf0}main{max-width:32rem;padding:1rem;text-align:center}h1{color:#e8a93a}</style>` +
      `</head><body><main><h1>${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`,
  );
}
