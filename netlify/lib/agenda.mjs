// Outils partagés : connexion à Google Agenda et règles de réservation de Coco Nail's.
// Variables d'environnement à définir dans Netlify (jamais dans le code) :
//   GOOGLE_CLIENT_EMAIL  adresse du compte de service Google
//   GOOGLE_PRIVATE_KEY   clé privée du compte de service (avec les \n)
//   GOOGLE_CALENDAR_ID   identifiant de l'agenda de Coralie (souvent son adresse Gmail)
// Pour la compta (page /compta) :
//   COMPTA_SHEET_ID      identifiant du tableau Google Sheets « Comptabilité Coco Nail's »
//   COMPTA_MOT_DE_PASSE  mot de passe de la page compta
// Facultatif :
//   GOOGLE_SENDER        adresse qui envoie les e-mails (par défaut GOOGLE_CALENDAR_ID)
//   NOTIFICATION_EMAIL   adresse qui reçoit les nouvelles demandes (par défaut GOOGLE_SENDER)
import { createSign, createHmac, timingSafeEqual, randomUUID } from "node:crypto";

const FUSEAU = "Europe/Paris";
const JOUR_MS = 86400000;
const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const SCOPE_AGENDA = "https://www.googleapis.com/auth/calendar";
const SCOPE_MAIL = "https://www.googleapis.com/auth/gmail.send";
export const SCOPE_TABLEAUX = "https://www.googleapis.com/auth/spreadsheets";

export function configuree() {
  return Boolean(process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY && process.env.GOOGLE_CALENDAR_ID);
}
export const expediteur = () => process.env.GOOGLE_SENDER || process.env.GOOGLE_CALENDAR_ID;
export const destinataireAlertes = () => process.env.NOTIFICATION_EMAIL || expediteur();

function b64url(x) {
  return Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString("base64url");
}

const jetons = new Map();
// Jeton d'accès Google. Avec « sub », le compte de service agit au nom de cette adresse
// (délégation au niveau du domaine, nécessaire pour envoyer des e-mails).
export async function jeton(scope = SCOPE_AGENDA, sub) {
  const maintenant = Math.floor(Date.now() / 1000);
  const k = scope + "|" + (sub || "");
  const c = jetons.get(k);
  if (c && c.exp - 60 > maintenant) return c.valeur;
  const entete = b64url({ alg: "RS256", typ: "JWT" });
  const charge = b64url({
    iss: process.env.GOOGLE_CLIENT_EMAIL,
    ...(sub ? { sub } : {}),
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: maintenant,
    exp: maintenant + 3600,
  });
  const signe = createSign("RSA-SHA256");
  signe.update(`${entete}.${charge}`);
  const cle = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");
  const signature = signe.sign(cle).toString("base64url");
  const rep = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${entete}.${charge}.${signature}`,
    }),
  });
  if (!rep.ok) throw new Error(`Connexion Google refusée (${rep.status})${sub ? " pour l'envoi d'e-mails : vérifier la délégation au niveau du domaine" : ""}`);
  const d = await rep.json();
  jetons.set(k, { valeur: d.access_token, exp: maintenant + (d.expires_in || 3600) });
  return d.access_token;
}

// Plages occupées entre deux dates (format RFC 3339). Renvoie [{start, end}] sans aucun détail.
export async function occupe(debutIso, finIso) {
  const id = process.env.GOOGLE_CALENDAR_ID;
  const rep = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${await jeton()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: debutIso, timeMax: finIso, timeZone: FUSEAU, items: [{ id }] }),
  });
  if (!rep.ok) throw new Error(`Lecture de l'agenda impossible (${rep.status})`);
  const d = await rep.json();
  const cal = d.calendars && d.calendars[id];
  if (!cal || (cal.errors && cal.errors.length)) throw new Error("Agenda inaccessible : vérifier le partage avec le compte de service");
  return (cal.busy || []).map((b) => ({ start: b.start, end: b.end }));
}

const urlEvenements = () => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(process.env.GOOGLE_CALENDAR_ID)}/events`;

// Identifiant d'événement choisi par le site (lettres a-v et chiffres, accepté par Google Agenda).
export const nouvelId = () => "coco" + randomUUID().replace(/-/g, "");

export async function creerRendezVous({ id, date, debut, fin, titre, description, infos, couleur = "5" }) {
  const rep = await fetch(urlEvenements(), {
    method: "POST",
    headers: { Authorization: `Bearer ${await jeton()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(id ? { id } : {}),
      summary: titre,
      description,
      colorId: couleur,
      start: { dateTime: `${date}T${hhmm(debut)}:00`, timeZone: FUSEAU },
      end: { dateTime: `${date}T${hhmm(fin)}:00`, timeZone: FUSEAU },
      reminders: { useDefault: true },
      ...(infos ? { extendedProperties: { private: infos } } : {}),
    }),
  });
  if (!rep.ok) throw new Error(`Création du rendez-vous impossible (${rep.status})`);
  return rep.json();
}

