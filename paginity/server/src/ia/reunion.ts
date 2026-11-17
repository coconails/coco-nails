import type { Ctx } from '../context.js';
import type { SiteRow } from '../sites/service.js';
import type { Assistant } from './assistant.js';
import { DOMAINES, estLocal } from './types.js';
import type { Cerveau, Changement, DemandeCerveau, Domaine, NomExterne, RubriqueContexte } from './types.js';

const capitale = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Salle de réunion : un tour par IA.
 *  1. Le domaine de la demande est déterminé (ou choisi par vous).
 *  2. Le vérificateur final est l'IA la mieux notée dans ce domaine (ou celle que vous avez désignée).
 *  3. Les autres IA proposent chacune UNE fois ; PAGINITY vérifie chaque proposition.
 *  4. Le vérificateur reçoit toutes les propositions (anonymes, avec les remarques de PAGINITY) et rend la version finale.
 *  5. Si sa version ne passe pas les vérifications, la meilleure proposition valable des autres est retenue.
 * Les IA payantes ne participent qu'en mode « relais automatique », dans les plafonds.
 */
export async function tenirReunion(
a: Assistant,
ctx: Ctx,
id: string,
  site: SiteRow,
  demande: string,
  rubriques: RubriqueContexte[],
  versions: Record<string, string | null>,
  taille: number,
  cerveaux: Record<string, Cerveau>,
): Promise<{ fini: true } | { fini: false; raisonRelais: string }> {
  const reg = a.reglages();
  const info = JSON.parse((ctx.db.prepare('SELECT reunion FROM ia_propositions WHERE id = ?').get(id) as { reunion: string }).reunion);
  const domaine: Domaine = info.domaine;
  const base: DemandeCerveau = { demande, rubriques };
  // Membres possibles : modèles locaux en service et adaptés à la taille ; IA payantes seulement en relais automatique.
  const membres: string[] = [];
  for (const [cle, c] of Object.entries(cerveaux)) {
    if (estLocal(cle)) {
      if (taille <= c.tailleMax && (await c.disponible().catch(() => false))) membres.push(cle);
    } else if (reg.relaisExterne === 'auto' && a.budgetPermet(cle, c, base)) membres.push(cle);
  }
  if (!membres.length) return { fini: false, raisonRelais: 'aucune IA n’est disponible pour la réunion' };
  // Vérificateur final : désigné, sinon meilleure note, sinon premier de la liste.
  const eligibles = membres.filter((k) => estLocal(k) || reg.reunion.payantVerificateur);
  const designe = reg.reunion.verificateurs[domaine];
  let verificateur: string;
  let choix: string;
  if (designe && eligibles.includes(designe)) {
    verificateur = designe;
    choix = 'désigné dans les réglages';
  } else {
    const notes = eligibles.map((k) => ({ k, n: a.note(k, domaine) }));
    const notees = notes.filter((x) => x.n !== null).sort((a, b) => b.n! - a.n!);
    if (notees.length) {
      verificateur = notees[0].k;
      choix = `meilleure note dans ce domaine (${notees[0].n}/100)`;
    } else {
      verificateur = eligibles[0] ?? membres[0];
      choix = 'premier de la liste (pas encore de notes : lancez le banc d’essai)';
    }
  }
  const proposants = membres
    .filter((k) => k !== verificateur)
    .sort((x, y) => (a.note(y, domaine) ?? -1) - (a.note(x, domaine) ?? -1))
    .slice(0, reg.reunion.maxParticipants);
  a.noter(id, `Réunion — domaine : ${DOMAINES[domaine]}. Vérificateur final : ${a.libelle(verificateur)} (${choix}). Proposants : ${proposants.map((k) => a.libelle(k)).join(', ') || 'aucun'}.`);

  // Tour unique des proposants.
  const lettres = 'ABCDEFG';
  let question: { cle: string; texte: string } | null = null;
  const tour: { cle: string; auteur: string; statut: string; explication: string; changements?: Changement[]; brut?: { rubrique: string; valeur: unknown }[]; remarques: string[] }[] = [];
  for (const [i, cle] of proposants.entries()) {
    const c = cerveaux[cle];
    const auteur = `Proposition ${lettres[i]}`;
    if (!a.budgetPermet(cle, c, base)) {
      tour.push({ cle, auteur, statut: 'non sollicitée (plafond)', explication: '', remarques: [] });
      continue;
    }
    const r = await a.appeler(c, base);
    if (r.cout && !estLocal(cle)) a.compter(id, cle as NomExterne, r.cout);
    if (r.erreur) {
      tour.push({ cle, auteur, statut: `erreur (${r.erreur})`, explication: '', remarques: [] });
      continue;
    }
    if (r.reponse!.statut === 'question') {
      question ??= { cle, texte: r.reponse!.question };
      tour.push({ cle, auteur, statut: 'demande une précision', explication: r.reponse!.question, remarques: [] });
      continue;
    }
    if (r.reponse!.statut === 'impossible') {
      tour.push({ cle, auteur, statut: '« je ne sais pas faire »', explication: r.reponse!.raison, remarques: [] });
      continue;
    }
    const v = a.verifier(r.reponse!.changements, rubriques, versions);
    tour.push({
      cle,
      auteur,
      statut: v.ok ? 'valable' : 'refusée par les vérifications',
      explication: r.reponse!.explication,
      changements: v.ok ? v.changements : undefined,
      brut: r.reponse!.changements,
      remarques: v.ok ? [] : v.erreurs,
    });
  }
  for (const t of tour) a.noter(id, `${t.auteur} — ${capitale(a.libelle(t.cle))} : ${t.statut}${t.remarques.length ? ` (${t.remarques.join(' ; ')})` : ''}.`);

  // Le vérificateur final, en dernier.
  const autres = tour
    .filter((t) => t.brut)
    .map((t) => ({ auteur: t.auteur, valide: !!t.changements, remarques: t.remarques, explication: t.explication, changements: t.brut! }));
  const c = cerveaux[verificateur];
  let finale: { changements: Changement[]; explication: string } | null = null;
  let statutVerif = '';
  if (!a.budgetPermet(verificateur, c, base)) statutVerif = 'non sollicité (plafond)';
  else {
    const r = await a.appeler(c, { ...base, propositionsAutres: autres });
    if (r.cout && !estLocal(verificateur)) a.compter(id, verificateur as NomExterne, r.cout);
    if (r.erreur) statutVerif = `erreur (${r.erreur})`;
    else if (r.reponse!.statut === 'impossible') statutVerif = `« je ne sais pas faire » (${r.reponse!.raison})`;
    else if (r.reponse!.statut === 'question') {
      question = { cle: verificateur, texte: r.reponse!.question };
      statutVerif = `demande une précision (${r.reponse!.question})`;
    }
    else {
      const v = a.verifier(r.reponse!.changements, rubriques, versions);
      if (v.ok) {
        finale = { changements: v.changements, explication: r.reponse!.explication };
        statutVerif = 'version finale valable';
      } else statutVerif = `version finale refusée par les vérifications (${v.erreurs.join(' ; ')})`;
    }
  }
  a.noter(id, `Vérificateur final — ${capitale(a.libelle(verificateur))} : ${statutVerif}.`);
  const resume = {
    ...info,
    verificateur,
    choixVerificateur: choix,
    participants: tour.map((t) => ({ cle: t.cle, auteur: t.auteur, statut: t.statut, explication: t.explication, changements: t.changements?.map(({ versionBase: _v, ...x }) => x) ?? [] })),
    statutVerificateur: statutVerif,
  };
  ctx.db.prepare('UPDATE ia_propositions SET reunion = ? WHERE id = ?').run(JSON.stringify(resume), id);
  if (finale) {
    a.finir(id, 'proposee', { cerveau: verificateur, explication: finale.explication, changements: finale.changements, site });
    return { fini: true };
  }
  // Repli : la meilleure proposition valable des autres (meilleure note du domaine).
  const valables = tour.filter((t) => t.changements).sort((x, y) => (a.note(y.cle, domaine) ?? -1) - (a.note(x.cle, domaine) ?? -1));
  if (valables.length) {
    const t = valables[0];
    a.noter(id, `Le vérificateur final n’a pas abouti : la ${t.auteur.toLowerCase()} (${a.libelle(t.cle)}), valable, est retenue.`);
    a.finir(id, 'proposee', { cerveau: t.cle, explication: t.explication, changements: t.changements!, site });
    return { fini: true };
  }
  if (question) {
    a.finir(id, 'question', { cerveau: question.cle, raison: question.texte.slice(0, 300) });
    return { fini: true };
  }
  return { fini: false, raisonRelais: 'la réunion n’a produit aucune proposition valable' };
}
