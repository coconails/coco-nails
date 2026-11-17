import type { Ctx } from '../context.js';
import { getSetting, setSetting } from '../db.js';
import { UserError } from './util.js';
import { serverHealth } from '../http/routes-system.js';

/**
 * Alerte de panne par « battement de cœur ».
 *
 * Un serveur éteint ne peut prévenir personne. Le principe est donc inversé : PAGINITY envoie toutes les N minutes un
 * petit signal (« je vais bien ») à un service de surveillance extérieur gratuit (par exemple healthchecks.io).
 * Si les signaux s'arrêtent (coupure de courant, box en panne, machine plantée), C'EST CE SERVICE qui vous prévient
 * par e-mail, SMS ou notification. Si PAGINITY tourne mais va mal (base illisible, disque presque plein, serveur des
 * sites arrêté), il envoie un signal « en panne » (adresse + /fail, convention de healthchecks.io) : alerte immédiate.
 *
 * Seule une requête GET sans contenu est envoyée : aucune donnée ne sort.
 */
export interface ReglagesBattement {
  active: boolean;
  url: string;
  minutes: number;
}
interface Etat {
  dernier: null | { le: number; ok: boolean; panne: string | null; reponse: string };
}
const DEFAUT: ReglagesBattement = { active: false, url: '', minutes: 5 };

export class Battement {
  private minuteur: NodeJS.Timeout | null = null;
  private dernierEnvoi = 0;
  constructor(
    private ctx: Ctx,
    private sitesEnLigne: () => boolean = () => true,
  ) {}

  reglages(): ReglagesBattement {
    try {
      return { ...DEFAUT, ...JSON.parse(getSetting(this.ctx.db, 'battement') ?? '{}') };
    } catch {
      return DEFAUT;
    }
  }
  private etat(): Etat {
    try {
      return { dernier: null, ...JSON.parse(getSetting(this.ctx.db, 'battement_etat') ?? '{}') };
    } catch {
      return { dernier: null };
    }
  }
  resume() {
    return { reglages: this.reglages(), ...this.etat() };
  }

  modifier(input: Record<string, unknown>) {
    const r = { ...this.reglages() };
    if (input.url !== undefined) {
      const u = String(input.url ?? '').trim();
      if (u) {
        let x: URL;
        try {
          x = new URL(u);
        } catch {
          throw new UserError(400, 'Adresse invalide : collez l’adresse « ping » donnée par le service de surveillance.');
        }
        const local = ['localhost', '127.0.0.1'].includes(x.hostname);
        if (x.protocol !== 'https:' && !(local && x.protocol === 'http:')) throw new UserError(400, 'L’adresse doit commencer par https://');
        if (x.username || x.password) throw new UserError(400, 'L’adresse ne doit pas contenir d’identifiant.');
      }
      r.url = u;
    }
    if (input.minutes !== undefined) {
      const m = Number(input.minutes);
      if (!Number.isInteger(m) || m < 1 || m > 60) throw new UserError(400, 'Intervalle entre 1 et 60 minutes.');
      r.minutes = m;
    }
    if (input.active !== undefined) r.active = input.active === true;
    if (r.active && !r.url) throw new UserError(400, 'Collez d’abord l’adresse donnée par le service de surveillance.');
    setSetting(this.ctx.db, 'battement', JSON.stringify(r));
    return this.resume();
  }

  /** Contrôles internes : null si tout va bien, sinon la raison. */
  panne(): string | null {
    try {
      const r = this.ctx.db.prepare('PRAGMA quick_check').get() as Record<string, string>;
      if (Object.values(r)[0] !== 'ok') return 'base de données abîmée';
    } catch {
      return 'base de données illisible';
    }
    const h = serverHealth(this.ctx);
    if (h.disque && h.disque.utilisePct >= 95) return `disque plein à ${h.disque.utilisePct} %`;
    if (!this.sitesEnLigne()) return 'le serveur des sites ne répond plus';
    return null;
  }

  /** Envoie un battement maintenant (ou un signal de panne). */
  async envoyer(): Promise<Etat['dernier']> {
    const r = this.reglages();
    if (!r.url) throw new UserError(400, 'Aucune adresse de surveillance enregistrée.');
    const panne = this.panne();
    const url = panne ? `${r.url.replace(/\/$/, '')}/fail` : r.url;
    let dernier: NonNullable<Etat['dernier']>;
    try {
      const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10_000), redirect: 'error', headers: { 'user-agent': 'PAGINITY' } });
      dernier = { le: Date.now(), ok: res.ok, panne, reponse: res.ok ? 'reçu par le service' : `le service a répondu ${res.status}` };
    } catch (e) {
      dernier = { le: Date.now(), ok: false, panne, reponse: `service injoignable (${(e as Error).name === 'TimeoutError' ? 'délai dépassé' : 'pas de connexion'})` };
    }
    this.dernierEnvoi = Date.now();
    setSetting(this.ctx.db, 'battement_etat', JSON.stringify({ dernier }));
    return dernier;
  }

  demarrer(): void {
    if (this.minuteur) return;
    this.minuteur = setInterval(() => {
      const r = this.reglages();
      if (r.active && r.url && Date.now() - this.dernierEnvoi >= r.minutes * 60_000 - 5_000) void this.envoyer().catch(() => {});
    }, 30_000);
    this.minuteur.unref();
  }
  arreter(): void {
    if (this.minuteur) clearInterval(this.minuteur);
    this.minuteur = null;
  }
}
