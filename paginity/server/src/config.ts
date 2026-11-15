import path from 'node:path';

/**
 * Configuration de PAGINITY.
 * Tout se règle par variables d'environnement (fichier reglages/paginity.env en production),
 * avec des valeurs par défaut adaptées à un essai sur un ordinateur ordinaire.
 */
export interface Config {
  /** Dossier racine de toutes les données (sites, base, coffre…). */
  dataDir: string;
  /** Adresse réseau d'écoute des trois serveurs. */
  host: string;
  adminPort: number;
  previewPort: number;
  sitesPort: number;
  /** Adresse publique de l'administration, ex. https://admin.mondomaine.fr */
  publicUrl: string;
  /** Domaine de base des aperçus : chaque site est servi sur <identifiant>.<domaine>. */
  previewBaseDomain: string;
  previewProtocol: 'http' | 'https';
  /** Port visible dans les liens d'aperçu (vide si 80/443 derrière un relais). */
  previewPublicPort: string;
  /** Domaine de base des adresses de test des sites : <identifiant>.<domaine>. */
  sitesBaseDomain: string;
  sitesProtocol: 'http' | 'https';
  sitesPublicPort: string;
  /** Identifiant de domaine des passkeys (WebAuthn). */
  rpId: string;
  rpName: string;
  /** Cookies « Secure » (obligatoire dès que l'accès se fait en HTTPS). */
  secureCookies: boolean;
  /** Déconnexion après inactivité (minutes) et durée maximale d'une session (heures). */
  sessionIdleMinutes: number;
  sessionMaxHours: number;
  /** Durée de la confirmation renforcée (minutes). */
  sudoMinutes: number;
  /** Nombre de versions fabriquées conservées par site. */
  keepVersions: number;
  /** Nombre maximal de fabrications simultanées (toutes opérations longues confondues). */
  maxConcurrentJobs: number;
  /** Dossier de l'interface déjà fabriquée (web/dist). */
  webDir: string;
  /** Dossier des modèles de sites. */
  templatesDir: string;
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name: string, fallback: number): number {
  const v = Number.parseInt(env(name, String(fallback)), 10);
  return Number.isFinite(v) ? v : fallback;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const serverRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const adminPort = int('PAGINITY_ADMIN_PORT', 8080);
  const previewPort = int('PAGINITY_PREVIEW_PORT', 8081);
  const sitesPort = int('PAGINITY_SITES_PORT', 8082);
  const publicUrl = env('PAGINITY_PUBLIC_URL', `http://localhost:${overrides.adminPort ?? adminPort}`).replace(/\/$/, '');
  const base: Config = {
    dataDir: path.resolve(env('PAGINITY_DATA_DIR', path.join(serverRoot, '..', 'data'))),
    host: env('PAGINITY_HOST', '127.0.0.1'),
    adminPort,
    previewPort,
    sitesPort,
    publicUrl,
    previewBaseDomain: env('PAGINITY_PREVIEW_DOMAIN', 'localhost'),
    previewProtocol: env('PAGINITY_PREVIEW_PROTOCOL', 'http') === 'https' ? 'https' : 'http',
    previewPublicPort: env('PAGINITY_PREVIEW_PUBLIC_PORT', String(overrides.previewPort ?? previewPort)),
    sitesBaseDomain: env('PAGINITY_SITES_DOMAIN', 'localhost'),
    sitesProtocol: env('PAGINITY_SITES_PROTOCOL', 'http') === 'https' ? 'https' : 'http',
    sitesPublicPort: env('PAGINITY_SITES_PUBLIC_PORT', String(overrides.sitesPort ?? sitesPort)),
    rpId: env('PAGINITY_RP_ID', new URL(publicUrl).hostname),
    rpName: 'PAGINITY',
    secureCookies: env('PAGINITY_SECURE_COOKIES', publicUrl.startsWith('https:') ? 'true' : 'false') === 'true',
    sessionIdleMinutes: int('PAGINITY_SESSION_IDLE_MINUTES', 30),
    sessionMaxHours: int('PAGINITY_SESSION_MAX_HOURS', 12),
    sudoMinutes: int('PAGINITY_SUDO_MINUTES', 10),
    keepVersions: int('PAGINITY_KEEP_VERSIONS', 20),
    maxConcurrentJobs: int('PAGINITY_MAX_JOBS', 2),
    webDir: path.resolve(env('PAGINITY_WEB_DIR', path.join(serverRoot, '..', 'web', 'dist'))),
    templatesDir: path.resolve(env('PAGINITY_TEMPLATES_DIR', path.join(serverRoot, 'templates'))),
  };
  return { ...base, ...overrides };
}

export function adminOrigin(c: Config): string {
  return new URL(c.publicUrl).origin;
}

function withPort(port: string, protocol: string): string {
  if (!port) return '';
  if ((protocol === 'http' && port === '80') || (protocol === 'https' && port === '443')) return '';
  return `:${port}`;
}

export function previewOrigin(c: Config, slug: string): string {
  return `${c.previewProtocol}://${slug}.${c.previewBaseDomain}${withPort(c.previewPublicPort, c.previewProtocol)}`;
}

export function previewOriginPattern(c: Config): string {
  return `${c.previewProtocol}://*.${c.previewBaseDomain}${withPort(c.previewPublicPort, c.previewProtocol)}`;
}

export function siteTestOrigin(c: Config, slug: string): string {
  return `${c.sitesProtocol}://${slug}.${c.sitesBaseDomain}${withPort(c.sitesPublicPort, c.sitesProtocol)}`;
}
