import crypto from 'node:crypto';
import type { Ctx } from '../context.js';
import type { UserRow } from '../auth/service.js';
import type { SiteRow } from '../sites/service.js';
import { getSetting, setSetting } from '../db.js';
import { audit } from '../lib/audit.js';
import { now, randomId, UserError } from '../lib/util.js';
import { loadSchema, readEntry, saveEntry } from '../content/service.js';
import { validateEntryValue, type Field } from '../content/schema.js';
import { isServerCode } from '../sites/server-code.js';
import { cerveauChatGPT, cerveauClaude, cerveauLocal, TARIFS_CLAUDE, type ConfigExterne, type ConfigLocal, type ConfigLocalNomme } from './fournisseurs.js';

/**
 * PAGINITY AI — étape 1 : le cœur de l'agent et l'aiguilleur (« assistant contenus »).
 *
 * Principes (voir docs/PAGINITY-AI.md) :
 *  - Le « cerveau » (modèle local ou Claude) ne reçoit AUCUN outil : seulement la demande et les contenus publics
 *    du site concerné (jamais les secrets, les messages des formulaires ni le code serveur). Il ne peut que renvoyer
 *    une proposition structurée : « rubrique X → nouvelle valeur ».
 *  - PAGINITY vérifie la proposition avec les mêmes règles que les formulaires (rubrique existante, champs valides).
 *  - Rien n'est écrit tant qu'une personne n'a pas accepté CETTE proposition (empreinte), et seulement dans le
 *    brouillon : la publication reste un geste séparé, avec aperçu et retour arrière.
 *  - Le relais vers Claude est décidé par des règles vérifiables, jamais par l'avis du modèle sur lui-même ;
 *    il est soumis au réglage du propriétaire (jamais / sur accord / automatique) et à un plafond mensuel.
 */

/** « local:<identifiant> » pour un modèle installé, « claude », « chatgpt » pour les IA extérieures. */
export type NomCerveau = string;
export type NomExterne = 'claude' | 'chatgpt';
export const NOMS_EXTERNES: NomExterne[] = ['claude', 'chatgpt'];
export const LIBELLE: Record<string, string> = { local: 'le modèle local', claude: 'Claude', chatgpt: 'ChatGPT' };
export const estLocal = (cle: string) => cle === 'local' || cle.startsWith('local:');
export const MAX_LOCAUX = 8;

export interface RubriqueContexte {
  nom: string;
  libelle: string;
  champs: Field[];
  liste: boolean;
  valeur: unknown;
}

export interface DemandeCerveau {
  demande: string;
  rubriques: RubriqueContexte[];
  /** Remarques de PAGINITY sur l'essai précédent (champs refusés), pour corriger. */
  corrections?: string[];
}

export type ReponseCerveau =
  | { statut: 'proposition'; changements: { rubrique: string; valeur: unknown }[]; explication: string; coutCentimes?: number }
  | { statut: 'impossible'; raison: string; coutCentimes?: number };

export interface Cerveau {
  nom: NomCerveau;
  /** Taille maximale du contexte (en caractères) que ce cerveau sait traiter. */
  tailleMax: number;
  /** Temps maximal d'une réponse. */
  delaiMs: number;
  disponible(): Promise<boolean>;
  proposer(d: DemandeCerveau, signal: AbortSignal): Promise<ReponseCerveau>;
  /** Coût maximal (centimes) d'un appel, pour ne jamais dépasser un plafond. Absent = gratuit. */
  estimer?(d: DemandeCerveau): number;
}

export type ModeRelais = 'jamais' | 'demander' | 'auto';
export interface ReglagesIA {
  active: boolean;
  /** Relais vers une IA extérieure (Claude, ChatGPT) : jamais, sur accord, automatique. */
  relaisExterne: ModeRelais;
  /** Plafond mensuel global de toutes les IA extérieures, en centimes. */
  plafondMensuelCentimes: number;
  /** Ordre d'essai des IA extérieures. */
  ordre: NomExterne[];
  /** Modèles installés, dans l'ordre d'essai. */
  locaux: ConfigLocalNomme[];
  claude: ConfigExterne;
  chatgpt: ConfigExterne;
}
const REGLAGES_DEFAUT: ReglagesIA = {
  active: false,
  relaisExterne: 'demander',
  plafondMensuelCentimes: 0,
  ordre: ['claude', 'chatgpt'],
  locaux: [],
  claude: { actif: false, modele: 'claude-opus-5-5', prixEntree: TARIFS_CLAUDE['claude-opus-5-5'].entree, prixSortie: TARIFS_CLAUDE['claude-opus-5-5'].sortie, plafondCentimes: null, delaiS: 180, url: '' },
  chatgpt: { actif: false, modele: '', prixEntree: null, prixSortie: null, plafondCentimes: null, delaiS: 180, url: '' },
};
const CLE: Record<NomExterne, string> = { claude: 'ia_cle_claude', chatgpt: 'ia_cle_chatgpt' };

