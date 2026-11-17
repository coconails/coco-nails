import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ctx } from '../context.js';
import { getSetting, setSetting } from '../db.js';
import { raiseAlert } from './alerts.js';
import { UserError } from './util.js';

/**
 * Surveillance des failles connues dans les composants de PAGINITY (bibliothèques installées avec npm).
 * PAGINITY envoie au registre public de npm la LISTE de ses composants et de leurs versions (rien d'autre : aucune
 * donnée des sites ni des personnes) et reçoit les failles connues. Il ne met rien à jour tout seul : il prévient,
 * et la mise à jour se fait avec « paginity-maj » (sauvegarde, tests et retour arrière automatique).
 * Désactivé par défaut : « Vérifier maintenant » à la demande, ou chaque semaine si vous l'activez.
 */
const ICI = path.dirname(fileURLToPath(import.meta.url));
const LOCK = path.resolve(ICI, '..', '..', '..', 'package-lock.json');
const GRAVITE: Record<string, number> = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };
const NOM_GRAVITE: Record<string, string> = { critical: 'critique', high: 'élevée', moderate: 'moyenne', low: 'faible', info: 'information' };

interface Faille {
  paquet: string;
  version: string;
  titre: string;
  gravite: string;
  url: string;
}
interface Etat {
  hebdo: boolean;
  dernier: null | { le: number; ok: boolean; composants: number; failles: Faille[]; erreur: string | null };
}

export function composants(lock = LOCK): Record<string, string[]> {
  const l = JSON.parse(fs.readFileSync(lock, 'utf8')) as { packages: Record<string, { version?: string; dev?: boolean }> };
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(l.packages)) {
    const i = k.lastIndexOf('node_modules/');
    if (i < 0 || v.dev || !v.version) continue;
    const nom = k.slice(i + 'node_modules/'.length);
    (out[nom] ??= []).includes(v.version) || out[nom].push(v.version);
  }
  return out;
}

export class MisesAJour {
  constructor(private ctx: Ctx) {}
  etat(): Etat {
    try {
      return { hebdo: false, dernier: null, ...JSON.parse(getSetting(this.ctx.db, 'maj_securite') ?? '{}') };
    } catch {
      return { hebdo: false, dernier: null };
    }
  }
  private ecrire(e: Etat) {
    setSetting(this.ctx.db, 'maj_securite', JSON.stringify(e));
  }
  regler(hebdo: unknown): Etat {
    const e = { ...this.etat(), hebdo: hebdo === true };
    this.ecrire(e);
    return e;
  }

  async verifier(): Promise<Etat> {
    const registre = (process.env.PAGINITY_REGISTRE_URL ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
    let liste: Record<string, string[]>;
    try {
      liste = composants();
    } catch {
      throw new UserError(500, 'Liste des composants introuvable (package-lock.json).');
    }
    const e = this.etat();
    try {
      const r = await fetch(`${registre}/-/npm/v1/security/advisories/bulk`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'PAGINITY' },
        body: JSON.stringify(liste),
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) throw new Error(`le registre a répondu ${r.status}`);
      const avis = (await r.json()) as Record<string, { title?: string; severity?: string; url?: string; vulnerable_versions?: string }[]>;
      const failles: Faille[] = [];
      for (const [paquet, l] of Object.entries(avis)) {
        for (const a of Array.isArray(l) ? l : []) {
          failles.push({ paquet, version: (liste[paquet] ?? []).join(', '), titre: String(a.title ?? 'faille').slice(0, 200), gravite: String(a.severity ?? 'info'), url: String(a.url ?? '') });
        }
      }
      failles.sort((a, b) => (GRAVITE[b.gravite] ?? 0) - (GRAVITE[a.gravite] ?? 0));
      e.dernier = { le: Date.now(), ok: true, composants: Object.keys(liste).length, failles, erreur: null };
      if (failles.length) {
        const grave = failles.some((f) => (GRAVITE[f.gravite] ?? 0) >= 3);
        raiseAlert(this.ctx, grave ? 'critique' : 'attention', `${failles.length} faille(s) connue(s) dans les composants de PAGINITY (la plus grave : ${NOM_GRAVITE[failles[0].gravite] ?? failles[0].gravite}, « ${failles[0].paquet} »). Lancez une mise à jour avec paginity-maj.`);
      }
    } catch (err) {
      e.dernier = { le: Date.now(), ok: false, composants: Object.keys(liste).length, failles: [], erreur: `Vérification impossible : ${(err as Error).message}` };
    }
    this.ecrire(e);
    return e;
  }

  async tic(): Promise<void> {
    const e = this.etat();
    if (e.hebdo && (!e.dernier || Date.now() - e.dernier.le > 7 * 86_400_000)) await this.verifier();
  }
}
