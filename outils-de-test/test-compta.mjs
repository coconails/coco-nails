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
export const G = { evs: new Map(), mails: [], feuilles: new Map(), appelsTableau: 0, tableauPartage: true,
  sumup: [], versements: [], drive: [], driveDelegation: false, sms: [], stop: [] };
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
    if (charge.scope.includes("drive") && !G.driveDelegation) return R({ error: "unauthorized_client" }, 401);
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
  if (url.startsWith("https://eu.api.ovh.com/1.0")) {
    const u = new URL(url);
    if (u.pathname === "/1.0/auth/time") return new Response(String(Math.floor(Date.now() / 1000)));
    const { createHash } = await import("node:crypto");
    const h = opt.headers, attendu = "$1$" + createHash("sha1").update(["secret-ovh", "conso-ovh", opt.method || "GET", url, corps || "", h["X-Ovh-Timestamp"]].join("+")).digest("hex");
    if (h["X-Ovh-Application"] !== "appli-ovh" || h["X-Ovh-Signature"] !== attendu) return R({ message: "Invalid signature" }, 400);
    if (u.pathname === "/1.0/sms/sms-test-1/jobs" && opt.method === "POST") { const b = JSON.parse(corps); G.sms.push(b); return R({ ids: [1000 + G.sms.length], validReceivers: b.receivers, invalidReceivers: [], totalCreditsRemoved: 1 }); }
    if (u.pathname === "/1.0/sms/sms-test-1/blacklists") return R(G.stop);
    return R({ message: "inconnu" }, 404);
  }
  if (url.startsWith("https://api.sumup.com")) {
    if (opt.headers.Authorization !== "Bearer sup_sk_test") return R({ error_code: "NOT_AUTHORIZED" }, 401);
    const u = new URL(url), q = u.searchParams;
    if (u.pathname === "/v0.1/memberships") return R({ items: [{ id: "mem1", resource_id: "MTEST01", type: "merchant", resource: { id: "MTEST01", type: "merchant", name: "Coco Nail's" } }], total_count: 1 });
    if (u.pathname === "/v2.1/merchants/MTEST01/transactions/history") {
      const a = Date.parse(q.get("oldest_time") || 0), z = Date.parse(q.get("newest_time") || "2100-01-01");
      const tous = G.sumup.filter((t) => Date.parse(t.timestamp) >= a && Date.parse(t.timestamp) < z);
      const depart = Number(q.get("oldest_ref") || 0), page = tous.slice(depart, depart + 2); // 2 par page pour tester la pagination
      const links = depart + 2 < tous.length ? [{ rel: "next", href: `${q.toString().replace(/&?oldest_ref=\d+/, "")}&oldest_ref=${depart + 2}` }] : [];
      return R({ items: page, links });
    }
    if (u.pathname === "/v1.0/merchants/MTEST01/payouts") return R(G.versements.filter((v) => v.date >= q.get("start_date") && v.date <= q.get("end_date")));
    return R({}, 404);
  }
  if (url.includes("googleapis.com/drive/v3/files") || url.includes("googleapis.com/upload/drive/v3/files")) {
    if (!url.includes("upload")) { const meta = JSON.parse(corps); const id = "dossier" + (G.drive.length + 1); G.drive.push({ id, ...meta }); return R({ id }); }
    const brut = Buffer.from(opt.body), texte = brut.toString("latin1");
    const meta = JSON.parse(brut.toString("utf8").match(/\r\n\r\n(\{.*?\})\r\n--/)[1]);
    const debut = texte.indexOf("\r\n\r\n", texte.indexOf("Content-Type: image") >= 0 ? texte.indexOf("Content-Type: image") : texte.indexOf("Content-Type: application/pdf")) + 4;
    const fin = texte.lastIndexOf("\r\n--");
    const id = "fichier" + (G.drive.length + 1); G.drive.push({ id, ...meta, octets: brut.subarray(debut, fin) });
    return R({ id, webViewLink: `https://drive.google.com/file/d/${id}/view` });
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
const { executerRappels, smsVeille, smsProchain } = await imp("netlify/functions/rappels.mjs");
const desinscription = (await imp("netlify/functions/desinscription.mjs")).default;
const { enGsm } = await imp("netlify/lib/sms.mjs");
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
const corpsHtml = (raw) => Buffer.from(raw.split(/Content-Type: text\/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n/)[1].split("\r\n--")[0].replace(/\r\n/g, ""), "base64").toString();
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
  ok([...G.feuilles.keys()].join(",") === "Rendez-vous,Factures,Déclarations URSSAF,Réglages,Dépenses,Abonnements,Clientes,Rappels envoyés", "Onglets créés dans le tableau : " + [...G.feuilles.keys()].join(", "));
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

  console.log("— Dépenses et abonnements");
  r = await api();
  const abo = (n) => r.vue.depenses.filter((x) => x.source === "Abonnement" && x.libelle.startsWith(n));
  ok(abo("Google Workspace").length === 3 && abo("Forfait Free").length === 3 && !abo("Nom de domaine").length,
    "Abonnements : Google et Free créés pour nov., déc., janv. ; domaine en pause → rien");
  ok(abo("Google Workspace")[0].montant === 9.72 && abo("Google Workspace")[0].etat === "À valider" && abo("Google Workspace")[0].date === "2026-11-01", "Ligne Google « À valider » de 9,72 € au 01/11");
  r = await api(); ok(r.vue.depenses.length === 6, "Recharger : pas de doublon d'abonnement");
  const gnov = abo("Google Workspace")[0];
  r = await api("modifier_depense", { id: gnov.id, date: gnov.date, montant: "9,72", fournisseur: "Google", libelle: gnov.libelle, categorie: gnov.categorie, paiement: "Prélèvement", valider: true });
  ok(r.vue.depenses.find((x) => x.id === gnov.id).etat === "Validée", "Dépense d'abonnement validée");
  const fdec = r.vue.depenses.find((x) => x.libelle === "Forfait Free 2 € — décembre 2026");
  r = await api("ecarter_depense", { id: fdec.id }); ok(r.vue.depenses.find((x) => x.id === fdec.id).etat === "Écartée", "Échéance écartée");
  r = await api(); ok(r.vue.depenses.filter((x) => x.ref === fdec.ref).length === 1, "Une échéance écartée n'est pas recréée");
  r = await api("ecarter_depense", { id: fdec.id, retablir: true }); ok(r.vue.depenses.find((x) => x.id === fdec.id).etat === "À valider", "…et peut être remise à valider");
  r = await api("ajouter_depense", { date: "2027-01-02", montant: "45,90", fournisseur: "Nailstore", libelle: "Gels de construction", categorie: "Fournitures (vernis, gels, limes…)", paiement: "Carte bancaire" });
  const achat = r.vue.depenses.find((x) => x.id === r.depense);
  ok(achat && achat.etat === "Validée" && achat.montant === 45.9, "Achat saisi à la main : 45,90 €, validé directement");
  r = await api("ajouter_depense", { date: "2027-02-01", montant: "5", fournisseur: "X" }); ok(r.statut === 400, "Dépense dans le futur : refusée");
  r = await api("ajouter_depense", { date: "2027-01-02", montant: "0", fournisseur: "X" }); ok(r.statut === 400, "Dépense à 0 € : refusée");

  const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("faux jpeg pour le test")]);
  r = await api("justificatif", { id: achat.id, type: "image/jpeg", contenu: photo.toString("base64") });
  ok(r.statut === 503 && r.erreur.includes("pas encore autorisé"), "Ticket sans autorisation Drive : message clair → " + r.erreur);
  G.driveDelegation = true;
  r = await api("justificatif", { id: achat.id, type: "image/jpeg", contenu: photo.toString("base64") });
  const fichier = G.drive.find((x) => x.id && x.id.startsWith("fichier"));
  ok(r.statut === 200 && fichier && fichier.octets.equals(photo), "Ticket archivé dans Google Drive, fichier intact");
  ok(fichier.name === "2027-01-02 Nailstore 45,90 €.jpg", "Nom du fichier : " + fichier.name);
  ok(G.drive.filter((x) => x.mimeType).map((x) => x.name).join(" / ") === "Comptabilité Coco Nail's — Justificatifs / 2027", "Dossiers créés : " + G.drive.filter((x) => x.mimeType).map((x) => x.name).join(" / "));
  const dep = r.vue.depenses.find((x) => x.id === achat.id);
  const { createHash } = await import("node:crypto");
  ok(dep.justificatif.includes("drive.google.com") && dep.empreinte === createHash("sha256").update(photo).digest("hex"), "Lien et empreinte SHA-256 notés dans le tableau");
  r = await api("justificatif", { id: gnov.id, type: "application/pdf", contenu: Buffer.from("%PDF-1.4 facture").toString("base64") });
  ok(r.statut === 200 && G.drive.filter((x) => x.mimeType).length === 3, "Facture PDF de 2026 : rangée dans un dossier 2026 (dossier principal réutilisé)");
  r = await api("justificatif", { id: achat.id, type: "text/html", contenu: "PGI+" }); ok(r.statut === 400, "Format non accepté : refusé");
  r = await api("justificatif", { id: achat.id, type: "image/jpeg", contenu: Buffer.alloc(4.2 * 1024 * 1024).toString("base64") }); ok(r.statut === 400, "Fichier trop lourd : refusé");

  r = await api();
  const dom = r.vue.abonnements.find((a) => a.nom.startsWith("Nom de domaine"));
  r = await api("abonnement", { id: dom.id, nom: dom.nom, fournisseur: "Squarespace", montant: "21,60", rythme: "annuel", jour: "2", mois: "1", actif: true });
  ok(r.statut === 200 && r.vue.depenses.some((x) => x.libelle === "Nom de domaine coconails72.com — 2027" && x.montant === 21.6 && x.date === "2027-01-02"),
    "Domaine activé (2 janvier, 21,60 €) : échéance de janvier 2027 créée");
  r = await api("abonnement", { nom: "Assurance pro", fournisseur: "MAAF", montant: "120", rythme: "annuel", mois: "3", categorie: "Assurance" });
  ok(r.statut === 200 && r.vue.abonnements.length === 4 && !r.vue.depenses.some((x) => x.libelle.startsWith("Assurance")), "Nouvel abonnement annuel (mars) : rien avant mars");
  r = await api("abonnement", { nom: "Sans mois", montant: "10", rythme: "annuel" }); ok(r.statut === 400, "Abonnement annuel sans mois : refusé");
  r = await api();
  const janv = r.vue.bilan.find((m) => m.mois === "2027-01");
  ok(janv.recettes === 5 && janv.depenses === 45.9 && janv.benefice === -40.9, `Bilan de janvier : recettes 5 €, dépenses 45,90 €, bénéfice ${janv.benefice} €`);

  console.log("— SumUp");
  ok(!r.vue.sumup.actif, "Sans clé SumUp : rien n'est affiché");
  process.env.SUMUP_API_KEY = "mauvaise";
  r = await api(); ok(r.statut === 200 && r.vue.alertes.some((a) => a.includes("clé SumUp")), "Clé refusée : la page marche, avec un message");
  process.env.SUMUP_API_KEY = "sup_sk_test";
  const tx = (code, iso, montant, extra = {}) => ({ id: "id-" + code, transaction_code: code, amount: montant, currency: "EUR", timestamp: iso, status: "SUCCESSFUL", type: "PAYMENT", card_type: "VISA", ...extra });
  G.sumup.push(tx("TX1", "2026-12-28T13:05:00Z", 20), tx("TX0", "2026-12-29T09:00:00Z", 15, { status: "FAILED" }),
    tx("TX2", "2027-01-03T09:15:00Z", 45), tx("TX3", "2027-01-03T10:40:00Z", 30), tx("TXR", "2027-01-02T10:00:00Z", 10, { type: "REFUND" }));
  G.versements.push({ id: 1, type: "PAYOUT", amount: 19.65, date: "2026-12-30", currency: "EUR", fee: 0.35, status: "SUCCESSFUL", reference: "x", transaction_code: "TX1" });
  r = await api();
  ok(r.vue.sumup.actif && r.vue.sumup.libres.map((p) => p.code).join(",") === "TX1,TX2,TX3", "Paiements lus (3 pages), échecs et remboursements ignorés : " + r.vue.sumup.libres.map((p) => p.code).join(","));
  ok(r.vue.sumup.libres.find((p) => p.code === "TX2").heure === "10:15", "Heure de Paris : 10 h 15");
  const com = r.vue.depenses.find((x) => x.ref === "sumup:2026-12");
  ok(com && com.montant === 0.35 && com.etat === "À valider" && com.date === "2026-12-31" && com.paiement === "Retenu par SumUp", "Commission SumUp de décembre : 0,35 € (réelle), au 31/12");
  ok(!r.vue.depenses.some((x) => x.ref === "sumup:2027-01"), "Pas de commission pour le mois en cours");
  r = await api(); ok(r.vue.depenses.filter((x) => x.ref === "sumup:2026-12").length === 1, "Commission non recréée en double");
  r = await api("ajouter", { origine: "Téléphone", cliente: "Nina Faure", date: "2027-01-03", soin: "Rallongement gel", montant: "45" });
  const nina = r.vue.lignes.find((x) => x.cliente === "Nina Faure");
  r = await api("valider", { id: nina.id, montant: "45", paiement: "Carte bancaire" });
  ok(r.vue.lignes.find((x) => x.id === nina.id).sumup === "TX2" && !r.vue.sumup.libres.some((p) => p.code === "TX2"), "Validation carte 45 € : paiement SumUp TX2 retrouvé tout seul");
  ok(r.vue.factures.find((f) => f.numero === r.facture).sumup === "TX2", "La facture affiche le lien SumUp");
  r = await api("ajouter", { origine: "Message", cliente: "Rose Lemaire", date: "2026-12-28", soin: "Dépose", montant: "20" });
  const rose = r.vue.lignes.find((x) => x.cliente === "Rose Lemaire");
  r = await api("valider", { id: rose.id, montant: "20", paiement: "Carte bancaire", paye_le: "2027-01-03", sumup: "TX2" });
  ok(r.statut === 409, "Paiement SumUp déjà rattaché : refusé");
  r = await api("valider", { id: rose.id, montant: "20", paiement: "Carte bancaire", paye_le: "2027-01-03", sumup: "TX1" });
  ok(r.statut === 200 && r.vue.lignes.find((x) => x.id === rose.id).sumup === "TX1", "Rattachement manuel du paiement TX1");
  const c = r.vue.sumup.controle[0];
  ok(c.mois === "2027-01" && c.sumup === 75 && c.factures === 65, `Contrôle de janvier : SumUp 75 € / factures carte ${c.factures} €`);

  console.log("— Rappels aux clientes");
  const html = readFileSync(RACINE + "public/index.html", "utf8");
  ok(html.includes('name="ok_veille" value="oui" checked') && html.includes('name="ok_prochain" value="oui">') && !html.includes("mobile-home"),
    "Site : 2 cases (rappel veille cochée, prochain soin décochée), phrase « espace beauté »");
  ok(readFileSync(RACINE + "netlify.toml", "utf8").includes('from = "/rdv"'), "Adresse courte /rdv vers la réservation");
  aller("2027-01-03T18:00:00+01:00");
  const resa = (b) => reservationConfirmee({ email: "x@example.com", telephone: "06 00 00 00 00", options: [], message: "", ...b });
  const idAlice = await resa({ nom: "Alice Rappel", email: "alice@example.com", telephone: "06 21 22 33 44", soin: "Pose semi-permanent", date: "2027-01-05", debut: 600, ok_veille: true, ok_prochain: true });
  ok(G.evs.get(idAlice).extendedProperties.private.ok_prochain === "oui", "Les choix de la cliente sont gardés avec la réservation");
  await resa({ nom: "Bob Sansrappel", email: "bob@example.com", telephone: "06 99 88 77 66", soin: "Dépose", date: "2027-01-05", debut: 840, ok_veille: false, ok_prochain: false });
  aller("2027-01-04T10:00:00+01:00");
  let n = G.mails.length;
  let rr = await executerRappels(O);
  const mAlice = G.mails.slice(n).find((m) => to(m) === "alice@example.com");
  ok(rr.veille === 1 && mAlice && sujet(mAlice).startsWith("Rappel : votre rendez-vous demain à 10 h"), "Sans clés OVH : rappel de la veille par e-mail à Alice → " + (mAlice && sujet(mAlice)));
  ok(!G.mails.slice(n).some((m) => to(m) === "bob@example.com"), "Bob a décoché : aucun rappel");
  ok(corpsHtml(mAlice).includes("/api/desinscription?id="), "Lien « Gérer mes messages » dans l'e-mail");
  r = await api();
  const fAlice = r.vue.clientes.find((c) => c.nom === "Alice Rappel");
  ok(fAlice && fAlice.ok_veille === "oui" && fAlice.ok_prochain === "oui" && fAlice.accord_par.includes("sur le site") && /^2027-01-03 18:00$/.test(fAlice.accord_le),
    "Fiche Alice : accords + preuve « " + (fAlice && fAlice.accord_par) + " » le " + (fAlice && fAlice.accord_le));
  n = G.mails.length; rr = await executerRappels(O); ok(rr.veille === 0 && G.mails.length === n, "Relancé le même jour : pas de doublon");

  process.env.OVH_APPLICATION_KEY = "appli-ovh"; process.env.OVH_APPLICATION_SECRET = "secret-ovh"; process.env.OVH_CONSUMER_KEY = "conso-ovh";
  process.env.OVH_SMS_SERVICE = "sms-test-1"; process.env.OVH_SMS_EXPEDITEUR = "CocoNails";
  aller("2027-01-04T18:00:00+01:00");
  await resa({ nom: "Chloé Sms", email: "chloe@example.com", telephone: "+33 7 12 34 56 78", soin: "Remplissage 3 semaines", date: "2027-01-06", debut: 540, ok_veille: true, ok_prochain: true });
  aller("2027-01-05T10:00:00+01:00");
  rr = await executerRappels(O);
  const s1 = G.sms.at(-1);
  ok(rr.veille === 1 && s1 && s1.receivers[0] === "+33712345678" && s1.noStopClause === true && s1.sender === "CocoNails", "Avec OVH : SMS de rappel à Chloé, sans mention STOP (service), expéditeur CocoNails");
  ok(s1.message.length <= 160 && enGsm(s1.message) === s1.message, `SMS de 1 crédit (${s1.message.length} caractères) : « ${s1.message} »`);
  const longue = smsVeille({ debut: "870", soin: "Remplissage 5 semaines ou plus + Nail art + French ou baby boomer" }, { adresse: "23 rue du Bonvouloir", ville: "Saint-Jean-du-Bois", telephone: "07 68 22 70 15" });
  ok(longue.length <= 160, `SMS raccourci si le soin est long (${longue.length} caractères)`);

  console.log("— Message « prochain soin »");
  r = await api();
  const la = r.vue.lignes.find((x) => x.cliente === "Alice Rappel");
  aller("2027-01-05T12:00:00+01:00");
  r = await api("valider", { id: la.id, montant: "30", paiement: "Espèces" });
  ok(r.statut === 200, "Le soin d'Alice est payé (pose semi-permanent, rappel conseillé à 21 jours)");
  aller("2027-01-25T10:00:00+01:00"); let avantSms = G.sms.length; rr = await executerRappels(O);
  ok(rr.prochain === 0, "Avant l'échéance (25/01) : rien");
  aller("2027-01-26T10:00:00+01:00"); rr = await executerRappels(O);
  const s2 = G.sms.slice(avantSms).find((x) => x.receivers[0] === "+33621223344");
  ok(rr.prochain === 1 && s2 && s2.noStopClause === false, "Le 26/01 : SMS « prochain soin » à Alice, avec STOP ajouté par OVH");
  ok(s2.message.includes("coconails72.com/rdv") && s2.message.length <= 140 && enGsm(s2.message) === s2.message, `Texte : « ${s2.message} » (${s2.message.length} car.)`);
  avantSms = G.sms.length; await executerRappels(O); ok(G.sms.length === avantSms, "Pas de second envoi le lendemain");
  aller("2027-02-14T10:00:00+01:00"); avantSms = G.sms.length; await executerRappels(O);
  ok(G.sms.length === avantSms, "14/02 est un dimanche : aucun message publicitaire");
  aller("2027-02-16T10:00:00+01:00"); avantSms = G.sms.length; rr = await executerRappels(O);
  ok(rr.prochain === 1 && G.sms.at(-1).message.startsWith("Coco Nail's : envie d'une pause beauté"), "3 semaines après : une seule relance");
  aller("2027-03-02T10:00:00+01:00"); avantSms = G.sms.length; await executerRappels(O); ok(G.sms.length === avantSms, "Après la relance : plus rien");

  r = await api(); ok(r.statut === 401, "Après 90 jours, la compta redemande le mot de passe");
  await api("connexion", { motdepasse: "Vernis-Rouge-2026" });
  r = await api(); const lc = r.vue.lignes.find((x) => x.cliente === "Chloé Sms");
  aller("2027-01-06T12:00:00+01:00"); await api("valider", { id: lc.id, montant: "35", paiement: "Espèces" });
  await api("ajouter", { origine: "Téléphone", cliente: "Chloé Sms", telephone: "+33 7 12 34 56 78", date: "2027-01-27", heure: "11:00", soin: "Remplissage 3 semaines", agenda: true });
  aller("2027-01-25T10:00:00+01:00"); avantSms = G.sms.length; await executerRappels(O);
  ok(!G.sms.slice(avantSms).some((x) => x.receivers[0] === "+33712345678" && !x.noStopClause), "Chloé a déjà repris rendez-vous : pas de message « prochain soin »");

  console.log("— STOP, désinscription et choix notés par Coralie");
  G.stop = ["+33621223344"];
  aller("2027-03-03T10:00:00+01:00"); await executerRappels(O);
  r = await api(); const fa2 = r.vue.clientes.find((c) => c.nom === "Alice Rappel");
  ok(fa2.stop_le && fa2.ok_prochain === "non", "Alice a répondu STOP : noté, plus de message « prochain soin »");
  const lien = corpsHtml(mAlice).match(/href="([^"]*\/api\/desinscription[^"]*)"/)[1].replace(/&amp;/g, "&");
  let pg = await desinscription(new Request(lien)); let txt = await pg.text();
  ok(pg.status === 200 && txt.includes('name="ok_veille"') && txt.includes("STOP"), "Page « Mes messages » : choix affichés, STOP signalé");
  const q = new URL(lien).searchParams;
  pg = await desinscription(new Request(O + "/api/desinscription", { method: "POST", body: new URLSearchParams({ id: q.get("id"), s: q.get("s") }) }));
  r = await api(); const fa3 = r.vue.clientes.find((c) => c.nom === "Alice Rappel");
  ok(pg.status === 200 && fa3.ok_veille === "non" && fa3.accord_par.includes("Gérer mes messages"), "Tout décoché par la cliente : enregistré avec la preuve");
  pg = await desinscription(new Request(lien.replace(/s=./, "s=Z"))); ok(pg.status === 403, "Lien falsifié : refusé");
  r = await api("ajouter", { origine: "Message", cliente: "Diane Oral", telephone: "06 55 44 33 22", date: "2027-03-03", soin: "Dépose", ok_veille: false, ok_prochain: true });
  const fd = r.vue.clientes.find((c) => c.nom === "Diane Oral");
  ok(fd && fd.ok_veille === "non" && fd.ok_prochain === "oui" && fd.accord_par.includes("noté par Coralie"), "RDV par message : choix de Diane notés par Coralie");
  r = await api("cliente", { nom: "Diane Oral", telephone: "06 55 44 33 22", ok_veille: true, ok_prochain: false });
  ok(r.vue.clientes.find((c) => c.nom === "Diane Oral").ok_veille === "oui", "Fiche cliente modifiée par Coralie");
  r = await api("cliente", { nom: "Alice Rappel", telephone: "06 21 22 33 44", ok_veille: true, ok_prochain: true });
  ok(r.statut === 409, "Impossible de réactiver le « prochain soin » après un STOP → " + r.erreur);
  r = await api("reglage", { rappels_auto: false });
  ok(r.vue.rappels.auto === false, "Rappels automatiques mis en pause");
  aller("2027-03-03T18:00:00+01:00");
  await resa({ nom: "Eva Pause", email: "eva@example.com", telephone: "06 12 12 12 12", soin: "Dépose", date: "2027-03-05", debut: 600, ok_veille: true });
  aller("2027-03-04T10:00:00+01:00"); avantSms = G.sms.length; rr = await executerRappels(O);
  ok(rr.veille === 0 && G.sms.length === avantSms, "En pause : aucun envoi");
  await api("reglage", { rappels_auto: true }); rr = await executerRappels(O); ok(rr.veille === 1, "Réactivés : le rappel d'Eva part");
  r = await api();
  ok(r.vue.rappels.envoyes.length >= 5 && r.vue.rappels.envoyes[0].canal === "SMS" && r.vue.clientes.find((c) => c.nom === "Eva Pause").rappels.length === 1,
    `Journal des rappels visible dans la compta (${r.vue.rappels.envoyes.length} envois)`);
  ok(smsProchain("Rallongement gel", "coconails72.com", false).length <= 140, "Texte « prochain soin » assez court pour la mention STOP");

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
