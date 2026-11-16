import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { parse as parseToml } from 'smol-toml';

/**
 * Fiche technique d'un site : `paginity.yml` à la racine du dépôt.
 * Si elle est absente (site importé), elle est déduite de `netlify.toml` ou de l'organisation des fichiers.
 */
export interface Redirect {
  from: string;
  to: string;
  status: number;
}
export interface HeaderRule {
  for: string;
  values: Record<string, string>;
}

export interface SiteManifest {
  /** Dossier publié, relatif à la racine du dépôt ('.' = tout le dépôt). */
  publishDir: string;
  /** Étape de préparation (exécutée dans un environnement isolé à chaque publication). */
  build: string | null;
  functionsDir: string | null;
  functionsFormat: 'netlify-v2' | null;
  redirects: Redirect[];
  headers: HeaderRule[];
  /** Origine de la fiche, pour l'affichage. */
  source: 'paginity.yml' | 'netlify.toml' | 'automatique';
  warnings: string[];
}

/** Fichiers techniques jamais publiés, même si le dossier publié est la racine du dépôt. */
export const TECHNICAL_FILES = ['paginity.yml', 'netlify.toml', 'package.json', 'package-lock.json', 'node_modules', 'netlify', 'outils-de-test', 'CLAUDE.md'];

function safeRel(p: unknown, fallback: string): string {
  if (typeof p !== 'string' || !p.trim()) return fallback;
  const n = path.posix.normalize(p.trim().replace(/^\.\/+/, '').replace(/\/+$/, '')) || '.';
  if (n.startsWith('..') || path.posix.isAbsolute(n)) return fallback;
  return n;
}

function guessPublishDir(repoDir: string): string {
  for (const d of ['public', 'dist', 'site', 'www', 'docs']) {
    if (fs.existsSync(path.join(repoDir, d, 'index.html'))) return d;
  }
  return '.';
}

export function readManifest(repoDir: string): SiteManifest {
  const warnings: string[] = [];
  const ymlPath = path.join(repoDir, 'paginity.yml');
  const tomlPath = path.join(repoDir, 'netlify.toml');
  let m: SiteManifest = {
    publishDir: guessPublishDir(repoDir),
    build: null,
    functionsDir: null,
    functionsFormat: null,
    redirects: [],
    headers: [],
    source: 'automatique',
    warnings,
  };

  if (fs.existsSync(tomlPath)) {
    try {
      const t = parseToml(fs.readFileSync(tomlPath, 'utf8')) as Record<string, any>;
      m.source = 'netlify.toml';
      m.publishDir = safeRel(t.build?.publish, m.publishDir);
      m.build = typeof t.build?.command === 'string' && t.build.command.trim() ? t.build.command.trim() : null;
      const fdir = t.functions?.directory ?? (fs.existsSync(path.join(repoDir, 'netlify/functions')) ? 'netlify/functions' : null);
      if (fdir) {
        m.functionsDir = safeRel(fdir, 'netlify/functions');
        m.functionsFormat = 'netlify-v2';
      }
      for (const r of Array.isArray(t.redirects) ? t.redirects : []) {
        if (typeof r.from === 'string' && typeof r.to === 'string') m.redirects.push({ from: r.from, to: r.to, status: Number(r.status) || 301 });
      }
      for (const h of Array.isArray(t.headers) ? t.headers : []) {
        if (typeof h.for === 'string' && h.values && typeof h.values === 'object') {
          const values: Record<string, string> = {};
          for (const [k, v] of Object.entries(h.values)) values[k] = String(v);
          m.headers.push({ for: h.for, values });
        }
      }
    } catch (e) {
      warnings.push(`Le fichier netlify.toml n'a pas pu être lu : ${(e as Error).message}`);
    }
  }

  if (fs.existsSync(ymlPath)) {
    try {
      const y = YAML.parse(fs.readFileSync(ymlPath, 'utf8')) ?? {};
      m = {
        ...m,
        source: 'paginity.yml',
        publishDir: safeRel(y.dossier_publie, m.publishDir),
        build: typeof y.preparation === 'string' && y.preparation.trim() ? y.preparation.trim() : y.preparation === null ? null : m.build,
        functionsDir: y.fonctions?.dossier ? safeRel(y.fonctions.dossier, 'netlify/functions') : m.functionsDir,
        functionsFormat: y.fonctions?.format === 'netlify-v2' ? 'netlify-v2' : m.functionsFormat,
      };
    } catch (e) {
      warnings.push(`Le fichier paginity.yml n'a pas pu être lu : ${(e as Error).message}`);
    }
  }

  if (m.build) {
    warnings.push(
      `Étape de préparation détectée (« ${m.build} ») : elle est exécutée à chaque publication et à chaque aperçu, dans un environnement isolé du reste du serveur.`,
    );
  }
  if (m.functionsDir && fs.existsSync(path.join(repoDir, m.functionsDir))) {
    warnings.push('Fonctions serveur détectées : elles tournent dans un environnement isolé. Leurs clés se règlent dans « Secrets » ; leurs tâches planifiées restent arrêtées tant qu’elles ne sont pas activées dans « Fonctions et tâches ».');
  }
  return m;
}

export function writeManifest(repoDir: string, m: Pick<SiteManifest, 'publishDir' | 'build' | 'functionsDir' | 'functionsFormat'>): void {
  const doc: Record<string, unknown> = { dossier_publie: m.publishDir };
  if (m.build) doc.preparation = m.build;
  if (m.functionsDir) doc.fonctions = { dossier: m.functionsDir, format: m.functionsFormat ?? 'netlify-v2' };
  const header = '# Fiche technique du site, lue par PAGINITY.\n# dossier_publie : dossier mis en ligne. preparation : commande lancée avant chaque publication.\n';
  fs.writeFileSync(path.join(repoDir, 'paginity.yml'), header + YAML.stringify(doc));
}
