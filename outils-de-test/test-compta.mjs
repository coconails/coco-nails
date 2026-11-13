// Test complet de la compta avec un Google simulé (Agenda, Gmail, Sheets).
// Lancer depuis la racine du projet : node outils-de-test/test-compta.mjs
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const RACINE = new URL("..", import.meta.url).pathname;
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.GOOGLE_CLIENT_EMAIL = "site@test.iam.gserviceaccount.com";
process.env.GOOGLE_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).replace(/\n/g, "\\n");
process.env.GOOGLE_CALENDAR_ID = "contact@coconails72.com";
const contenus = Object.fromEntries(["soins", "coordonnees", "reservation", "paiement", "legal"].map((n) => [n, JSON.parse(readFileSync(`${RACINE}public/contenu/${n}.json`))]));

// ---------- Google simulé ----------
export const G = { evs: new Map(), mails: [], feuilles: new Map(), appelsTableau: 0, tableauPartage: true };
const R = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
const versParis = (iso) => (/[+-]\d\d:\d\d$/.test(iso) ? iso : /Z$/.test(iso) ? new Date(Date.parse(iso) + 3600e3).toISOString().slice(0, 19) + "+01:00" : iso + "+01:00");
const col = (l) => l.split("").reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0);
function plage(r) {
  const m = /^'(.+)'!([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/.exec(decodeURIComponent(r));
  if (!m) throw new Error("plage illisible " + r);
  return { feuille: m[1], c1: col(m[2]) - 1, l1: Number(m[3] || 1) - 1, l2: m[5] ? Number(m[5]) - 1 : Infinity };
}
function lirePlage(r) {
  const p = plage(r), f = G.feuilles.get(p.feuille) || [];
  const v = f.slice(p.l1, p.l2 === Infinity ? undefined : p.l2 + 1).map((x) => (x || []).slice(p.c1));
  while (v.length && !(v.at(-1) || []).length) v.pop();
  return v;
}
function ecrire(r, valeurs) {
  const p = plage(r), f = G.feuilles.get(p.feuille);
  valeurs.forEach((ligne, i) => { const row = (f[p.l1 + i] = f[p.l1 + i] || []); ligne.forEach((v, j) => (row[p.c1 + j] = v)); });
}
globalThis.fetch = async (url, opt = {}) => {
  url = String(url);
  const corps = opt.body && typeof opt.body === "string" ? opt.body : null;
  if (url.includes("oauth2.googleapis.com/token")) {
    const charge = JSON.parse(Buffer.from(new URLSearchParams(opt.body).get("assertion").split(".")[1], "base64url"));
    return R({ access_token: "tok-" + (charge.sub || "sa") + "-" + charge.scope.split("/").pop(), expires_in: 3600 });
  }
  if (url.includes("sheets.googleapis.com")) {
    G.appelsTableau++;
    if (!G.tableauPartage) return R({ error: "PERMISSION_DENIED" }, 403);
    if (!opt.headers.Authorization.includes("spreadsheets")) return R({}, 401);
    const u = new URL(url), chemin = decodeURIComponent(u.pathname).replace(/^\/v4\/spreadsheets\/[^/:]+/, "");
    if (chemin === "" && (opt.method || "GET") === "GET") return R({ sheets: [...G.feuilles.keys()].map((title) => ({ properties: { title } })) });
    if (chemin === ":batchUpdate") { for (const q of JSON.parse(corps).requests) G.feuilles.set(q.addSheet.properties.title, []); return R({}); }
    if (chemin === "/values:batchGet") return R({ valueRanges: u.searchParams.getAll("ranges").map((r) => ({ range: r, values: lirePlage(r) })) });
    const m = /^\/values\/(.+?)(:append)?$/.exec(chemin);
    const r = u.pathname.split("/values/")[1].replace(/:append$/, "");
    if (m && m[2]) { const p = plage(r), f = G.feuilles.get(p.feuille); let n = f.length; while (n > 0 && !(f[n - 1] || []).length) n--; ecrire(`'${p.feuille}'!A${n + 1}`, JSON.parse(corps).values); return R({}); }
    if (m && opt.method === "PUT") { ecrire(r, JSON.parse(corps).values); return R({}); }
    if (m) return R({ values: lirePlage(r) });
  }
  if (url.includes("/freeBusy")) {
    const b = JSON.parse(corps); const a = Date.parse(b.timeMin), z = Date.parse(b.timeMax);
    const busy = [...G.evs.values()].filter((e) => Date.parse(e.start.dateTime) < z && Date.parse(e.end.dateTime) > a).map((e) => ({ start: e.start.dateTime, end: e.end.dateTime }));
    return R({ calendars: { [b.items[0].id]: { busy } } });
  }
  if (url.includes("gmail.googleapis.com")) {
    const raw = Buffer.from(JSON.parse(corps).raw, "base64url").toString();
    G.mails.push(raw); return R({ id: "m" + G.mails.length });
  }
  const m = url.match(/\/events(?:\/([^?]+))?(\?.*)?$/);
  if (m) {
    const id = m[1] && decodeURIComponent(m[1]);
    if (!id && opt.method === "POST") { const ev = JSON.parse(corps); ev.start.dateTime = versParis(ev.start.dateTime); ev.end.dateTime = versParis(ev.end.dateTime); G.evs.set(ev.id, ev); return R(ev); }
    if (!id) {
      const q = new URL(url).searchParams; const a = Date.parse(q.get("timeMin")), z = Date.parse(q.get("timeMax"));
      return R({ items: [...G.evs.values()].filter((e) => Date.parse(e.start.dateTime) < z && Date.parse(e.end.dateTime) > a).map((e) => ({ ...e, id: e.id })) });
    }
    if (!G.evs.has(id)) return R({}, 404);
    if (opt.method === "PATCH") { const ch = JSON.parse(corps); if (ch.start) ch.start.dateTime = versParis(ch.start.dateTime); if (ch.end) ch.end.dateTime = versParis(ch.end.dateTime); Object.assign(G.evs.get(id), ch); return R(G.evs.get(id)); }
    if (opt.method === "DELETE") { G.evs.delete(id); return new Response(null, { status: 204 }); }
    return R(G.evs.get(id));
  }
  const c = url.match(/\/contenu\/(\w+)\.json/); if (c) return R(contenus[c[1]]);
  throw new Error("URL inattendue " + url);
};
let maintenant = Date.parse("2026-11-23T10:00:00+01:00");
Date.now = () => maintenant;
export const aller = (iso) => (maintenant = Date.parse(iso));

const O = "https://coconails72.com";
const imp = (p) => import(RACINE + p);
const reserver = (await imp("netlify/functions/reserver.mjs")).default;
const rdv = (await imp("netlify/functions/rdv.mjs")).default;
const compta = (await imp("netlify/functions/compta.mjs")).default;
const facture = (await imp("netlify/functions/facture.mjs")).default;
const { verifierRappel } = await imp("netlify/functions/rappel-urssaf.mjs");
export const fonctions = { reserver, rdv, compta, facture };

let echecs = 0;
const ok = (c, t) => { if (!c) echecs++; console.log((c ? "OK    " : "ÉCHEC ") + t); };
let cookie = "";
async function api(action, donnees = {}, avecCookie = true) {
  const r = await compta(new Request(O + "/api/compta", action
    ? { method: "POST", headers: { "Content-Type": "application/json", cookie: avecCookie ? cookie : "" }, body: JSON.stringify({ action, ...donnees }) }
    : { headers: { cookie: avecCookie ? cookie : "" } }));
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  return { statut: r.status, ...(await r.json()) };
}
const sujet = (raw) => Buffer.from(raw.match(/^Subject: =\?UTF-8\?B\?(.+?)\?=/m)[1], "base64").toString();
const to = (raw) => raw.match(/^To: (.*)$/m)[1];
const reservationConfirmee = async (b) => {
  await reserver(new Request(O + "/api/reserver", { method: "POST", body: JSON.stringify(b) }));
  const ev = [...G.evs.values()].at(-1);
  const lien = ev.description.match(/https:\S+a=confirmer\S+/)[0], q = new URL(lien).searchParams;
  await rdv(new Request(O + "/api/rdv", { method: "POST", body: new URLSearchParams({ id: q.get("id"), a: "confirmer", s: q.get("s") }) }));
  return ev.id;
};
mkdirSync(RACINE + "out", { recursive: true });

if (process.argv[2] !== "--serveur") {
  console.log("— Configuration et connexion");
  let r = await api();
  ok(r.statut === 503 && r.configuration, "Sans réglages Netlify : message « pas encore reliée » → " + r.statut);
  process.env.COMPTA_SHEET_ID = "tableau-test";
  process.env.COMPTA_MOT_DE_PASSE = "Vernis-Rouge-2026";
  r = await api(); ok(r.statut === 401 && r.connexion, "Sans connexion : refusé → " + r.statut);
  r = await api("valider", { id: "x" }); ok(r.statut === 401, "Action sans connexion : refusée → " + r.statut);
  const t0 = Date.now; let debut = performance.now();
  r = await api("connexion", { motdepasse: "mauvais" });
  ok(r.statut === 401 && performance.now() - debut > 1400 && !cookie, "Mauvais mot de passe : refusé après une pause anti-devinette");
  r = await api("connexion", { motdepasse: "Vernis-Rouge-2026" });
  ok(r.statut === 200 && cookie.startsWith("coco_compta="), "Bon mot de passe : connectée");
  ok([...G.feuilles.keys()].join(",") === "Rendez-vous,Factures,Déclarations URSSAF,Réglages", "Onglets créés dans le tableau : " + [...G.feuilles.keys()].join(", "));
  ok(r.vue.reglages.depuis === "2026-11-01" && r.vue.reglages.periodicite === "mensuelle", "Réglages par défaut : depuis le 01/11/2026, déclaration mensuelle");
  ok(r.vue.alertes.some((a) => a.includes("SIRET")), "Alerte : SIRET pas encore rempli");
  const faux = cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
  const vrai = cookie; cookie = faux; r = await api(); ok(r.statut === 401, "Cookie falsifié : refusé"); cookie = vrai;

  console.log("— Rendez-vous du site");
  aller("2026-11-16T10:00:00+01:00");
  const base = { nom: "Julie Martin", email: "julie@example.com", telephone: "06 12 34 56 78", soin: "Pose semi-permanent", options: ["French ou baby boomer"], message: "" };
  const idJulie = await reservationConfirmee({ ...base, date: "2026-11-20", debut: 14 * 60 });
  await reserver(new Request(O + "/api/reserver", { method: "POST", body: JSON.stringify({ ...base, nom: "Pas Confirmée", date: "2026-11-24", debut: 10 * 60 }) }));
  aller("2026-11-23T10:00:00+01:00");
  r = await api();
  let l = r.vue.lignes.find((x) => x.rdv === idJulie);
  ok(r.vue.lignes.length === 1 && l && l.etat === "À valider" && l.origine === "Site", "RDV confirmé → ligne « À valider » (le RDV pas encore confirmé n'apparaît pas)");
  ok(l.montant === 35 && l.tarif.includes("30 €") && l.cliente === "Julie Martin" && l.telephone && l.email, `Montant prérempli 35 € (30 + 5), tarif : ${l.tarif}`);
  r = await api(); ok(r.vue.lignes.length === 1, "Recharger : pas de doublon");
  G.evs.get(idJulie).start.dateTime = "2026-11-20T15:00:00+01:00"; G.evs.get(idJulie).end.dateTime = "2026-11-20T16:30:00+01:00";
  r = await api(); l = r.vue.lignes[0]; ok(l.heure === "15:00", "RDV déplacé dans l'agenda → heure mise à jour (15:00)");

  console.log("— Ajouts par téléphone / message");
  r = await api("ajouter", { origine: "Téléphone", cliente: "Léa Durand", telephone: "07 00 00 00 01", date: "2026-11-21", heure: "10:00", soin: "Remplissage 4 semaines", options: [], montant: "" , agenda: true });
  const lea = r.vue.lignes.find((x) => x.cliente === "Léa Durand");
  ok(r.statut === 200 && lea && lea.montant === 40 && !lea.rdv, "RDV passé par téléphone : ligne ajoutée, 40 €, pas d'agenda (date passée)");
  r = await api("ajouter", { origine: "Message", cliente: "Emma Petit", telephone: "+33 6 11 22 33 44", email: "emma@example.com", date: "2026-11-26", heure: "14:00", soin: "Rallongement gel", options: ["Nail art"], montant: "62,50", agenda: true, note: "Via Instagram" });
  const emma = r.vue.lignes.find((x) => x.cliente === "Emma Petit");
  ok(emma && emma.montant === 62.5 && emma.rdv && G.evs.get(emma.rdv), "RDV futur par message : ligne + créneau bloqué dans l'agenda, montant 62,50 €");
  ok(G.evs.get(emma.rdv).colorId === "10" && G.evs.get(emma.rdv).summary === "Emma Petit, Rallongement gel + Nail art", "Événement vert : " + G.evs.get(emma.rdv).summary);
  r = await api(); ok(r.vue.lignes.filter((x) => x.cliente === "Emma Petit").length === 1, "L'événement créé par la compta n'est pas réimporté en double");
  r = await api("ajouter", { origine: "Téléphone", cliente: "Chloé", date: "2026-11-26", heure: "15:00", soin: "Dépose", agenda: true });
  ok(r.statut === 409 && r.code === "occupe", "Créneau déjà pris : avertissement → " + r.erreur);
  r = await api("ajouter", { origine: "Téléphone", cliente: "Chloé", date: "2026-11-26", heure: "15:00", soin: "Dépose", agenda: true, forcer: true });
  ok(r.statut === 200, "« L'ajouter quand même » : accepté");
  r = await api("ajouter", { origine: "Téléphone", cliente: "Zoé", date: "2026-11-22", soin: "Réparation d'un ongle", montant: "5" });
  ok(r.statut === 200 && r.vue.lignes.find((x) => x.cliente === "Zoé").montant === 5, "Prestation hors carte (« Autre ») : acceptée");
  r = await api("ajouter", { origine: "Téléphone", cliente: "X", date: "2026-11-22", soin: "Dépose" }); ok(r.statut === 400, "Nom trop court : refusé → " + r.erreur);
  r = await api("ajouter", { origine: "Téléphone", cliente: "Nina", date: "2026-02-30", soin: "Dépose" }); ok(r.statut === 400, "Date impossible (30 février) : refusée");
  r = await api("modifier", { id: emma.id, cliente: "Emma Petit", telephone: emma.telephone, email: emma.email, date: "2026-11-27", heure: "09:30", soin: "Rallongement gel", options: ["Nail art"], montant: "62,50" });
  ok(G.evs.get(emma.rdv).start.dateTime === "2026-11-27T09:30:00+01:00" && G.evs.get(emma.rdv).end.dateTime === "2026-11-27T12:00:00+01:00", "Modifier la date → l'agenda suit (27/11 9 h 30 – 12 h)");
  r = await api(); ok(r.vue.lignes.find((x) => x.id === emma.id).date === "2026-11-27", "…et la ligne reste à jour après rechargement");

  console.log("— Validation et factures");
  r = await api("valider", { id: l.id, montant: "35", paiement: "Carte bancaire", paye_le: "2026-11-20", adresse: "4 rue des Lilas, 72300 Sablé-sur-Sarthe", cliente: "Julie Martin", email: "julie@example.com", telephone: "06 12 34 56 78" });
  ok(r.statut === 200 && r.facture === "F2026-001", "Valider → facture " + r.facture);
  const f1 = r.vue.factures[0];
  ok(r.vue.lignes.find((x) => x.id === l.id).etat === "Validée" && f1.montant === 35 && f1.paiement === "Carte bancaire", "Ligne « Validée », facture 35 € par carte");
  r = await api("valider", { id: l.id, montant: "35", paiement: "Carte bancaire" }); ok(r.statut === 409, "Valider deux fois : refusé → " + r.erreur);
  r = await api("modifier", { id: l.id, cliente: "Autre", date: "2026-11-20", soin: "Dépose" }); ok(r.statut === 409, "Modifier une ligne facturée : refusé");
  r = await api("valider", { id: lea.id, montant: "40", paiement: "Espèces", paye_le: "2026-11-30" }); ok(r.statut === 400, "Date de paiement dans le futur : refusée");
  r = await api("valider", { id: lea.id, montant: "0", paiement: "Espèces" }); ok(r.statut === 400, "Montant 0 : refusé");
  r = await api("valider", { id: lea.id, montant: "40", paiement: "Bitcoin" }); ok(r.statut === 400, "Moyen de paiement inconnu : refusé");
  r = await api("valider", { id: lea.id, montant: "42", paiement: "Espèces", paye_le: "2026-11-21" });
  ok(r.vue.lignes.find((x) => x.id === lea.id).telephone === "07 00 00 00 01", "Valider sans renvoyer le téléphone : il est conservé");
  ok(r.facture === "F2026-002" && r.vue.lignes.find((x) => x.id === lea.id).montant === 42, "Deuxième facture F2026-002, montant corrigé à 42 €");

  const pdf = await facture(new Request(f1.lien));
  const octets = Buffer.from(await pdf.arrayBuffer());
  ok(pdf.status === 200 && pdf.headers.get("content-type") === "application/pdf" && octets.slice(0, 5).toString() === "%PDF-", "Lien de facture → PDF (" + octets.length + " octets)");
  writeFileSync(RACINE + "out/F2026-001.pdf", octets);
  const pdf2 = Buffer.from(await (await facture(new Request(f1.lien))).arrayBuffer());
  ok(pdf2.equals(octets), "La facture est recréée à l'identique à chaque ouverture");
  r = await facture(new Request(f1.lien.replace("F2026-001", "F2026-002"))); ok(r.status === 403, "Changer le numéro dans le lien : refusé → " + r.status);

  const avant = G.mails.length;
  r = await api("envoyer", { numero: "F2026-001" });
  const mail = G.mails.at(-1);
  ok(r.statut === 200 && G.mails.length === avant + 1 && to(mail) === "julie@example.com" && sujet(mail) === "Votre facture Coco Nail's n° F2026-001", "Envoi par e-mail : " + sujet(mail));
  ok(mail.includes('Content-Type: application/pdf; name="facture-F2026-001.pdf"'), "PDF joint à l'e-mail");
  ok(r.vue.factures.find((x) => x.numero === "F2026-001").envois.startsWith("E-mail à julie@example.com le 2026-11-23"), "Envoi noté : " + r.vue.factures.find((x) => x.numero === "F2026-001").envois);
  r = await api("envoyer", { numero: "F2026-002" }); ok(r.statut === 400, "Pas d'e-mail pour Léa : demande l'adresse → " + r.erreur);
  r = await api("whatsapp", { numero: "F2026-002" }); ok(r.vue.factures.find((x) => x.numero === "F2026-002").envois.startsWith("WhatsApp le"), "Envoi WhatsApp noté");

  console.log("— Annulation");
  const zoe = r.vue.lignes.find((x) => x.cliente === "Zoé");
  r = await api("annuler", { id: zoe.id }); ok(r.vue.lignes.find((x) => x.id === zoe.id).etat === "Annulée", "Cliente pas venue : « Annulée »");
  r = await api("retablir", { id: zoe.id }); ok(r.vue.lignes.find((x) => x.id === zoe.id).etat === "À valider", "Remise à valider");

  console.log("— URSSAF");
  let nov = r.vue.periodes.find((p) => p.periode === "2026-11");
  ok(nov && nov.total === 77 && nov.nb === 2 && !nov.terminee && nov.echeance === "2026-12-31", `Novembre : 77 € (35 + 42), 2 factures, à déclarer avant le 31/12`);
  r = await api("declarer", { periode: "2026-11" }); ok(r.statut === 409, "Déclarer un mois pas terminé : refusé");
  aller("2026-12-04T09:00:00+01:00"); ok((await verifierRappel(O)) === null, "Rappel le 4 décembre : rien");
  aller("2026-12-05T09:00:00+01:00"); const avantR = G.mails.length;
  let m = await verifierRappel(O);
  ok(m && G.mails.length === avantR + 1 && to(G.mails.at(-1)) === "contact@coconails72.com", "Rappel le 5 décembre envoyé à Coralie : " + (m && m.sujet));
  ok(m.texte.includes("à valider"), "Le rappel signale les rendez-vous encore à valider");
  writeFileSync(RACINE + "out/mail-rappel-urssaf.html", m.html);
  aller("2026-12-20T09:00:00+01:00"); ok((await verifierRappel(O)) === null, "Le 20 décembre : pas de rappel");
  aller("2026-12-26T09:00:00+01:00"); m = await verifierRappel(O); ok(m && m.sujet.startsWith("Rappel :"), "Relance 5 jours avant la date limite : " + (m && m.sujet));
  r = await api("valider", { id: emma.id, montant: "65", paiement: "Virement", paye_le: "2026-11-30" });
  ok(r.facture === "F2026-003", "Paiement d'Emma daté du 30/11 → F2026-003");
  nov = r.vue.periodes.find((p) => p.periode === "2026-11");
  r = await api("declarer", { periode: "2026-11" });
  ok(r.statut === 200 && r.vue.periodes.find((p) => p.periode === "2026-11").declaration, "Novembre déclaré (" + nov.total + " €)");
  r = await api("declarer", { periode: "2026-11" }); ok(r.statut === 409, "Déclarer deux fois : refusé");
  r = await api();
  const chloe = r.vue.lignes.find((x) => x.cliente === "Chloé");
  r = await api("valider", { id: chloe.id, montant: "20", paiement: "Espèces", paye_le: "2026-11-28" });
  ok(r.statut === 409, "Paiement daté d'un mois déjà déclaré : refusé → " + r.erreur);
  m = await verifierRappel(O); ok(m === null, "Après déclaration : plus de relance");
  r = await api("valider", { id: chloe.id, montant: "20", paiement: "Espèces" });
  ok(r.facture === "F2026-004" && r.vue.periodes.find((p) => p.periode === "2026-12").total === 20, "Payé aujourd'hui → compté en décembre (F2026-004)");

  console.log("— Changement d'année, trimestre, réparation");
  aller("2027-01-03T09:00:00+01:00");
  r = await api("valider", { id: zoe.id, montant: "5", paiement: "Espèces" });
  ok(r.facture === "F2027-001", "Nouvelle année : la numérotation repart à F2027-001");
  r = await api("reglage", { periodicite: "trimestrielle" });
  const t4 = r.vue.periodes.find((p) => p.periode === "2026-T4");
  ok(t4 && t4.total === 162 && t4.echeance === "2027-01-31", `Déclaration trimestrielle : 4e trimestre 2026 = ${t4 && t4.total} €, avant le 31/01/2027`);
  await api("reglage", { periodicite: "mensuelle" });
  // Coupure simulée : la facture est écrite mais pas la ligne
  const lignes = G.feuilles.get("Rendez-vous");
  const rangChloe = lignes.findIndex((x) => x[5] === "Chloé"); lignes[rangChloe][1] = "À valider"; lignes[rangChloe][15] = "";
  r = await api(); ok(r.vue.lignes.find((x) => x.cliente === "Chloé").etat === "Validée", "Ligne non mise à jour après une coupure : réparée automatiquement");

  console.log("— Tableau non partagé");
  G.tableauPartage = false;
  const { default: fraiche } = await import(RACINE + "netlify/functions/compta.mjs?neuf");
  r = await fraiche(new Request(O + "/api/compta", { headers: { cookie } }));
  const j = await r.json();
  ok(r.status === 503 && j.erreur.includes("partagé"), "Message clair si le tableau n'est pas partagé : " + j.erreur);
  G.tableauPartage = true;
  writeFileSync(RACINE + "out/tableau.json", JSON.stringify(Object.fromEntries(G.feuilles), null, 1));
  console.log(echecs ? `\n${echecs} ÉCHEC(S)` : "\nTout est OK.");
  process.exit(echecs ? 1 : 0);
}