export type StatutProposition = 'en_cours' | 'proposee' | 'accord_requis' | 'impossible' | 'acceptee' | 'refusee' | 'perimee' | 'interrompue';

interface Changement {
  rubrique: string;
  libelle: string;
  versionBase: string | null;
  avant: unknown;
  apres: unknown;
}

interface LigneProposition {
  id: string;
  site_id: string;
  user_id: string;
  demande: string;
  statut: StatutProposition;
  cerveau: NomCerveau | null;
  explication: string | null;
  raison: string | null;
  changements: string | null;
  empreinte: string | null;
  cout_centimes: number;
  journal: string;
  cree_le: number;
  decide_le: number | null;
}

const ESSAIS_LOCAUX = 2;
const mois = (t = now()) => new Date(t).toISOString().slice(0, 7);

export class Assistant {
  /** Cerveaux imposés (tests uniquement). */
  cerveaux: Record<string, Cerveau> = {};
  surcharge = false;
  private enVol = new Set<AbortController>();

  constructor(private ctx: Ctx) {}

  // ------------------------------------------------------------------ réglages
  reglages(): ReglagesIA {
    let r: Partial<ReglagesIA> = {};
    try {
      r = JSON.parse(getSetting(this.ctx.db, 'ia') ?? '{}');
    } catch {
      /* réglages abîmés : valeurs par défaut */
    }
    return {
      ...REGLAGES_DEFAUT,
      ...r,
      // Anciennes données (un seul modèle local) : reprises comme premier modèle de la liste.
      locaux: Array.isArray(r.locaux)
        ? r.locaux
        : (r as { local?: ConfigLocal }).local?.url
          ? [{ id: 'principal', nom: 'Modèle local', ...(r as { local: ConfigLocal }).local }]
          : [],
      claude: { ...REGLAGES_DEFAUT.claude, ...r.claude },
      chatgpt: { ...REGLAGES_DEFAUT.chatgpt, ...r.chatgpt },
    };
  }

