import { UserError } from './util.js';

/**
 * Limite de fréquence pour les opérations coûteuses (fabrication du site, appels à Google…) : au plus `max` fois par
 * fenêtre glissante, par site et par type d'opération. Au-delà : réponse 429 avec le délai à attendre.
 */
const traces = new Map<string, number[]>();

export function limiter(cle: string, max: number, fenetreMs: number, maintenant = Date.now()): void {
  const t = (traces.get(cle) ?? []).filter((x) => maintenant - x < fenetreMs);
  if (t.length >= max) {
    const attente = Math.ceil((fenetreMs - (maintenant - t[0])) / 1000);
    traces.set(cle, t);
    throw new UserError(429, `Trop de demandes rapprochées pour cette opération : réessayez dans ${attente} s.`);
  }
  t.push(maintenant);
  traces.set(cle, t);
  if (traces.size > 5000) for (const [k, v] of traces) if (!v.some((x) => maintenant - x < fenetreMs)) traces.delete(k);
}

/** Pour les tests. */
export function viderLimites(): void {
  traces.clear();
}
