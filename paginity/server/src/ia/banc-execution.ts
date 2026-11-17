import type { Ctx } from '../context.js';
import { getSetting, setSetting } from '../db.js';
import { now, UserError } from '../lib/util.js';
import type { Assistant } from './assistant.js';
import { juger, MAX_REELLES, noteDomaine, salonFictif, TACHES_BANC, tacheReelle, type DemandeReelle, type ResultatTache, type TacheBanc } from './banc.js';
import { domaineDe, estLocal, mois } from './types.js';
import type { Cerveau, Changement, DemandeCerveau, Domaine, LigneProposition, RubriqueContexte } from './types.js';

/**
 * PAGINITY AI — exécution du banc d'essai : demandes types (salon fictif) et vraies demandes acceptées, posées à
 * chaque IA ; notes par domaine reprises par la salle de réunion. Les contrôles sont dans banc.ts.
 */
export class GestionBanc {
  enCours: null | { debut: number; total: number; fait: number; actuel: string; arret: boolean } = null;
  constructor(
    private ctx: Ctx,
    private a: Assistant,
  ) {}

  reelles(): DemandeReelle[] {
    try {
      return JSON.parse(getSetting(this.ctx.db, 'ia_banc_reelles') ?? '[]');
    } catch {
      return [];
    }
  }
  retenirPourBanc(p: LigneProposition, rubriques: RubriqueContexte[], changements: Changement[]) {
    if (JSON.stringify(rubriques).length > 60_000) return; // site trop gros pour en faire une demande type
    const domaine: Domaine = (p.reunion ? JSON.parse(p.reunion).domaine : null) ?? domaineDe(p.demande);
    const d: DemandeReelle = { id: p.id, le: now(), demande: p.demande, domaine, rubriques, attendu: changements.map((c) => ({ rubrique: c.rubrique, valeur: c.apres })) };
    setSetting(this.ctx.db, 'ia_banc_reelles', JSON.stringify([...this.reelles().filter((x) => x.id !== p.id), d].slice(-MAX_REELLES)));
  }
  oublierReelle(id: string) {
    setSetting(this.ctx.db, 'ia_banc_reelles', JSON.stringify(this.reelles().filter((x) => x.id !== id)));
  }
  /** Efface les demandes réelles retenues par le banc. */
  oublierReelles(): void {
    setSetting(this.ctx.db, 'ia_banc_reelles', '[]');
  }
  tachesBanc(): { t: TacheBanc; rubriques: RubriqueContexte[] }[] {
    return [...TACHES_BANC.map((t) => ({ t, rubriques: salonFictif(t.piege) })), ...this.reelles().map((r) => ({ t: tacheReelle(r), rubriques: structuredClone(r.rubriques) }))];
  }

  // ------------------------------------------------------------------ banc d'essai (étape D)
  /** Derniers résultats, demandes types, essai en cours. */
  bancEtat() {
    let dernier: unknown = null;
    try {
      dernier = JSON.parse(getSetting(this.ctx.db, 'ia_banc') ?? 'null');
    } catch {
      /* résultats illisibles : comme s'il n'y en avait pas */
    }
    const e = this.enCours;
    return {
      enCours: e && { debut: e.debut, total: e.total, fait: e.fait, actuel: this.a.libelle(e.actuel), arret: e.arret },
      dernier,
      reelles: this.reelles().length,
      taches: this.tachesBanc().map(({ t }) => ({ id: t.id, titre: t.titre, domaine: t.domaine, demande: t.demande, reelle: t.id.startsWith('reel:') })),
      libelles: this.a.toutesCles(),
    };
  }

