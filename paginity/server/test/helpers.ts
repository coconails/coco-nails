import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { TOTP, Secret } from 'otpauth';
import { createPaginity, type Paginity } from '../src/main.js';

export interface Client {
  cookies: Map<string, string>;
  csrf: string;
  call(method: string, url: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any; headers: Record<string, any>; body: string; raw: Buffer }>;
}

export async function startPaginity(
  opts: { isolation?: 'podman' | 'processus'; dataDir?: string; simulation?: { preload: string; dir: string; env: Record<string, string> } } = {},
): Promise<Paginity & { dir: string }> {
  // dataDir : redémarrer PAGINITY sur des données existantes (simulation d'une coupure).
  const dir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'paginity-test-'));
  const p = await createPaginity({
    isolation: opts.isolation ?? 'processus',
    scheduler: false,
    dataDir: dir,
    publicUrl: 'http://localhost:8080',
    rpId: 'localhost',
    sitesBaseDomain: 'localhost',
    previewBaseDomain: 'localhost',
    webDir: path.join(dir, 'pas-de-web'),
    simulation: opts.simulation,
  });
  await new Promise<void>((r) => p.sitesServer.listen(0, '127.0.0.1', () => r()));
  await new Promise<void>((r) => p.previewServer.listen(0, '127.0.0.1', () => r()));
  p.ctx.config.sitesPort = (p.sitesServer.address() as AddressInfo).port;
  p.ctx.config.previewPort = (p.previewServer.address() as AddressInfo).port;
  return Object.assign(p, { dir });
}

export async function stopPaginity(p: Paginity & { dir: string }): Promise<void> {
  await p.close();
  fs.rmSync(p.dir, { recursive: true, force: true });
}

/** remoteAddress : adresse IP simulée de l'appareil (par défaut 127.0.0.1). */
export function client(p: Paginity, opts: { remoteAddress?: string } = {}): Client {
  const c: Client = {
    cookies: new Map(),
    csrf: '',
    async call(method, url, payload, headers = {}) {
      const cookie = [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      const isBuffer = Buffer.isBuffer(payload);
      const res = await p.admin.inject({
        method: method as any,
        url,
        payload: payload === undefined ? undefined : isBuffer ? payload : (payload as any),
        headers: { cookie, 'x-csrf-token': c.csrf, origin: 'http://localhost:8080', ...headers },
        ...(opts.remoteAddress ? { remoteAddress: opts.remoteAddress } : {}),
      });
      const set = res.headers['set-cookie'];
      for (const sc of Array.isArray(set) ? set : set ? [set] : []) {
        const [kv] = String(sc).split(';');
        const [k, v] = kv.split('=');
        if (v === '' || /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(String(sc))) c.cookies.delete(k);
        else c.cookies.set(k, v);
      }
      let json: any = null;
      try {
        json = JSON.parse(res.body);
      } catch {
        /* pas du JSON */
      }
      return { status: res.statusCode, json, headers: res.headers, body: res.body, raw: res.rawPayload };
    },
  };
  return c;
}

export function totpCode(secret: string, offsetSteps = 0): string {
  return new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' }).generate({ timestamp: Date.now() + offsetSteps * 30_000 });
}

/** Installe le propriétaire et active ses codes à 6 chiffres. Renvoie le client connecté et le secret. */
export async function setupOwner(p: Paginity, email = 'proprio@exemple.fr', password = 'une phrase de passe solide'): Promise<{ c: Client; secret: string; codes: string[] }> {
  const c = client(p);
  const etat = await c.call('GET', '/api/etat');
  c.csrf = etat.json.csrf;
  const inst = await c.call('POST', '/api/installation', { code: p.setupCode, nom: 'Propriétaire', email, motDePasse: password });
  if (inst.status !== 200) throw new Error(`installation : ${inst.body}`);
  const debut = await c.call('POST', '/api/profil/2fa/totp/debut', {});
  const conf = await c.call('POST', '/api/profil/2fa/totp/confirmer', { code: totpCode(debut.json.secret) });
  if (conf.status !== 200) throw new Error(`totp : ${conf.body}`);
  return { c, secret: debut.json.secret, codes: conf.json.codesSecours };
}

export async function waitJob(p: Paginity, id: string) {
  return p.ctx.jobs.wait(id);
}

export function getSite(
  p: Paginity,
  host: string,
  urlPath = '/',
  opts: { port?: number; cookie?: string } = {},
): Promise<{ status: number; body: string; headers: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: opts.port ?? p.ctx.config.sitesPort, path: urlPath, headers: { host, ...(opts.cookie ? { cookie: opts.cookie } : {}) } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on('error', reject);
  });
}