// Renvoie l'événement, ou null s'il a été supprimé.
export async function lireRendezVous(id) {
  const rep = await fetch(`${urlEvenements()}/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${await jeton()}` } });
  if (rep.status === 404 || rep.status === 410) return null;
  if (!rep.ok) throw new Error(`Lecture du rendez-vous impossible (${rep.status})`);
  const ev = await rep.json();
  return ev.status === "cancelled" ? null : ev;
}

export async function modifierRendezVous(id, changements) {
  const rep = await fetch(`${urlEvenements()}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${await jeton()}`, "Content-Type": "application/json" },
    body: JSON.stringify(changements),
  });
  if (!rep.ok) throw new Error(`Modification du rendez-vous impossible (${rep.status})`);
  return rep.json();
}

// Tous les événements entre deux instants (ISO), répétitions dépliées.
export async function listerRendezVous(debutIso, finIso) {
  const tous = [];
  let page = "";
  do {
    const q = new URLSearchParams({ timeMin: debutIso, timeMax: finIso, singleEvents: "true", orderBy: "startTime", maxResults: "2500", ...(page ? { pageToken: page } : {}) });
    const rep = await fetch(`${urlEvenements()}?${q}`, { headers: { Authorization: `Bearer ${await jeton()}` } });
    if (!rep.ok) throw new Error(`Lecture de l'agenda impossible (${rep.status})`);
    const d = await rep.json();
    tous.push(...(d.items || []));
    page = d.nextPageToken || "";
  } while (page);
  return tous.filter((e) => e.status !== "cancelled");
}

export async function supprimerRendezVous(id) {
  const rep = await fetch(`${urlEvenements()}/${encodeURIComponent(id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${await jeton()}` } });
  if (!rep.ok && rep.status !== 404 && rep.status !== 410) throw new Error(`Suppression du rendez-vous impossible (${rep.status})`);
}

// ---- Liens Confirmer / Refuser, signés pour que personne d'autre que Coralie ne puisse les fabriquer ----
function cleSignature() {
  return createHmac("sha256", "coco-nails-liens").update(process.env.GOOGLE_PRIVATE_KEY || "").digest();
}
export function signer(id, action) {
  return createHmac("sha256", cleSignature()).update(`${id}:${action}`).digest("base64url").slice(0, 32);
}
export function signatureValide(id, action, s) {
  const attendu = Buffer.from(signer(id, action)), recu = Buffer.from(String(s || ""));
  return attendu.length === recu.length && timingSafeEqual(attendu, recu);
}
export const lienAction = (origine, id, action) => `${origine}/api/rdv?id=${encodeURIComponent(id)}&a=${action}&s=${signer(id, action)}`;

// ---- Envoi d'e-mails depuis l'adresse de Coralie (API Gmail) ----
const enteteUtf8 = (t) => `=?UTF-8?B?${Buffer.from(t).toString("base64")}?=`;
const b64lignes = (t) => Buffer.from(t).toString("base64").replace(/.{76}/g, "$&\r\n");
const sansSaut = (t) => String(t).replace(/[\r\n]+/g, " ");

// pieces : [{ nom, type, donnees (Buffer) }] — par exemple une facture PDF.
export async function envoyerMail({ a, sujet, texte, html, ics, repondreA, pieces = [] }) {
  const de = expediteur();
  const f = "m" + randomUUID().replace(/-/g, ""), g = "a" + randomUUID().replace(/-/g, "");
  const lignes = [
    `From: ${enteteUtf8("Coco Nail's")} <${de}>`,
    `To: ${sansSaut(a)}`,
    `Reply-To: ${sansSaut(repondreA || de)}`,
    `Subject: ${enteteUtf8(sansSaut(sujet))}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${f}"`,
    "",
    `--${f}`,
    `Content-Type: multipart/alternative; boundary="${g}"`,
    "",
    `--${g}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64lignes(texte),
    `--${g}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64lignes(html),
    `--${g}--`,
  ];
  if (ics) lignes.push(`--${f}`, 'Content-Type: text/calendar; charset=UTF-8; method=PUBLISH; name="rendez-vous-coco-nails.ics"',
    'Content-Disposition: attachment; filename="rendez-vous-coco-nails.ics"', "Content-Transfer-Encoding: base64", "", b64lignes(ics));
  for (const p of pieces) {
    const nom = sansSaut(p.nom).replace(/["\\]/g, "");
    lignes.push(`--${f}`, `Content-Type: ${p.type}; name="${nom}"`, `Content-Disposition: attachment; filename="${nom}"`,
      "Content-Transfer-Encoding: base64", "", Buffer.from(p.donnees).toString("base64").replace(/.{76}/g, "$&\r\n"));
  }
  lignes.push(`--${f}--`, "");
  const rep = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${await jeton(SCOPE_MAIL, de)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: Buffer.from(lignes.join("\r\n")).toString("base64url") }),
  });
  if (!rep.ok) throw new Error(`Envoi de l'e-mail impossible (${rep.status})`);
  return rep.json();
}

