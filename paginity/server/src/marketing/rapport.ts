import type { Ctx } from '../context.js';
import type { SiteRow } from '../sites/service.js';
import { lireVisites } from '../sites/visites.js';
import { jourLocal } from '../lib/fuseau.js';
import { now } from '../lib/util.js';
import type { Constat, ResultatAudit } from './audit.js';

/**
 * Rapport mensuel de référencement, en langage simple, à partir de ce que PAGINITY sait VRAIMENT :
 * audits (brouillon / en ligne), contrôle en ligne, Search Console si elle est reliée, visites comptées sans cookies.
 * Aucune note inventée, aucune promesse de position : des faits, leur évolution et trois conseils au plus.
 */
export interface RapportMensuel {
  le: number;
  mois: string;
  site: string;
  sections: { titre: string; lignes: string[] }[];
}

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const nomMois = (aaaaMm: string) => `${MOIS[Number(aaaaMm.slice(5, 7)) - 1]} ${aaaaMm.slice(0, 4)}`;
const nb = (x: number) => x.toLocaleString('fr-FR');
const cle = (c: Constat) => `${c.regle}|${c.page ?? ''}|${c.message}`;

/** Mois couvert : le mois précédent si on est en début de mois (envoi du 1er), sinon le mois en cours (aperçu). */
export function moisCouvert(jour = jourLocal()): string {
  if (Number(jour.slice(8, 10)) <= 3) {
    const d = new Date(`${jour.slice(0, 7)}-01T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  }
  return jour.slice(0, 7);
}

export function rapportMensuel(ctx: Ctx, site: SiteRow, mois = moisCouvert()): RapportMensuel {
  const sections: RapportMensuel['sections'] = [];
  const debutMois = Date.parse(`${mois}-01T00:00:00Z`);
  const audits = ctx.db.prepare('SELECT cible, le, resultat FROM seo_audits WHERE site_id = ? ORDER BY le DESC').all(site.id) as { cible: string; le: number; resultat: string }[];

  // ---- Audit : la version en ligne si elle existe, sinon le brouillon.
  const cible = audits.some((a) => a.cible === 'en-ligne') ? 'en-ligne' : 'brouillon';
  const dernier = audits.find((a) => a.cible === cible);
  const avant = audits.find((a) => a.cible === cible && a.le < debutMois);
  const conseils: Constat[] = [];
  if (!dernier) sections.push({ titre: 'Audit du site', lignes: ['Aucun audit pour l’instant : lancez-en un dans « Référencement ».'] });
  else {
    const r = JSON.parse(dernier.resultat) as ResultatAudit;
    const n = (x: string) => r.constats.filter((c) => c.niveau === x).length;
    const lignes = [
      `Dernier audit (${cible === 'en-ligne' ? 'site en ligne' : 'brouillon'}) du ${new Date(dernier.le).toLocaleDateString('fr-FR')} : ${n('probleme')} problème(s), ${n('attention')} point(s) à améliorer, ${n('info')} information(s), sur ${r.pagesIndexables} page(s) destinée(s) aux moteurs.`,
    ];
    if (avant) {
      const a = JSON.parse(avant.resultat) as ResultatAudit;
      const ancien = new Set(a.constats.map(cle));
      const actuel = new Set(r.constats.map(cle));
      const corriges = a.constats.filter((c) => c.niveau !== 'info' && !actuel.has(cle(c))).length;
      const nouveaux = r.constats.filter((c) => c.niveau !== 'info' && !ancien.has(cle(c))).length;
      lignes.push(`Depuis le début du mois : ${corriges} point(s) corrigé(s), ${nouveaux} nouveau(x).`);
    }
    if (r.verifie.length) lignes.push(`Vérifié et correct : ${r.verifie.slice(0, 4).join(' ; ')}${r.verifie.length > 4 ? '…' : ''}.`);
    sections.push({ titre: 'Audit du site', lignes });
    conseils.push(...r.constats.filter((c) => c.niveau === 'probleme'), ...r.constats.filter((c) => c.niveau === 'attention'));
  }

  // ---- Contrôle en ligne (s'il a été fait depuis un mois)
  const controle = audits.find((a) => a.cible === 'controle');
  if (controle && now() - controle.le < 31 * 86_400_000) {
    const r = JSON.parse(controle.resultat) as ResultatAudit;
    const morts = r.constats.filter((c) => c.regle === 'lien-externe-casse').length;
    const erreurs = r.constats.filter((c) => c.regle === 'en-ligne-erreur' || c.regle === 'en-ligne-injoignable').length;
    sections.push({
      titre: 'Contrôle du site en ligne',
      lignes: [`Contrôle du ${new Date(controle.le).toLocaleDateString('fr-FR')} : ${erreurs} page(s) en erreur, ${morts} lien(s) vers d’autres sites cassé(s).`],
    });
    conseils.push(...r.constats.filter((c) => c.niveau !== 'info'));
  }

  // ---- Google (Search Console), seulement si le site est relié
  const gsc = ctx.searchConsole.lire(site);
  if (gsc.propriete && gsc.rapport) sections.push({ titre: 'Dans Google (Search Console)', lignes: [...gsc.rapport.redaction.phrases, ...gsc.rapport.redaction.pistes.map((p) => `Piste : ${p}`)] });
  else sections.push({ titre: 'Dans Google (Search Console)', lignes: ['Site non relié à Search Console : PAGINITY ne connaît pas les apparitions dans Google.'] });

  // ---- Visites (comptées par PAGINITY, sans cookies)
  const v = lireVisites(ctx, site, 30);
  sections.push({
    titre: 'Visites (30 derniers jours, sans cookies)',
    lignes: [v.total ? `${nb(v.total)} page(s) vue(s). Les plus vues : ${v.pages.slice(0, 3).map((p) => `${p.chemin} (${nb(p.vues)})`).join(', ')}.` : 'Aucune visite comptée (site pas encore servi par PAGINITY, ou pas de visite).'],
  });

  // ---- Conseils : trois au plus, les plus importants d'abord
  const vus = new Set<string>();
  const top = conseils.filter((c) => !vus.has(c.regle) && vus.add(c.regle)).slice(0, 3);
  sections.push({ titre: 'Ce que je vous conseille ce mois-ci', lignes: top.length ? top.map((c) => `${c.message} → ${c.conseil}`) : ['Rien d’urgent : continuez à tenir les informations à jour (horaires, tarifs, photos).'] });

  return { le: now(), mois, site: site.name, sections };
}

/** Texte brut (e-mail). */
export function texteRapport(r: RapportMensuel): string {
  return [
    `Rapport de référencement — ${r.site} — ${nomMois(r.mois)}`,
    '',
    ...r.sections.flatMap((s) => [s.titre.toUpperCase(), ...s.lignes.map((l) => `• ${l}`), '']),
    'Ce rapport décrit des faits vérifiés par PAGINITY ; il ne promet aucune position dans Google.',
    'Détails et corrections : PAGINITY › votre site › Référencement.',
  ].join('\n');
}

export const titreRapport = (r: RapportMensuel) => `PAGINITY — Référencement de « ${r.site} » : rapport de ${nomMois(r.mois)}`;