  /**
   * Lance le banc d'essai en arrière-plan sur les IA choisies (par défaut : tous les modèles locaux en service).
   * Les IA payantes ne passent le banc que si `payants` est demandé, et toujours dans les plafonds.
   * Aucun site n'est lu ni modifié : les demandes portent sur un salon fictif en mémoire.
   */
  lancerBanc(cles: unknown, payants: boolean): { total: number; cles: string[] } {
    if (this.enCours) throw new UserError(409, 'Un banc d’essai est déjà en cours.');
    const actifs = this.a.cerveauxActifs();
    let choix: string[];
    if (Array.isArray(cles) && cles.length) {
      choix = [...new Set(cles.map(String))];
      for (const k of choix) {
        if (!actifs[k]) throw new UserError(400, `« ${this.a.libelle(k) || k} » n’est pas en service.`);
        if (!estLocal(k) && !payants) throw new UserError(400, `${this.a.libelle(k)} est payante : cochez « inclure les IA payantes ».`);
      }
    } else choix = Object.keys(actifs).filter((k) => estLocal(k) || payants);
    if (!choix.length) throw new UserError(400, 'Aucune IA en service à essayer. Ajoutez et autorisez au moins un modèle local.');
    const total = choix.length * this.tachesBanc().length;
    this.enCours = { debut: now(), total, fait: 0, actuel: choix[0], arret: false };
    void this.executerBanc(choix, actifs).finally(() => (this.enCours = null));
    return { total, cles: choix };
  }

  arreterBanc(): boolean {
    if (!this.enCours) return false;
    this.enCours.arret = true;
    return true;
  }

  private async executerBanc(choix: string[], actifs: Record<string, Cerveau>) {
    const e = this.enCours!;
    const verif = (chg: { rubrique: string; valeur: unknown }[], rub: RubriqueContexte[]) => {
      const v = this.a.verifier(chg, rub, {});
      return v.ok ? [] : v.erreurs;
    };
    for (const cle of choix) {
      const c = actifs[cle];
      e.actuel = cle;
      const details: ResultatTache[] = [];
      let plafond = false;
      const taches = this.tachesBanc();
      for (const { t, rubriques: rubT } of taches) {
        if (e.arret) break;
        const d: DemandeCerveau = { demande: t.demande, rubriques: structuredClone(rubT) };
        let res: ResultatTache;
        if (!estLocal(cle) && (plafond || !this.a.budgetPermet(cle, c, d))) {
          plafond = true;
          res = { tache: t.id, titre: t.titre, domaine: t.domaine, reussi: false, raison: 'non essayée : plafond de dépense atteint', ms: 0, centimes: 0 };
        } else {
          const t0 = Date.now();
          const r = await this.a.appeler(c, d);
          const centimes = !estLocal(cle) ? (r.cout ?? 0) : 0;
          if (centimes > 0) this.ctx.db.prepare('INSERT INTO ia_usage (mois, at, proposition_id, centimes, fournisseur) VALUES (?, ?, ?, ?, ?)').run(mois(), now(), 'banc', centimes, cle);
          const j = juger(t, (r.reponse as Parameters<typeof juger>[1]) ?? null, r.erreur ?? null, verif, structuredClone(rubT));
          res = { tache: t.id, titre: t.titre, domaine: t.domaine, ...j, ms: Date.now() - t0, centimes };
        }
        details.push(res);
        e.fait++;
      }
      if (details.length < taches.length) break; // arrêté : on ne note pas un essai incomplet
      const notes = { textes: noteDomaine(details, 'textes'), donnees: noteDomaine(details, 'donnees') };
      for (const dom of ['textes', 'donnees'] as const) if (notes[dom] !== null && !plafond) this.a.noterBanc(cle, dom, notes[dom]!);
      let tout: { resultats: Record<string, unknown> } = { resultats: {} };
      try {
        tout = JSON.parse(getSetting(this.ctx.db, 'ia_banc') ?? '{"resultats":{}}');
      } catch {
        /* on repart de zéro */
      }
      tout.resultats[cle] = {
        le: now(),
        libelle: this.a.libelle(cle),
        notes,
        complet: !plafond,
        reussies: details.filter((x) => x.reussi).length,
        total: details.length,
        msMoyen: Math.round(details.reduce((a, x) => a + x.ms, 0) / details.length),
        centimes: details.reduce((a, x) => a + x.centimes, 0),
        details,
      };
      setSetting(this.ctx.db, 'ia_banc', JSON.stringify({ le: now(), resultats: tout.resultats }));
    }
  }
}
