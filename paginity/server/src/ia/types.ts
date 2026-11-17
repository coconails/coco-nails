import type { Field } from '../content/schema.js';
import { now } from '../lib/util.js';
import { TARIFS_CLAUDE, type ConfigExterne, type ConfigLocalNomme } from './fournisseurs.js';

/**
 * PAGINITY AI — types, constantes et réglages par défaut partagés par l'assistant, la réunion d'IA et le banc d'essai.
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
  /** Salle de réunion : propositions des autres IA (anonymes), à vérifier par le vérificateur final. */
  propositionsAutres?: { auteur: string; valide: boolean; remarques: string[]; explication: string; changements: { rubrique: string; valeur: unknown }[] }[];
}

export type ReponseCerveau =
  | { statut: 'proposition'; changements: { rubrique: string; valeur: unknown }[]; explication: string; coutCentimes?: number }
  | { statut: 'impossible'; raison: string; coutCentimes?: number }
  /** Il manque une information : l'IA pose UNE question, la personne répond, la demande repart complétée. */
  | { statut: 'question'; question: string; coutCentimes?: number };

export interface Cerveau {
  nom: NomCerveau;
  /** Taille maximale du contexte (en caractères) que ce cerveau sait traiter. */
  tailleMax: number;
  /** Temps maximal d'une réponse. */
  delaiMs: number;
  disponible(): Promise<boolean>;
  proposer(d: DemandeCerveau, signal: AbortSignal): Promise<ReponseCerveau>;
  /** Nom affiché (facultatif ; sinon celui des réglages). */
  libelle?: string;
  /** Coût maximal (centimes) d'un appel, pour ne jamais dépasser un plafond. Absent = gratuit. */
  estimer?(d: DemandeCerveau): number;
  /** Explication en texte libre (diagnostic) : seulement pour les modèles locaux. */
  expliquer?(consignes: string, texte: string, signal: AbortSignal): Promise<string>;
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
  reunion: ReglagesReunion;
  /** Bouton « Dicter » (reconnaissance vocale du navigateur : la voix part chez Google ou Apple). */
  dictee: boolean;
}
export const REGLAGES_DEFAUT: ReglagesIA = {
  active: false,
  dictee: false,
  relaisExterne: 'demander',
  plafondMensuelCentimes: 0,
  ordre: ['claude', 'chatgpt'],
  locaux: [],
  claude: { actif: false, modele: 'claude-opus-5-5', prixEntree: TARIFS_CLAUDE['claude-opus-5-5'].entree, prixSortie: TARIFS_CLAUDE['claude-opus-5-5'].sortie, plafondCentimes: null, delaiS: 180, url: '' },
  chatgpt: { actif: false, modele: '', prixEntree: null, prixSortie: null, plafondCentimes: null, delaiS: 180, url: '' },
  reunion: { active: false, maxParticipants: 3, payantVerificateur: false, verificateurs: {} },
};
/** Domaines des demandes de contenu. */
export type Domaine = 'textes' | 'donnees';
export const DOMAINES: Record<Domaine, string> = { textes: 'Textes (accroche, présentation, FAQ…)', donnees: 'Données (tarifs, horaires, dates, coordonnées…)' };
/** Classement simple et prévisible : chiffres, prix, heures, dates, coordonnées → données ; sinon → textes. */
export function domaineDe(demande: string): Domaine {
  return /\d|€|euro|prix|tarif|horaire|heure|ouvert|ferm|congé|vacances|date|jour|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|téléphone|telephone|adresse|e-?mail|durée|minute/i.test(demande)
    ? 'donnees'
    : 'textes';
}

export interface ReglagesReunion {
  active: boolean;
  /** Nombre maximal d'IA qui proposent, en plus du vérificateur final. */
  maxParticipants: number;
  /** Une IA payante (si activée et dans les plafonds) peut-elle être le vérificateur final ? */
  payantVerificateur: boolean;
  /** Vérificateur imposé par domaine (sinon : meilleure note). */
  verificateurs: Partial<Record<Domaine, string>>;
}
export interface Note {
  banc: number | null;
  acceptes: number;
  refuses: number;
}

export const CLE: Record<NomExterne, string> = { claude: 'ia_cle_claude', chatgpt: 'ia_cle_chatgpt' };

export type StatutProposition = 'en_cours' | 'proposee' | 'accord_requis' | 'question' | 'repondue' | 'annulee' | 'impossible' | 'acceptee' | 'refusee' | 'perimee' | 'interrompue';

export interface Changement {
  rubrique: string;
  libelle: string;
  versionBase: string | null;
  avant: unknown;
  apres: unknown;
}

export interface LigneProposition {
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
  reunion: string | null;
  journal: string;
  cree_le: number;
  decide_le: number | null;
}

export const ESSAIS_LOCAUX = 2;
export const mois = (t = now()) => new Date(t).toISOString().slice(0, 7);
