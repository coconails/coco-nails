import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../context.js';
import type { SiteRow } from '../sites/service.js';
import { now, UserError } from '../lib/util.js';

/**
 * Coffre à secrets des sites : clés d'API, mots de passe… chiffrés (AES-256-GCM).
 * Deux jeux par site : « production » (site en ligne) et « test » (aperçus, D11).
 * Les valeurs ne sont jamais renvoyées à l'interface, ni écrites dans l'historique, les journaux ou les exports.
 */

export type SecretEnv = 'production' | 'test';
export const RESERVED = new Set(['URL', 'DEPLOY_URL', 'DEPLOY_PRIME_URL', 'SITE_ID', 'SITE_NAME', 'CONTEXT', 'DEPLOY_ID', 'NODE_ENV', 'TZ', 'PATH', 'HOME', 'LANG', 'NETLIFY', 'NODE_OPTIONS']);
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function isSecretEnv(v: unknown): v is SecretEnv {
  return v === 'production' || v === 'test';
}

/** Noms de variables utilisés par le code des fonctions (process.env.X, Netlify.env.get("X")). */
export function detectNames(repoDir: string, publishDir: string): string[] {
  const names = new Set<string>();
  const skip = new Set(['node_modules', '.git', publishDir === '.' ? '' : publishDir]);
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || !fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name) && depth === 0) continue;
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(mjs|cjs|js|ts)$/.test(e.name) && fs.statSync(p).size < 1_000_000) {
        const t = fs.readFileSync(p, 'utf8');
        for (const m of t.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]);
        for (const m of t.matchAll(/process\.env\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g)) names.add(m[1]);
        for (const m of t.matchAll(/Netlify\.env\.get\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\)/g)) names.add(m[1]);
      }
    }
  };
  walk(repoDir, 0);
  return [...names].filter((n) => !RESERVED.has(n) && !n.startsWith('NETLIFY_') && !n.startsWith('PAGINITY_')).sort();
}

export function listSecrets(ctx: Ctx, site: SiteRow) {
  const rows = ctx.db.prepare('SELECT s.env, s.name, s.updated_at, u.name AS who FROM site_secrets s LEFT JOIN users u ON u.id = s.updated_by WHERE s.site_id = ?').all(site.id) as {
    env: SecretEnv;
    name: string;
    updated_at: number;
    who: string | null;
  }[];
  const m = ctx.sites.manifest(site);
  const detected = detectNames(ctx.sites.repoDir(site), m.publishDir);
  const all = [...new Set([...detected, ...rows.map((r) => r.name)])].sort();
  return all.map((name) => {
    const prod = rows.find((r) => r.name === name && r.env === 'production');
    const test = rows.find((r) => r.name === name && r.env === 'test');
    return {
      nom: name,
      utiliseParLeCode: detected.includes(name),
      production: prod ? { le: prod.updated_at, par: prod.who } : null,
      test: test ? { le: test.updated_at, par: test.who } : null,
    };
  });
}

export function setSecret(ctx: Ctx, site: SiteRow, env: SecretEnv, name: unknown, value: unknown, userId: string): void {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new UserError(400, 'Nom invalide : lettres, chiffres et « _ » seulement (ex. CLE_API).');
  if (RESERVED.has(name) || name.startsWith('PAGINITY_')) throw new UserError(400, 'Ce nom est réservé par PAGINITY.');
  if (typeof value !== 'string' || value.length === 0) throw new UserError(400, 'La valeur est vide.');
  if (value.length > 16_384) throw new UserError(400, 'Valeur trop longue (16 000 caractères maximum).');
  if (isSensitiveName(name)) {
    // Une clé de test identique à la vraie clé permettrait à un aperçu d'envoyer de vrais SMS, e-mails ou paiements (D11).
    const other: SecretEnv = env === 'production' ? 'test' : 'production';
    const row = ctx.db.prepare('SELECT value_enc FROM site_secrets WHERE site_id = ? AND env = ? AND name = ?').get(site.id, other, name) as { value_enc: string } | undefined;
    if (row && ctx.vault.decrypt(row.value_enc) === value) {
      throw new UserError(
        400,
        env === 'test'
          ? 'Cette valeur de test est identique à celle de production : un aperçu pourrait agir pour de vrai. Utilisez une clé de test (bac à sable) fournie par le service.'
          : 'Cette valeur est identique à la valeur de test : les aperçus pourraient agir pour de vrai. Changez d’abord la valeur de test.',
      );
    }
  }
  ctx.db
    .prepare(
      'INSERT INTO site_secrets (site_id, env, name, value_enc, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(site_id, env, name) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
    )
    .run(site.id, env, name, ctx.vault.encrypt(value), now(), userId);
}

/** Noms qui désignent une clé, un jeton ou un mot de passe (et non un simple réglage comme un nom d'expéditeur). */
export function isSensitiveName(name: string): boolean {
  return /(KEY|CLE|SECRET|TOKEN|JETON|PASSWORD|PASSWD|MOT_DE_PASSE|PASS|PRIVATE|PRIVEE|CREDENTIAL|AUTH|API)/i.test(name);
}

export function deleteSecret(ctx: Ctx, site: SiteRow, env: SecretEnv, name: string): void {
  const r = ctx.db.prepare('DELETE FROM site_secrets WHERE site_id = ? AND env = ? AND name = ?').run(site.id, env, name);
  if (r.changes === 0) throw new UserError(404, 'Secret introuvable.');
}

/** Valeurs en clair, uniquement pour démarrer l'exécuteur du site (jamais renvoyées à l'interface). */
export function secretValues(ctx: Ctx, siteId: string, env: SecretEnv): Record<string, string> {
  const rows = ctx.db.prepare('SELECT name, value_enc FROM site_secrets WHERE site_id = ? AND env = ?').all(siteId, env) as { name: string; value_enc: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.name] = ctx.vault.decrypt(r.value_enc);
  return out;
}

/**
 * Remplace toute valeur de secret du site (production ET test) par « [secret masqué] ».
 * À appliquer à tout texte qui sort vers un journal, une alerte, un e-mail ou l'interface.
 */
export function maskSecrets(ctx: Ctx, siteId: string | null | undefined, text: string): string {
  if (!siteId || !text) return text;
  let out = text;
  try {
    const rows = ctx.db.prepare('SELECT value_enc FROM site_secrets WHERE site_id = ?').all(siteId) as { value_enc: string }[];
    const values = rows.map((r) => ctx.vault.decrypt(r.value_enc)).filter((v) => v.length >= 6).sort((a, b) => b.length - a.length);
    for (const v of values) out = out.split(v).join('[secret masqué]');
  } catch {
    /* site supprimé ou coffre illisible : texte laissé tel quel */
  }
  return out;
}

export function hasTestSecrets(ctx: Ctx, siteId: string): boolean {
  return !!ctx.db.prepare("SELECT 1 FROM site_secrets WHERE site_id = ? AND env = 'test' LIMIT 1").get(siteId);
}
