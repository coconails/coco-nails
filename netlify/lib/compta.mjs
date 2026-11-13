// Comptabilité de Coco Nail's : rendez-vous à valider, factures et déclarations URSSAF.
// Tout est enregistré dans un tableau Google Sheets privé de Coralie, partagé (en « Éditeur »)
// avec le compte de service du site. Rien n'est stocké sur le site lui-même, qui est public.
import { createHmac, createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { jeton, SCOPE_TABLEAUX, listerRendezVous, aujourdhuiParis, decalageParis, instant, signer, signatureValide } from "./agenda.mjs";

const JOUR_MS = 86400000;

export const comptaConfiguree = () =>
  Boolean(process.env.COMPTA_SHEET_ID && process.env.COMPTA_MOT_DE_PASSE && process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY);

// Erreur à montrer telle quelle à Coralie.
export class Refus extends Error {
  constructor(message, statut = 400) { super(message); this.statut = statut; this.publique = true; }
}

// ---- Les onglets du tableau ----
export const ONGLET = { lignes: "Rendez-vous", factures: "Factures", declarations: "Déclarations URSSAF", reglages: "Réglages" };
const ENTETES = {
  lignes: ["N°", "État", "Origine", "Date du RDV", "Heure", "Cliente", "Téléphone", "E-mail", "Adresse", "Soin", "Options",
    "Prix du tarif", "Montant encaissé", "Paiement", "Payé le", "Facture", "Réf. agenda", "Note", "Créée le", "Modifiée le"],
  factures: ["N° de facture", "Date", "N° de ligne", "Cliente", "Montant", "Paiement", "Envois", "Contenu de la facture (ne pas modifier)"],
  declarations: ["Période", "Montant déclaré", "Déclaré le", "Nombre de factures"],
  reglages: ["Réglage", "Valeur"],
};
const CHAMPS_LIGNE = ["id", "etat", "origine", "date", "heure", "cliente", "telephone", "email", "adresse", "soin", "options",
  "tarif", "montant", "paiement", "paye_le", "facture", "rdv", "note", "cree", "modifie"];
const CHAMPS_FACTURE = ["numero", "date", "ligne", "cliente", "montant", "paiement", "envois", "contenu"];
const CHAMPS_DECLARATION = ["periode", "montant", "declare_le", "nb"];

export const ETATS = { attente: "À valider", validee: "Validée", annulee: "Annulée" };
export const ORIGINES = ["Site", "Téléphone", "Message"];

const colonne = (n) => String.fromCharCode(64 + n); // 1 -> A
const plage = (onglet, r) => encodeURIComponent(`'${onglet}'!${r}`);
const urlTableau = () => `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(process.env.COMPTA_SHEET_ID)}`;

async function tableau(chemin, { methode = "GET", corps } = {}) {
  const rep = await fetch(urlTableau() + chemin, {
    method: methode,
    headers: { Authorization: `Bearer ${await jeton(SCOPE_TABLEAUX)}`, ...(corps ? { "Content-Type": "application/json" } : {}) },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  if (rep.status === 403 || rep.status === 404)
    throw new Refus("Le tableau de compta est introuvable : vérifiez qu'il est bien partagé avec le compte de service du site (en Éditeur).", 503);
  if (!rep.ok) throw new Error(`Tableau de compta : erreur ${rep.status}`);
  return rep.json();
}

// Crée les onglets manquants (au tout premier usage) avec leur ligne de titres.
let pret = false;
async function preparer() {
  if (pret) return;
  const info = await tableau("?fields=sheets.properties.title");
  const existants = new Set((info.sheets || []).map((s) => s.properties.title));
  const manquants = Object.keys(ONGLET).filter((k) => !existants.has(ONGLET[k]));
  if (manquants.length) {
    await tableau(":batchUpdate", { methode: "POST", corps: { requests: manquants.map((k) => ({ addSheet: { properties: { title: ONGLET[k], gridProperties: { frozenRowCount: 1 } } } })) } });
    for (const k of manquants) {
      const lignes = [ENTETES[k]];
      if (k === "reglages") lignes.push(["depuis", aujourdhui().slice(0, 8) + "01"], ["periodicite", "mensuelle"]);
      await tableau(`/values/${plage(ONGLET[k], "A1")}?valueInputOption=RAW`, { methode: "PUT", corps: { values: lignes } });
    }
  }
  pret = true;
}

const texte = (v) => (v == null ? "" : String(v));
function versObjet(champs, rangee, rang) {
  const o = { _rang: rang };
  champs.forEach((c, i) => (o[c] = texte(rangee[i])));
  return o;
}
const versRangee = (champs, o) => champs.map((c) => (c === "montant" && o[c] !== "" && o[c] != null ? Number(o[c]) : texte(o[c])));

// Lit tout le tableau en une seule fois.
export async function lireTout() {
  await preparer();
  const q = Object.values(ONGLET).map((o) => "ranges=" + plage(o, "A2:" + colonne(ENTETES.lignes.length))).join("&");
  const d = await tableau(`/values:batchGet?${q}&valueRenderOption=UNFORMATTED_VALUE`);
  const [l, f, dc, r] = (d.valueRanges || []).map((v) => v.values || []);
  const garder = (rangee) => rangee && rangee.some((x) => texte(x).trim() !== "");
  const donnees = {
    lignes: (l || []).map((x, i) => garder(x) && versObjet(CHAMPS_LIGNE, x, i + 2)).filter(Boolean),
    factures: (f || []).map((x, i) => garder(x) && versObjet(CHAMPS_FACTURE, x, i + 2)).filter(Boolean),
    declarations: (dc || []).map((x, i) => garder(x) && versObjet(CHAMPS_DECLARATION, x, i + 2)).filter(Boolean),
    reglages: Object.fromEntries((r || []).filter(garder).map((x) => [texte(x[0]).trim(), texte(x[1]).trim()])),
  };
  donnees.reglages.periodicite = donnees.reglages.periodicite === "trimestrielle" ? "trimestrielle" : "mensuelle";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(donnees.reglages.depuis || "")) donnees.reglages.depuis = aujourdhui().slice(0, 8) + "01";
  await reparer(donnees);
  return donnees;
}

async function ajouterRangees(onglet, rangees) {
  if (!rangees.length) return;
  await tableau(`/values/${plage(onglet, "A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { methode: "POST", corps: { values: rangees } });
}
async function majRangee(onglet, champs, o) {
  await tableau(`/values/${plage(onglet, `A${o._rang}:${colonne(champs.length)}${o._rang}`)}?valueInputOption=RAW`, { methode: "PUT", corps: { values: [versRangee(champs, o)] } });
}
export const majLigne = (l) => (l.modifie = horodatage(), majRangee(ONGLET.lignes, CHAMPS_LIGNE, l));
export const majFacture = (f) => majRangee(ONGLET.factures, CHAMPS_FACTURE, f);
export async function nouvellesLignes(lignes, donnees) {
  const prochain = donnees.lignes.reduce((m, l) => Math.max(m, l._rang), 1) + 1;
  lignes.forEach((l, i) => { l._rang = prochain + i; l.cree = l.cree || horodatage(); l.modifie = l.cree; });
  await ajouterRangees(ONGLET.lignes, lignes.map((l) => versRangee(CHAMPS_LIGNE, l)));
  donnees.lignes.push(...lignes);
}
export async function majReglage(cle, valeur, donnees) {
  const r = await tableau(`/values/${plage(ONGLET.reglages, "A2:A")}`);
  const i = (r.values || []).findIndex((x) => texte(x[0]).trim() === cle);
  if (i >= 0) await tableau(`/values/${plage(ONGLET.reglages, `B${i + 2}`)}?valueInputOption=RAW`, { methode: "PUT", corps: { values: [[valeur]] } });
  else await ajouterRangees(ONGLET.reglages, [[cle, valeur]]);
  donnees.reglages[cle] = valeur;
}

// Si une facture a été enregistrée mais que sa ligne n'a pas été mise à jour (coupure au mauvais moment),
// on termine le travail : la facture fait foi.
async function reparer(donnees) {
  for (const f of donnees.factures) {
    const l = donnees.lignes.find((x) => x.id === f.ligne);
    if (l && (l.etat !== ETATS.validee || l.facture !== f.numero)) {
      let c = {}; try { c = JSON.parse(f.contenu); } catch {}
      Object.assign(l, { etat: ETATS.validee, facture: f.numero, montant: f.montant, paiement: f.paiement, paye_le: c.paye_le || f.date });
      await majLigne(l);
    }
  }
}

// ---- Dates (heure de Paris) ----
export const aujourdhui = () => new Date(aujourdhuiParis()).toISOString().slice(0, 10);
export function horodatage() {
  const ms = Date.now() + decalageParis(Date.now()) * 60000;
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}
export const dateValide = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "") && !Number.isNaN(Date.parse(d + "T00:00:00Z")) && new Date(d + "T00:00:00Z").toISOString().startsWith(d);
const ajouterJours = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * JOUR_MS).toISOString().slice(0, 10);
const finDuMois = (a, m) => new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10); // m de 1 à 12

// ---- Tarifs ----
// « de 5 € à 10 € » -> 5 ; « 30 € » -> 30 ; vide -> 0
export function prixMin(t) {
  const m = /(\d+(?:[.,]\d{1,2})?)/.exec(String(t || ""));
  return m ? Number(m[1].replace(",", ".")) : 0;
}
export function tarifDe(soins, soinNom, optionNoms = []) {
  const soin = (soins.soins || []).find((s) => s.nom === soinNom);
  const options = optionNoms.map((n) => (soins.options || []).find((o) => o.nom === n)).filter(Boolean);
  const morceaux = [];
  if (soin && soin.prix) morceaux.push(`${soin.nom} : ${soin.prix}`);
  for (const o of options) if (o.prix) morceaux.push(`${o.nom} : ${o.prix}`);
  const montant = (soin ? prixMin(soin.prix) : 0) + options.reduce((a, o) => a + prixMin(o.prix), 0);
  const duree = soin && soin.duree ? Number(soin.duree) + options.reduce((a, o) => a + (Number(o.duree) || 0), 0) : 60;
  return { texte: morceaux.join(" · "), montant: Math.round(montant * 100) / 100, duree, connu: Boolean(soin) };
}

// ---- Rendez-vous confirmés sur le site -> lignes « À valider » ----
const PREFIXE = /^\s*À confirmer\s*:/i;
export async function synchroniser(donnees, soins) {
  const depuis = donnees.reglages.depuis;
  const debut = new Date(instant(depuis, 0)).toISOString();
  const fin = new Date(aujourdhuiParis() + 120 * JOUR_MS).toISOString();
  const evs = await listerRendezVous(debut, fin);
  const parRdv = new Map(donnees.lignes.filter((l) => l.rdv).map((l) => [l.rdv, l]));
  const vus = new Set();
  const nouvelles = [];
  for (const ev of evs) {
    const p = ev.extendedProperties && ev.extendedProperties.private;
    const d = ev.start && ev.start.dateTime;
    if (!p || !p.id || !d || PREFIXE.test(ev.summary || "")) continue;
    vus.add(ev.id);
    const date = d.slice(0, 10), heure = d.slice(11, 16);
    const l = parRdv.get(ev.id);
    if (l) {
      if (l.etat === ETATS.attente && (l.date !== date || l.heure !== heure)) { l.date = date; l.heure = heure; await majLigne(l); }
      continue;
    }
    const options = String(p.options || "").split(",").map((x) => x.trim()).filter(Boolean);
    const t = tarifDe(soins, p.soin, options);
    nouvelles.push({
      id: nouvelIdLigne(), etat: ETATS.attente, origine: "Site", date, heure, cliente: p.nom || "", telephone: p.telephone || "",
      email: p.email || "", adresse: "", soin: p.soin || "", options: options.join(", "), tarif: t.texte || p.prix || "",
      montant: t.montant || prixMin(p.prix), paiement: "", paye_le: "", facture: "", rdv: ev.id, note: p.message ? `Message : ${p.message}` : "",
    });
  }
  await nouvellesLignes(nouvelles, donnees);
  // Rendez-vous retirés de l'agenda depuis : on le signale sur la ligne (sans rien supprimer).
  for (const l of donnees.lignes) l.absent = Boolean(l.rdv && l.etat === ETATS.attente && l.date >= depuis && !vus.has(l.rdv));
  return nouvelles.length;
}

export const nouvelIdLigne = () => "L" + Date.now().toString(36).toUpperCase() + randomUUID().slice(0, 4).toUpperCase();

// ---- Factures ----
export function prochainNumero(donnees, annee) {
  const max = donnees.factures.reduce((m, f) => {
    const x = new RegExp(`^F${annee}-(\\d+)$`).exec(f.numero);
    return x ? Math.max(m, Number(x[1])) : m;
  }, 0);
  return `F${annee}-${String(max + 1).padStart(3, "0")}`;
}
export async function enregistrerFacture(f, donnees) {
  const prochain = donnees.factures.reduce((m, x) => Math.max(m, x._rang), 1) + 1;
  f._rang = prochain;
  await ajouterRangees(ONGLET.factures, [versRangee(CHAMPS_FACTURE, f)]);
  donnees.factures.push(f);
}
export const lienFacture = (origine, numero) => `${origine}/api/facture?n=${encodeURIComponent(numero)}&s=${signer(numero, "facture")}`;
export const lienFactureValide = (numero, s) => signatureValide(numero, "facture", s);

export async function lireFacture(numero) {
  await preparer();
  const d = await tableau(`/values/${plage(ONGLET.factures, "A2:H")}?valueRenderOption=UNFORMATTED_VALUE`);
  const r = (d.values || []).find((x) => texte(x[0]) === numero);
  if (!r) return null;
  try { return JSON.parse(texte(r[7])); } catch { return null; }
}

// ---- Périodes de déclaration URSSAF ----
export function periodeDe(date, periodicite) {
  const [a, m] = date.split("-").map(Number);
  return periodicite === "trimestrielle" ? `${a}-T${Math.ceil(m / 3)}` : `${a}-${String(m).padStart(2, "0")}`;
}
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
export function infosPeriode(p) {
  const t = /^(\d{4})-T([1-4])$/.exec(p);
  if (t) {
    const a = Number(t[1]), q = Number(t[2]);
    const du = `${a}-${String(q * 3 - 2).padStart(2, "0")}-01`, au = finDuMois(a, q * 3);
    return { du, au, echeance: finDuMois(q === 4 ? a + 1 : a, q === 4 ? 1 : q * 3 + 1),
      libelle: `${q === 1 ? "1er" : q + "e"} trimestre ${a} (${MOIS[q * 3 - 3]} à ${MOIS[q * 3 - 1]})` };
  }
  const [a, m] = p.split("-").map(Number);
  return { du: `${p}-01`, au: finDuMois(a, m), echeance: finDuMois(m === 12 ? a + 1 : a, m === 12 ? 1 : m + 1), libelle: `${MOIS[m - 1]} ${a}` };
}
function periodesEntre(debut, fin, periodicite) {
  const res = [];
  let d = debut;
  while (d <= fin) {
    const p = periodeDe(d, periodicite);
    if (!res.includes(p)) res.push(p);
    d = ajouterJours(infosPeriode(p).au, 1);
  }
  return res;
}
export function resumePeriodes(donnees) {
  const per = donnees.reglages.periodicite, auj = aujourdhui();
  const validees = donnees.lignes.filter((l) => l.etat === ETATS.validee && dateValide(l.paye_le));
  const cles = new Set(periodesEntre(donnees.reglages.depuis, auj, per));
  validees.forEach((l) => cles.add(periodeDe(l.paye_le, per)));
  donnees.declarations.forEach((x) => x.periode && cles.add(x.periode));
  return [...cles].sort().reverse().map((p) => {
    const i = infosPeriode(p);
    const dans = validees.filter((l) => l.paye_le >= i.du && l.paye_le <= i.au);
    const total = Math.round(dans.reduce((a, l) => a + (Number(l.montant) || 0), 0) * 100) / 100;
    const dec = donnees.declarations.find((x) => x.periode === p);
    const aValider = donnees.lignes.filter((l) => l.etat === ETATS.attente && l.date >= i.du && l.date <= i.au && l.date <= auj).length;
    return { periode: p, ...i, total, nb: dans.length, aValider, terminee: i.au < auj,
      declaration: dec ? { le: dec.declare_le, montant: Number(dec.montant) || 0 } : null };
  });
}
export async function enregistrerDeclaration(p, donnees) {
  await ajouterRangees(ONGLET.declarations, [versRangee(CHAMPS_DECLARATION, p)]);
  donnees.declarations.push(p);
}
export const periodeDeclaree = (date, donnees) =>
  donnees.declarations.some((x) => { const i = infosPeriode(x.periode); return date >= i.du && date <= i.au; });

// ---- Connexion à la page compta ----
const cleSession = () => createHmac("sha256", "coco-compta-session").update(`${process.env.COMPTA_MOT_DE_PASSE || ""}|${process.env.GOOGLE_PRIVATE_KEY || ""}`).digest();
export function creerSession(jours = 90) {
  const exp = Date.now() + jours * JOUR_MS;
  return `${exp}.${createHmac("sha256", cleSession()).update(String(exp)).digest("base64url")}`;
}
export function sessionValide(v) {
  const [exp, s] = String(v || "").split(".");
  if (!exp || !s || Number(exp) < Date.now()) return false;
  const a = Buffer.from(createHmac("sha256", cleSession()).update(exp).digest("base64url")), b = Buffer.from(s);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function motDePasseOk(m) {
  const h = (x) => createHash("sha256").update(String(x || "")).digest();
  return Boolean(process.env.COMPTA_MOT_DE_PASSE) && timingSafeEqual(h(m), h(process.env.COMPTA_MOT_DE_PASSE));
}
