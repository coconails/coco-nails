import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../context.js';
import type { SiteRow } from '../sites/service.js';
import { currentVersion, readText, validateText } from '../sites/files.js';
import { readManifest } from '../sites/manifest.js';
import { isServerCode } from '../sites/server-code.js';
import type { RubriqueContexte } from './assistant.js';

/**
 * Assistant « pages et styles » : l'IA peut proposer des modifications de fichiers HTML et CSS du site (jamais le
 * JavaScript, le code serveur ni les réglages). Mêmes principes que pour les contenus : proposition seulement,
 * vérifications de PAGINITY, accord de la personne, écriture dans le brouillon. Vérifications propres aux fichiers :
 * pas de nouveau <script>, pas de nouvel attribut « on… », pas de « javascript: », pas d'adresse d'un nouveau site.
 */
export const PREFIXE = 'fichier:';
const EXT = new Set(['html', 'htm', 'css']);
const MAX_FICHIER = 120_000;
const MAX_TOTAL = 400_000;

export const estFichier = (rubrique: string) => rubrique.startsWith(PREFIXE);

/** Les fichiers HTML et CSS publiés du site, comme « rubriques » (contenu texte complet). */
export function contexteFichiers(ctx: Ctx, site: SiteRow): { rubriques: RubriqueContexte[]; versions: Record<string, string | null> } {
  const repo = ctx.sites.repoDir(site);
  let pub = '';
  try {
    const m = readManifest(repo);
    pub = m.publishDir === '.' ? '' : m.publishDir;
  } catch {
    /* pas de manifeste : racine */
  }
  const fichiers: string[] = [];
  const parcourir = (rel: string) => {
    const abs = path.join(repo, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) parcourir(r);
      else if (e.isFile() && EXT.has(path.extname(e.name).slice(1).toLowerCase())) fichiers.push(r);
    }
  };
  parcourir(pub);
  const rubriques: RubriqueContexte[] = [];
  const versions: Record<string, string | null> = {};
  let total = 0;
  for (const rel of fichiers.sort((a, b) => (a.endsWith('index.html') ? -1 : b.endsWith('index.html') ? 1 : a.localeCompare(b)))) {
    if (isServerCode(ctx, site, rel)) continue;
    const f = readText(repo, rel);
    if (f.content.length > MAX_FICHIER || total + f.content.length > MAX_TOTAL) continue;
    total += f.content.length;
    rubriques.push({ nom: `${PREFIXE}${rel}`, libelle: rel, champs: [], liste: false, valeur: f.content });
    versions[`${PREFIXE}${rel}`] = f.version;
  }
  return { rubriques, versions };
}

