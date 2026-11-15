export interface Utilisateur {
  id: string;
  email: string;
  nom: string;
  proprietaire: boolean;
  doubleAuthentification: { totp: boolean; passkey: boolean; codesSecoursRestants: number };
}

export interface Etat {
  installation: boolean;
  connecte: boolean;
  configurer2fa?: boolean;
  utilisateur?: Utilisateur;
  csrf: string;
}

export type EtatSite = 'jamais_publie' | 'en_ligne' | 'modifications' | 'erreur';

export interface SiteResume {
  id: string;
  slug: string;
  nom: string;
  role: 'contributeur' | 'editeur' | 'admin_site' | 'proprietaire';
  roleLibelle: string;
  urls: { test: string; apercu: string; domaines: string[] };
  etat: EtatSite;
  modificationsEnAttente: number;
  enLigne: { numero: number; le: number } | null;
  dernierePublication: { numero: number; le: number; etat: string } | null;
  creeLe: number;
}

export interface SiteDetail extends SiteResume {
  domainesConfigures: string[];
  fiche: { dossierPublie: string; preparation: string | null; fonctions: string | null; source: string; remarques: string[] };
  contenus: { source: string; nombre: number };
  droits: { publier: boolean; code: boolean; reglages: boolean; supprimer: boolean };
}

export interface Etape {
  nom: string;
  etat: 'a_faire' | 'en_cours' | 'reussi' | 'echoue' | 'ignore';
  message?: string;
  debut?: number;
  fin?: number;
}

export interface Activite {
  id: string;
  type: string;
  libelle: string;
  siteId: string | null;
  utilisateur: string | null;
  etat: 'en_attente' | 'en_cours' | 'reussie' | 'echouee' | 'interrompue';
  etapes: Etape[];
  resultat: any;
  erreur: string | null;
  creeLe: number;
  debutLe: number | null;
  finLe: number | null;
}

export interface Champ {
  name: string;
  label: string;
  description?: string;
  type: 'string' | 'text' | 'number' | 'boolean' | 'date' | 'select' | 'image' | 'file' | 'object';
  required: boolean;
  list: null | { min?: number; max?: number };
  fields?: Champ[];
  options?: { values: { label: string; value: string }[]; multiple?: boolean };
  pattern?: { regex: string; message?: string };
  min?: number;
  max?: number;
  minlength?: number;
  maxlength?: number;
  readonly?: boolean;
  hidden?: boolean;
  default?: unknown;
}

export interface Rubrique {
  name: string;
  label: string;
  description?: string;
  type: 'file' | 'collection';
  path: string;
  format: 'json' | 'yaml';
  list: boolean;
  fields: Champ[];
}

export interface MediaConfig {
  input: string;
  output: string;
}
