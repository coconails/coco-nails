import type { Constat } from './audit.js';

/**
 * Correction assistée d'un constat de l'audit : PAGINITY rédige la demande, l'assistant (portée « pages et styles »)
 * prépare une proposition, que PAGINITY vérifie (pas de noindex ajouté, adresse canonique inchangée, données
 * structurées lisibles, aucun téléphone ni prix inventé…) et que la personne accepte ou refuse.
 * Après acceptation, l'audit du brouillon est refait pour montrer si le constat a bien disparu.
 * Rien n'est jamais publié automatiquement.
 *
 * Seuls les constats qu'on peut corriger dans le HTML d'une page, SANS inventer d'information, sont proposés.
 */
const CONSIGNES: Record<string, string> = {
  'titre-absent': 'Ajoute un titre <title> qui décrit la page (activité et lieu tels qu’ils figurent déjà sur la page).',
  'titre-court': 'Allonge le titre <title> avec l’activité et le lieu tels qu’ils figurent déjà sur la page.',
  'titre-long': 'Raccourcis le titre <title> vers 60 caractères en gardant l’essentiel au début.',
  'titre-modele': 'Remplace le texte de modèle du titre <title> par le vrai nom du site tel qu’il figure sur la page.',
  'titre-double': 'Rends le titre <title> de cette page propre à son sujet.',
  'description-absente': 'Ajoute une balise <meta name="description"> qui résume la page en une ou deux phrases, avec seulement des informations déjà présentes sur la page.',
  'description-courte': 'Allonge la balise <meta name="description"> (environ 120 à 160 caractères) avec des informations déjà présentes sur la page.',
  'description-longue': 'Raccourcis la balise <meta name="description"> vers 150 caractères en gardant l’essentiel.',
  'description-modele': 'Remplace le texte de modèle de la balise <meta name="description"> par une vraie description tirée de la page.',
  'h1-absent': 'Transforme le titre visible principal de la page en <h1> (ou ajoute un <h1> reprenant le titre existant), sans changer l’apparence.',
  'h1-multiple': 'Garde un seul <h1> (le titre principal) et transforme les autres en <h2>, sans changer l’apparence.',
  'intertitres-hierarchie': 'Remets les intertitres dans l’ordre (h1, puis h2, puis h3…) sans sauter de niveau, sans changer l’apparence (ajuste le CSS si besoin).',
  'intertitre-vide': 'Retire les intertitres vides (<h1> à <h6> sans texte).',
  langue: 'Ajoute lang="fr" à la balise <html>.',
  viewport: 'Ajoute <meta name="viewport" content="width=device-width, initial-scale=1"> dans le <head>.',
  opengraph: 'Complète les balises Open Graph manquantes (og:title, og:description, og:image) avec le titre, la description et une image DÉJÀ présents sur la page.',
  'image-sans-alt': 'Ajoute un attribut alt aux images qui n’en ont pas : une courte description si l’image montre quelque chose d’utile (d’après son nom de fichier et le texte voisin), alt="" si elle est décorative.',
  'lien-casse': 'Corrige ou retire le lien qui mène à une page inexistante (garde le texte, retire seulement le lien si aucune page existante ne correspond).',
  'page-orpheline': 'Ajoute, sur la page d’accueil, un lien discret vers cette page (dans le menu ou le pied de page, avec le style existant).',
};

export const regleCorrigeable = (regle: string) => regle in CONSIGNES;

/** Texte de la demande envoyée à l'assistant pour un constat. */
export function demandeDepuisConstat(c: Constat): string {
  const ou = c.page ? ` (page ${c.page.slice(0, 120)})` : '';
  return [
    `Correction de référencement demandée depuis l’audit${ou}.`,
    `Constat : ${c.message}`,
    `À faire : ${CONSIGNES[c.regle]}`,
    'Corrige uniquement ce point, sans rien changer d’autre (design, textes, structure). N’invente aucune information : ni prix, ni téléphone, ni horaire, ni avis, ni adresse ; utilise seulement ce qui est déjà sur le site.',
  ]
    .join('\n')
    .slice(0, 1900);
}
