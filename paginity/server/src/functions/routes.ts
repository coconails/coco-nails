import type { FunctionInfo } from './service.js';

/** Même logique de correspondance d'adresses que l'exécuteur (runtime/worker.mjs). */
function compile(pattern: string): RegExp {
  const re = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*$/, '.*')
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '[^/]+');
  return new RegExp(`^${re}/?$`);
}

const cache = new Map<string, RegExp[]>();

/** Vrai si cette adresse doit être confiée aux fonctions du site plutôt qu'aux fichiers. */
export function isFunctionPath(catalog: FunctionInfo[], pathname: string): boolean {
  if (pathname.startsWith('/.netlify/functions/')) return true;
  for (const f of catalog) {
    if (f.erreur) continue;
    for (const p of f.chemins) {
      let r = cache.get(p);
      if (!r) {
        r = [compile(p)];
        cache.set(p, r);
      }
      if (r[0].test(pathname)) return true;
    }
  }
  return false;
}