const compter = (s: string, re: RegExp) => (s.match(re) ?? []).length;
const hotes = (s: string) => new Set([...s.matchAll(/(?:https?:)?\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase()));

const robotsNoindex = (s: string) => /<meta\b[^>]*name\s*=\s*["']?(?:robots|googlebot)["']?[^>]*content\s*=\s*["'][^"']*(?:noindex|none)/i.test(s);
const canonicals = (s: string) => [...s.matchAll(/<link\b[^>]*rel\s*=\s*["']?canonical["']?[^>]*>/gi)].map((m) => /href\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1] ?? '').join('|');
const jsonLdIllisibles = (s: string) =>
  [...s.matchAll(/<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].filter((m) => {
    try {
      JSON.parse(m[1]);
      return false;
    } catch {
      return true;
    }
  }).length;
const sansBalises = (s: string) => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
/** Numéros de téléphone (France) et montants en euros d'un texte, normalisés. */
export function chiffresSensibles(s: string): Set<string> {
  const t = sansBalises(s);
  const tels = [...t.matchAll(/(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}/g)].map((m) => `tel:${m[0].replace(/\D/g, '').replace(/^33/, '0')}`);
  const prix = [...t.matchAll(/(\d+(?:[.,]\d{1,2})?)\s?(?:€|euros?\b)/gi)].map((m) => `prix:${Number(m[1].replace(',', '.'))}`);
  return new Set([...tels, ...prix]);
}

/**
 * Vérifications d'un fichier proposé ; renvoie les erreurs (vide = accepté).
 * `demande` : texte de la demande. Un téléphone ou un prix qui n'était ni dans le fichier ni dans la demande est
 * refusé (l'IA ne doit pas inventer de chiffres). Côté référencement, l'IA ne peut ni ajouter « noindex », ni changer
 * l'adresse canonique, ni casser les données structurées.
 */
export function verifierFichier(rel: string, avant: string, apres: unknown, demande?: string): string[] {
  if (typeof apres !== 'string') return [`${rel} : le contenu doit être le texte complet du fichier`];
  const e: string[] = [];
  if (!apres.trim()) e.push(`${rel} : fichier vidé`);
  if (apres.length > MAX_FICHIER) e.push(`${rel} : fichier trop long`);
  if (apres === avant) e.push(`« ${rel} » : rien ne change`);
  if (compter(apres, /<script\b/gi) > compter(avant, /<script\b/gi)) e.push(`${rel} : ajout d’un <script> refusé`);
  if (compter(apres, /\son[a-z]+\s*=/gi) > compter(avant, /\son[a-z]+\s*=/gi)) e.push(`${rel} : ajout d’un attribut « on… » (code) refusé`);
  if (/javascript:/i.test(apres) && !/javascript:/i.test(avant)) e.push(`${rel} : « javascript: » refusé`);
  const nouveaux = [...hotes(apres)].filter((h) => !hotes(avant).has(h));
  if (nouveaux.length) e.push(`${rel} : adresse d’un autre site ajoutée (${nouveaux.slice(0, 3).join(', ')}) refusée`);
  if (/\.html?$/i.test(rel) && /<html/i.test(avant) && !/<\/html>/i.test(apres)) e.push(`${rel} : page HTML incomplète (</html> manquant)`);
  if (robotsNoindex(apres) && !robotsNoindex(avant)) e.push(`${rel} : ajout de « noindex » refusé (la page disparaîtrait de Google)`);
  if (canonicals(apres) !== canonicals(avant)) e.push(`${rel} : modification de l’adresse canonique refusée`);
  if (jsonLdIllisibles(apres) > jsonLdIllisibles(avant)) e.push(`${rel} : données structurées (JSON-LD) rendues illisibles`);
  if (demande !== undefined) {
    const connus = new Set([...chiffresSensibles(avant), ...chiffresSensibles(demande)]);
    const inventes = [...chiffresSensibles(apres)].filter((x) => !connus.has(x));
    if (inventes.length) e.push(`${rel} : téléphone ou prix absent du site et de la demande (${inventes.slice(0, 3).map((x) => x.replace(/^\w+:/, '')).join(', ')}) refusé`);
  }
  if (/\.css$/i.test(rel) && compter(apres, /{/g) !== compter(apres, /}/g)) e.push(`${rel} : accolades déséquilibrées dans le CSS`);
  e.push(...validateText(rel, apres).map((x) => `${rel} : ${x}`));
  return e;
}

/** Version actuelle d'un fichier (pour détecter une modification entre la proposition et l'accord). */
export function versionFichier(ctx: Ctx, site: SiteRow, rubrique: string): string | null {
  return currentVersion(path.join(ctx.sites.repoDir(site), rubrique.slice(PREFIXE.length)));
}

/** Consignes ajoutées au message quand l'IA travaille sur des fichiers. */
export const CONSIGNES_PAGES = `MODE PAGES ET STYLES : les rubriques dont le nom commence par « fichier: » sont des fichiers HTML ou CSS du site. Pour modifier un fichier, renvoie dans « valeur_json » son CONTENU COMPLET encodé comme une chaîne JSON. Garde le design, la structure et tout ce qui n'est pas concerné par la demande, à l'identique. N'ajoute jamais de <script>, d'attribut « on… », de « javascript: » ni d'adresse d'un autre site : ce serait refusé.`;