  modifierReglages(input: Record<string, any>): ReglagesIA {
    const r = this.reglages();
    const centimes = (v: unknown, nul = false): number | null => {
      if (nul && (v === null || v === '')) return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 1_000_000) throw new UserError(400, 'Plafond invalide (en centimes, entre 0 et 10 000).');
      return n;
    };
    const prix = (v: unknown): number | null => {
      if (v === null || v === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1000) throw new UserError(400, 'Prix invalide (par million de jetons).');
      return n;
    };
    const adresse = (v: unknown): string => {
      const t = String(v ?? '').trim();
      if (t && !/^https?:\/\/[^\s]+$/.test(t)) throw new UserError(400, 'Adresse invalide (http:// ou https://).');
      return t;
    };
    const duree = (v: unknown) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 5 || n > 900) throw new UserError(400, 'Délai invalide (5 à 900 secondes).');
      return n;
    };
    if (typeof input.active === 'boolean') r.active = input.active;
    if (input.relaisExterne !== undefined) {
      if (!['jamais', 'demander', 'auto'].includes(input.relaisExterne)) throw new UserError(400, 'Mode de relais inconnu.');
      r.relaisExterne = input.relaisExterne;
    }
    if (input.plafondMensuelCentimes !== undefined) r.plafondMensuelCentimes = centimes(input.plafondMensuelCentimes)!;
    if (input.ordre !== undefined) {
      if (!Array.isArray(input.ordre) || input.ordre.length !== 2 || !NOMS_EXTERNES.every((n) => input.ordre.includes(n))) throw new UserError(400, 'Ordre invalide.');
      r.ordre = input.ordre;
    }
    const local = (l: any, existant?: ConfigLocalNomme): ConfigLocalNomme => {
      const m: ConfigLocalNomme = existant ? { ...existant } : { id: '', nom: 'Modèle local', actif: false, url: '', modele: '', tailleMax: 60_000, delaiS: 120 };
      if (l.id !== undefined) {
        if (typeof l.id !== 'string' || !/^[a-z0-9-]{1,20}$/.test(l.id)) throw new UserError(400, 'Identifiant de modèle invalide.');
        m.id = l.id;
      }
      if (l.nom !== undefined) {
        const n = String(l.nom).trim().slice(0, 60);
        if (!n) throw new UserError(400, 'Donnez un nom au modèle (par exemple « Qwen3-Coder »).');
        m.nom = n;
      }
      if (typeof l.actif === 'boolean') m.actif = l.actif;
      if (l.url !== undefined) m.url = adresse(l.url);
      if (l.modele !== undefined) m.modele = String(l.modele).trim().slice(0, 200);
      if (l.delaiS !== undefined) m.delaiS = duree(l.delaiS);
      if (l.tailleMax !== undefined) {
        const n = Number(l.tailleMax);
        if (!Number.isInteger(n) || n < 1000 || n > 10_000_000) throw new UserError(400, 'Taille maximale invalide.');
        m.tailleMax = n;
      }
      if (!m.id) m.id = randomId().slice(0, 10);
      return m;
    };
    if (Array.isArray(input.locaux)) {
      if (input.locaux.length > MAX_LOCAUX) throw new UserError(400, `${MAX_LOCAUX} modèles locaux au plus.`);
      const liste = input.locaux.map((l: any) => local(l, r.locaux.find((x) => x.id === l?.id)));
      if (new Set(liste.map((l: ConfigLocalNomme) => l.id)).size !== liste.length) throw new UserError(400, 'Deux modèles ont le même identifiant.');
      r.locaux = liste;
    }
    // Ancienne forme (un seul modèle) : met à jour ou crée le modèle « principal ».
    if (input.local && typeof input.local === 'object') {
      const i = r.locaux.findIndex((x) => x.id === 'principal');
      const m = local({ id: 'principal', ...input.local }, i >= 0 ? r.locaux[i] : undefined);
      if (i >= 0) r.locaux[i] = m;
      else r.locaux.unshift(m);
    }
    for (const nom of NOMS_EXTERNES) {
      const e = input[nom];
      if (!e) continue;
      if (typeof e.actif === 'boolean') r[nom].actif = e.actif;
      if (e.modele !== undefined) r[nom].modele = String(e.modele).trim().slice(0, 200);
      if (e.prixEntree !== undefined) r[nom].prixEntree = prix(e.prixEntree);
      if (e.prixSortie !== undefined) r[nom].prixSortie = prix(e.prixSortie);
      if (e.plafondCentimes !== undefined) r[nom].plafondCentimes = centimes(e.plafondCentimes, true);
      if (e.delaiS !== undefined) r[nom].delaiS = duree(e.delaiS);
      if (e.url !== undefined) r[nom].url = adresse(e.url);
    }
    setSetting(this.ctx.db, 'ia', JSON.stringify(r));
    // Arrêt d'urgence : tout ce qui tourne est coupé, rien ne pourra plus être accepté.
    if (!r.active) for (const c of this.enVol) c.abort();
    return r;
  }

  /** Clé d'API d'un service extérieur : chiffrée dans le coffre, jamais réaffichée. */
  definirCle(nom: NomExterne, cle: unknown): void {
    if (typeof cle !== 'string' || cle.trim().length < 10 || cle.length > 500) throw new UserError(400, 'Clé invalide.');
    setSetting(this.ctx.db, CLE[nom], this.ctx.vault.encrypt(cle.trim()));
  }
  effacerCle(nom: NomExterne): void {
    this.ctx.db.prepare('DELETE FROM settings WHERE key = ?').run(CLE[nom]);
  }
  private cle(nom: NomExterne): string | null {
    const v = getSetting(this.ctx.db, CLE[nom]);
    return v ? this.ctx.vault.decrypt(v) : null;
  }

  depenseDuMois(nom?: NomExterne): number {
    const sql = nom ? 'SELECT COALESCE(SUM(centimes), 0) AS n FROM ia_usage WHERE mois = ? AND fournisseur = ?' : 'SELECT COALESCE(SUM(centimes), 0) AS n FROM ia_usage WHERE mois = ?';
    return (this.ctx.db.prepare(sql).get(...(nom ? [mois(), nom] : [mois()])) as { n: number }).n;
  }

  /** Cerveaux en service : ceux fournis par les tests, sinon construits d'après les réglages. */
  cerveauxActifs(): Record<string, Cerveau> {
    if (this.surcharge) return this.cerveaux;
    const r = this.reglages();
    const out: Record<string, Cerveau> = {};
    for (const l of r.locaux) if (l.actif && l.url && l.modele) out[`local:${l.id}`] = cerveauLocal(l);
    const cc = this.cle('claude');
    if (r.claude.actif && cc && r.claude.modele && r.claude.prixEntree !== null && r.claude.prixSortie !== null) out.claude = cerveauClaude(r.claude, cc);
    const co = this.cle('chatgpt');
    if (r.chatgpt.actif && co && r.chatgpt.modele && r.chatgpt.prixEntree !== null && r.chatgpt.prixSortie !== null) out.chatgpt = cerveauChatGPT(r.chatgpt, co);
    return out;
  }

  /** Nom lisible d'un cerveau (« Qwen3-Coder », « Claude »…). */
  libelle(cle: string | null): string {
    if (!cle) return '';
    if (LIBELLE[cle]) return LIBELLE[cle];
    if (cle.startsWith('local:')) return this.reglages().locaux.find((l) => `local:${l.id}` === cle)?.nom ?? 'un modèle local';
    return cle;
  }

  etat() {
    const r = this.reglages();
    return {
      reglages: r,
      cles: { claude: !!getSetting(this.ctx.db, CLE.claude), chatgpt: !!getSetting(this.ctx.db, CLE.chatgpt) },
      depenseDuMoisCentimes: this.depenseDuMois(),
      depenseParService: { claude: this.depenseDuMois('claude'), chatgpt: this.depenseDuMois('chatgpt') },
      enService: Object.fromEntries(Object.keys(this.cerveauxActifs()).map((k) => [k, true])),
      tarifsClaude: TARIFS_CLAUDE,
    };
  }

  // ------------------------------------------------------------------ contexte transmis au cerveau
  /** Contenus publics du site, et rien d'autre (pas de secrets, de messages, de code serveur, d'autre site). */
  contexte(site: SiteRow): { rubriques: RubriqueContexte[]; versions: Record<string, string | null> } {
    const schema = loadSchema(this.ctx, site);
    const rubriques: RubriqueContexte[] = [];
    const versions: Record<string, string | null> = {};
    for (const e of schema.entries) {
      if (e.type !== 'file' || isServerCode(this.ctx, site, e.path)) continue;
      try {
        const r = readEntry(this.ctx, site, e.name);
        rubriques.push({ nom: e.name, libelle: e.label, champs: e.fields, liste: e.list, valeur: r.valeur });
        versions[e.name] = r.version;
      } catch {
        /* rubrique illisible : simplement pas proposée au cerveau */
      }
    }
    return { rubriques, versions };
  }

  // ------------------------------------------------------------------ demande
  async demander(site: SiteRow, user: UserRow, texte: unknown, opts: { forcer?: NomExterne } = {}) {
    const reg = this.reglages();
    if (!reg.active) throw new UserError(409, 'L’assistant est désactivé. Le propriétaire peut l’activer dans les Réglages de la plateforme.');
    const demande = typeof texte === 'string' ? texte.trim() : '';
    if (!demande || demande.length > 2000) throw new UserError(400, 'Décrivez votre demande (2 000 caractères au plus).');
    const id = randomId('ia');
    this.ctx.db
      .prepare("INSERT INTO ia_propositions (id, site_id, user_id, demande, statut, journal, cree_le) VALUES (?, ?, ?, ?, 'en_cours', '[]', ?)")
      .run(id, site.id, user.id, demande, now());
    audit(this.ctx.db, { userId: user.id, action: 'ia_demande', siteId: site.id, details: { id } });
    await this.traiter(id, site, opts.forcer ?? 'local');
    return this.lire(site, id);
  }

  /** Accord humain pour passer la demande à Claude (mode « sur accord »). */
  async relayer(site: SiteRow, user: UserRow, id: string) {
    const p = this.ligne(site, id);
    if (p.statut !== 'accord_requis') throw new UserError(409, 'Cette demande n’attend pas d’accord.');
    if (!this.reglages().active) throw new UserError(409, 'L’assistant est désactivé.');
    this.noter(id, `Relais vers une IA extérieure accepté par ${user.name}.`);
    audit(this.ctx.db, { userId: user.id, action: 'ia_relais_accepte', siteId: site.id, details: { id } });
    const voulu = (this.ctx.db.prepare('SELECT cerveau FROM ia_propositions WHERE id = ?').get(id) as { cerveau: string | null }).cerveau;
    await this.traiter(id, site, voulu === 'claude' || voulu === 'chatgpt' ? voulu : 'externe', true);
    return this.lire(site, id);
  }

  private async traiter(id: string, site: SiteRow, depart: NomCerveau | 'externe', relaisAccepte = false): Promise<void> {
    const { rubriques, versions } = this.contexte(site);
    if (!rubriques.length) return this.finir(id, 'impossible', { raison: 'Ce site n’a pas de contenus modifiables par formulaire : l’assistant n’a rien sur quoi travailler.' });
    const demande = (this.ctx.db.prepare('SELECT demande FROM ia_propositions WHERE id = ?').get(id) as { demande: string }).demande;
    const taille = JSON.stringify(rubriques).length + demande.length;
    const cerveaux = this.cerveauxActifs();
    let raisonRelais: string | null = null;

    // 1. Modèles locaux, dans l'ordre choisi, sauf si la tâche leur échappe d'emblée.
    if (depart === 'local') {
      const locaux = Object.keys(cerveaux).filter(estLocal);
      if (!locaux.length) raisonRelais = 'aucun modèle local n’est en service';
      const raisons: string[] = [];
      for (const cle of locaux) {
        const local = cerveaux[cle];
        const nomL = capitale(this.libelle(cle));
        if (taille > local.tailleMax) {
          this.noter(id, `${nomL} : demande trop volumineuse pour ce modèle.`);
          raisons.push('demande trop volumineuse');
          continue;
        }
        if (!(await local.disponible().catch(() => false))) {
          this.noter(id, `${nomL} ne répond pas.`);
          raisons.push('modèle qui ne répond pas');
          continue;
        }
        let corrections: string[] | undefined;
        for (let essai = 1; essai <= ESSAIS_LOCAUX; essai++) {
          const r = await this.appeler(local, { demande, rubriques, corrections });
          if (r.erreur) {
            this.noter(id, `${nomL} : ${r.erreur}.`);
            raisons.push(r.erreur);
            break;
          }
          if (r.reponse!.statut === 'impossible') {
            this.noter(id, `${nomL} : « je ne sais pas faire » (${r.reponse!.raison}).`);
            raisons.push('« je ne sais pas faire »');
            break;
          }
          const v = this.verifier(r.reponse!.changements, rubriques, versions);
          if (v.ok) return this.finir(id, 'proposee', { cerveau: cle, explication: r.reponse!.explication, changements: v.changements, site });
          this.noter(id, `${nomL}, essai ${essai} : proposition refusée par les vérifications (${v.erreurs.join(' ; ')}).`);
          corrections = v.erreurs;
          if (essai === ESSAIS_LOCAUX) raisons.push('propositions refusées par les vérifications');
        }
      }
      if (locaux.length) {
        const unique = [...new Set(raisons)];
        raisonRelais =
          locaux.length === 1
            ? `le modèle local n’a pas abouti (${unique.join(', ')})`
            : `aucun des ${locaux.length} modèles locaux n’a abouti (${unique.join(', ')})`;
        // Formulations historiques, gardées pour les cas simples.
        if (locaux.length === 1 && unique.length === 1) {
          if (unique[0] === 'demande trop volumineuse') raisonRelais = 'la demande est trop volumineuse pour le modèle local';
          else if (unique[0] === 'modèle qui ne répond pas') raisonRelais = 'le modèle local ne répond pas';
          else if (unique[0] === '« je ne sais pas faire »') raisonRelais = 'le modèle local ne sait pas faire cette demande';
          else if (unique[0] === 'propositions refusées par les vérifications') raisonRelais = 'les propositions du modèle local ne passent pas les vérifications';
          else raisonRelais = `le modèle local a échoué (${unique[0]})`;
        }
      }
      this.noter(id, `Relais envisagé vers une IA extérieure : ${raisonRelais}.`);
    }

    // 2. IA extérieures, dans l'ordre choisi, selon les règles du propriétaire.
    const reg = this.reglages();
    const candidates: NomExterne[] = depart === 'claude' || depart === 'chatgpt' ? [depart] : reg.ordre;
    const blocages: string[] = [];
    const possibles: NomExterne[] = [];
    if (reg.relaisExterne === 'jamais') blocages.push('le relais vers les IA extérieures est désactivé dans les réglages');
    else {
      for (const nom of candidates) {
        const c = cerveaux[nom];
        if (!c) {
          blocages.push(`${LIBELLE[nom]} n’est pas en service`);
          continue;
        }
        const estimation = c.estimer?.({ demande, rubriques }) ?? 0;
        const plafondService = reg[nom].plafondCentimes;
        const depasse = (depense: number, plafond: number) => depense >= plafond || depense + estimation > plafond;
        if (depasse(this.depenseDuMois(), reg.plafondMensuelCentimes)) {
          blocages.push(`le plafond mensuel global serait dépassé (${euros(reg.plafondMensuelCentimes)})`);
          continue;
        }
        if (plafondService !== null && depasse(this.depenseDuMois(nom), plafondService)) {
          blocages.push(`le plafond de ${LIBELLE[nom]} serait dépassé (${euros(plafondService)})`);
          continue;
        }
        possibles.push(nom);
      }
    }
    if (!possibles.length) {
      return this.finir(id, 'impossible', {
        raison: `${raisonRelais ? `${capitale(raisonRelais)}, et ` : ''}${[...new Set(blocages)].join(', ')}. Rien n’a été modifié ; vous pouvez faire la modification vous-même dans « Contenus ».`,
      });
    }
    if (reg.relaisExterne === 'demander' && !relaisAccepte) {
      if (depart === 'claude' || depart === 'chatgpt') this.ctx.db.prepare('UPDATE ia_propositions SET cerveau = ? WHERE id = ?').run(depart, id);
      return this.finir(id, 'accord_requis', {
        raison: `${capitale(raisonRelais ?? `vous avez demandé ${LIBELLE[possibles[0]]}`)}. Passer la demande à ${LIBELLE[possibles[0]]} ? (contenus publics du site uniquement, payant)`,
      });
    }
    let derniere = '';
    for (const nom of possibles) {
      const c = cerveaux[nom]!;
      const nomL = capitale(LIBELLE[nom]);
      const r = await this.appeler(c, { demande, rubriques });
      if (r.cout) this.compter(id, nom, r.cout);
      if (r.erreur) {
        this.noter(id, `${nomL} n’a pas pu répondre (${r.erreur}).`);
        derniere = `${nomL} n’a pas pu répondre (${r.erreur})`;
        continue;
      }
      if (r.reponse!.statut === 'impossible') {
        this.noter(id, `${nomL} : « je ne sais pas faire » (${r.reponse!.raison}).`);
        derniere = `${nomL} ne sait pas faire cette demande : ${r.reponse!.raison}`;
        continue;
      }
      const v = this.verifier(r.reponse!.changements, rubriques, versions);
      if (!v.ok) {
        this.noter(id, `${nomL} : proposition refusée par les vérifications (${v.erreurs.join(' ; ')}).`);
        derniere = `la proposition de ${LIBELLE[nom]} ne passe pas les vérifications de PAGINITY`;
        continue;
      }
      return this.finir(id, 'proposee', { cerveau: nom, explication: r.reponse!.explication, changements: v.changements, site });
    }
    return this.finir(id, 'impossible', { raison: `${capitale(derniere)}. Rien n’a été modifié.` });
  }

  /** Appel protégé : délai maximal, arrêt d'urgence, réponse de forme inattendue. */
  private async appeler(c: Cerveau, d: DemandeCerveau): Promise<{ reponse?: ReponseCerveau; erreur?: string; cout?: number }> {
    const ctl = new AbortController();
    this.enVol.add(ctl);
    let minuteur: NodeJS.Timeout | undefined;
    try {
      const delai = new Promise<never>((_, rej) => {
        minuteur = setTimeout(() => {
          ctl.abort();
          rej(new Error('temps de réponse dépassé'));
        }, c.delaiMs);
      });
      const arret = new Promise<never>((_, rej) => ctl.signal.addEventListener('abort', () => rej(new Error(this.reglages().active ? 'temps de réponse dépassé' : 'arrêt d’urgence'))));
      const reponse = await Promise.race([c.proposer(structuredClone(d), ctl.signal), delai, arret]);
      const cout = Math.max(0, Math.round(Number((reponse as { coutCentimes?: number })?.coutCentimes) || 0));
      if (!reponse || (reponse.statut !== 'proposition' && reponse.statut !== 'impossible')) return { erreur: 'réponse illisible', cout };
      if (reponse.statut === 'proposition' && !Array.isArray(reponse.changements)) return { erreur: 'réponse illisible', cout };
      return { reponse, cout };
    } catch (e) {
      const cout = Math.max(0, Math.round(Number((e as { coutCentimes?: number })?.coutCentimes) || 0));
      return { erreur: (e as Error).message || 'erreur', cout };
    } finally {
      clearTimeout(minuteur);
      this.enVol.delete(ctl);
    }
  }

  /** Les mêmes règles que les formulaires : rubrique proposée au cerveau, champs valides, vraie modification. */
  private verifier(chg: { rubrique: string; valeur: unknown }[], rubriques: RubriqueContexte[], versions: Record<string, string | null>) {
    const erreurs: string[] = [];
    const changements: Changement[] = [];
    if (!chg.length) erreurs.push('aucune modification proposée');
    const vues = new Set<string>();
    for (const c of chg) {
      const r = rubriques.find((x) => x.nom === c?.rubrique);
      if (!r) {
        erreurs.push(`rubrique inconnue « ${String(c?.rubrique).slice(0, 60)} »`);
        continue;
      }
      if (vues.has(r.nom)) {
        erreurs.push(`rubrique « ${r.libelle} » proposée deux fois`);
        continue;
      }
      vues.add(r.nom);
      const errs = validateEntryValue({ name: r.nom, label: r.libelle, type: 'file', path: '', format: 'json', list: r.liste, fields: r.champs }, c.valeur);
      for (const e of errs) erreurs.push(`${r.libelle} : ${e.message}`);
      if (JSON.stringify(c.valeur) === JSON.stringify(r.valeur)) erreurs.push(`« ${r.libelle} » : rien ne change`);
      changements.push({ rubrique: r.nom, libelle: r.libelle, versionBase: versions[r.nom] ?? null, avant: r.valeur, apres: c.valeur });
    }
    return erreurs.length ? { ok: false as const, erreurs: erreurs.slice(0, 10) } : { ok: true as const, changements };
  }

  private compter(id: string, nom: NomExterne, centimes: number) {
    this.ctx.db.prepare('INSERT INTO ia_usage (mois, at, proposition_id, centimes, fournisseur) VALUES (?, ?, ?, ?, ?)').run(mois(), now(), id, centimes, nom);
    this.ctx.db.prepare('UPDATE ia_propositions SET cout_centimes = cout_centimes + ? WHERE id = ?').run(centimes, id);
  }

  private noter(id: string, texte: string) {
    const row = this.ctx.db.prepare('SELECT journal FROM ia_propositions WHERE id = ?').get(id) as { journal: string };
    const j = JSON.parse(row.journal) as { le: number; texte: string }[];
    j.push({ le: now(), texte: texte.slice(0, 500) });
    this.ctx.db.prepare('UPDATE ia_propositions SET journal = ? WHERE id = ?').run(JSON.stringify(j), id);
  }

  private finir(
    id: string,
    statut: StatutProposition,
    o: { cerveau?: NomCerveau; explication?: string; raison?: string; changements?: Changement[]; site?: SiteRow },
  ): void {
    // L'empreinte lie l'accord à CETTE proposition précise (site, versions de départ, valeurs proposées).
    const empreinte = o.changements
      ? crypto.createHash('sha256').update(JSON.stringify({ id, site: o.site?.id, changements: o.changements.map((c) => [c.rubrique, c.versionBase, c.apres]) })).digest('hex').slice(0, 32)
      : null;
    this.ctx.db
      .prepare('UPDATE ia_propositions SET statut = ?, cerveau = COALESCE(?, cerveau), explication = ?, raison = ?, changements = ?, empreinte = ? WHERE id = ?')
      .run(statut, o.cerveau ?? null, o.explication?.slice(0, 2000) ?? null, o.raison ?? null, o.changements ? JSON.stringify(o.changements) : null, empreinte, id);
    if (o.raison) this.noter(id, o.raison);
  }

  // ------------------------------------------------------------------ décision humaine
  async accepter(site: SiteRow, user: UserRow, id: string, empreinte: unknown) {
    const p = this.ligne(site, id);
    if (!this.reglages().active) throw new UserError(409, 'L’assistant est désactivé : la proposition ne peut plus être acceptée.');
    if (p.statut !== 'proposee') throw new UserError(409, 'Cette proposition ne peut pas (ou plus) être acceptée.');
    if (typeof empreinte !== 'string' || empreinte !== p.empreinte) throw new UserError(409, 'Cette validation ne correspond pas à la proposition affichée. Rechargez-la.');
    const changements = JSON.parse(p.changements!) as Changement[];
    // Si une rubrique a changé depuis la proposition, l'accord ne vaut plus.
    const { versions } = this.contexte(site);
    if (changements.some((c) => (versions[c.rubrique] ?? null) !== c.versionBase)) {
      this.finir(id, 'perimee', { raison: 'Les contenus ont été modifiés depuis la proposition : elle n’est plus valable. Refaites la demande.' });
      throw new UserError(409, 'Les contenus ont été modifiés depuis la proposition : elle n’est plus valable. Refaites la demande.');
    }
    for (const c of changements) await saveEntry(this.ctx, site, user, c.rubrique, c.apres, c.versionBase);
    this.ctx.db.prepare("UPDATE ia_propositions SET statut = 'acceptee', decide_le = ? WHERE id = ?").run(now(), id);
    this.noter(id, `Acceptée par ${user.name} : enregistrée dans le brouillon (pas encore publiée).`);
    audit(this.ctx.db, { userId: user.id, action: 'ia_acceptee', siteId: site.id, details: { id, cerveau: p.cerveau, rubriques: changements.map((c) => c.rubrique) } });
    return this.lire(site, id);
  }

  refuser(site: SiteRow, user: UserRow, id: string) {
    const p = this.ligne(site, id);
    if (!['proposee', 'accord_requis'].includes(p.statut)) throw new UserError(409, 'Cette proposition est déjà terminée.');
    this.ctx.db.prepare("UPDATE ia_propositions SET statut = 'refusee', decide_le = ? WHERE id = ?").run(now(), id);
    this.noter(id, `Refusée par ${user.name}. Rien n’a été modifié.`);
    audit(this.ctx.db, { userId: user.id, action: 'ia_refusee', siteId: site.id, details: { id } });
    return this.lire(site, id);
  }

  // ------------------------------------------------------------------ lecture
  private ligne(site: SiteRow, id: string): LigneProposition {
    const p = this.ctx.db.prepare('SELECT * FROM ia_propositions WHERE id = ? AND site_id = ?').get(id, site.id) as LigneProposition | undefined;
    if (!p) throw new UserError(404, 'Proposition introuvable.');
    return p;
  }

  lire(site: SiteRow, id: string) {
    const p = this.ligne(site, id);
    return {
      id: p.id,
      demande: p.demande,
      statut: p.statut,
      cerveau: p.cerveau,
      cerveauLibelle: p.cerveau ? capitale(this.libelle(p.cerveau)) : null,
      explication: p.explication,
      raison: p.raison,
      changements: p.changements ? (JSON.parse(p.changements) as Changement[]).map(({ versionBase: _v, ...c }) => c) : [],
      empreinte: p.statut === 'proposee' ? p.empreinte : null,
      coutCentimes: p.cout_centimes,
      journal: JSON.parse(p.journal) as { le: number; texte: string }[],
      creeLe: p.cree_le,
    };
  }

  liste(site: SiteRow) {
    const ids = this.ctx.db.prepare('SELECT id FROM ia_propositions WHERE site_id = ? ORDER BY cree_le DESC LIMIT 50').all(site.id) as { id: string }[];
    return ids.map((r) => this.lire(site, r.id));
  }

  /** Au démarrage : une demande restée « en cours » (arrêt du serveur) est marquée interrompue. */
  reprise(): void {
    this.ctx.db.prepare("UPDATE ia_propositions SET statut = 'interrompue' WHERE statut = 'en_cours'").run();
  }
}

/** Montant en devise de facturation des services (dollars US chez Anthropic et OpenAI). */
function euros(c: number): string {
  return `${(c / 100).toFixed(2).replace('.', ',')} $`;
}

function capitale(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