// ---- Heure de Paris ----
export function hhmm(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
export function enMinutes(h) {
  const m = /^(\d{1,2})[:h ]?(\d{2})?$/.exec(String(h || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2] || 0) : null;
}
// Décalage UTC de Paris (en minutes) pour une date donnée.
export function decalageParis(ms) {
  const p = {};
  new Intl.DateTimeFormat("en-US", { timeZone: FUSEAU, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms)).forEach((x) => (p[x.type] = x.value));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - ms) / 60000;
}
// « 2026-11-12 » + minutes locales de Paris -> instant UTC (ms).
export function instant(date, minutes) {
  const [a, m, j] = date.split("-").map(Number);
  const naif = Date.UTC(a, m - 1, j) + minutes * 60000;
  return naif - decalageParis(naif) * 60000;
}
export function aujourdhuiParis() {
  const ms = Date.now() + decalageParis(Date.now()) * 60000;
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// ---- Jours fériés (France métropolitaine) ----
function paques(a) {
  const b = a % 19, c = Math.floor(a / 100), d = a % 100, e = Math.floor(c / 4), f = c % 4, g = Math.floor((c + 8) / 25),
    h = Math.floor((c - g + 1) / 3), i = (19 * b + c - e - h + 15) % 30, k = Math.floor(d / 4), l = d % 4,
    m = (32 + 2 * f + 2 * k - i - l) % 7, n = Math.floor((b + 11 * i + 22 * m) / 451),
    mo = Math.floor((i + m - 7 * n + 114) / 31), j = ((i + m - 7 * n + 114) % 31) + 1;
  return Date.UTC(a, mo - 1, j);
}
const cle = (t) => new Date(t).toISOString().slice(0, 10);
export function ferie(t) {
  const a = new Date(t).getUTCFullYear(), p = paques(a);
  const liste = [Date.UTC(a, 0, 1), p + JOUR_MS, Date.UTC(a, 4, 1), Date.UTC(a, 4, 8), p + 39 * JOUR_MS, p + 50 * JOUR_MS,
    Date.UTC(a, 6, 14), Date.UTC(a, 7, 15), Date.UTC(a, 10, 1), Date.UTC(a, 10, 11), Date.UTC(a, 11, 25)].map(cle);
  return liste.includes(cle(t));
}

// ---- Contenus du site ----
export async function contenu(origine, nom) {
  const rep = await fetch(new URL(`/contenu/${nom}.json`, origine), { headers: { "Cache-Control": "no-cache" } });
  if (!rep.ok) throw new Error(`Contenu ${nom} introuvable`);
  return rep.json();
}

// Vérifie qu'une demande respecte les règles du site. Renvoie {ok, erreur, duree, soin, options}.
export function verifier({ soins, coordonnees, reservation }, demande) {
  const soin = (soins.soins || []).find((s) => s.nom === demande.soin);
  if (!soin || !soin.duree) return { ok: false, erreur: "Soin inconnu." };
  const noms = Array.isArray(demande.options) ? demande.options : [];
  const options = noms.map((n) => (soins.options || []).find((o) => o.nom === n));
  if (options.some((o) => !o)) return { ok: false, erreur: "Option inconnue." };
  if (options.length && soin.options_possibles === false) return { ok: false, erreur: "Pas d'option possible pour ce soin." };
  const duree = Number(soin.duree) + options.reduce((a, o) => a + (Number(o.duree) || 0), 0);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(demande.date || "")) return { ok: false, erreur: "Date invalide." };
  const debut = Number(demande.debut);
  if (!Number.isInteger(debut)) return { ok: false, erreur: "Heure invalide." };
  const t = Date.parse(`${demande.date}T00:00:00Z`);
  const ecart = Math.round((t - aujourdhuiParis()) / JOUR_MS);
  const min = reservation.delai_min_jours == null ? 1 : Number(reservation.delai_min_jours);
  const max = Number(reservation.delai_max_jours) || 60;
  if (reservation.active === false) return { ok: false, erreur: "La réservation en ligne est fermée." };
  if (ecart < min || ecart > max) return { ok: false, erreur: "Cette date n'est pas réservable en ligne." };
  if (ferie(t)) return { ok: false, erreur: "Jour férié : contactez Coralie." };
  const k = cle(t);
  const ferme = (coordonnees.fermetures || []).some((f) => f && f.du && k >= String(f.du).slice(0, 10) && k <= String(f.au || f.du).slice(0, 10));
  if (ferme) return { ok: false, erreur: "Coco Nail's est fermé ce jour-là." };
  const h = (coordonnees.semaine || {})[JOURS[new Date(t).getUTCDay()]];
  const o = h && h.ouvert ? enMinutes(h.debut) : null, f = h && h.ouvert ? enMinutes(h.fin) : null;
  if (o == null || f == null || debut < o || debut + duree > f) return { ok: false, erreur: "Ce créneau est en dehors des horaires." };
  return { ok: true, duree, soin, options };
}

export function json(donnees, statut = 200) {
  return new Response(JSON.stringify(donnees), {
    status: statut,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
