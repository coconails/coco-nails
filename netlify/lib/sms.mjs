// Envoi de SMS par OVHcloud (crédits prépayés, sans abonnement).
// Variables Netlify (secrètes) :
//   OVH_APPLICATION_KEY, OVH_APPLICATION_SECRET, OVH_CONSUMER_KEY   clés créées sur eu.api.ovh.com/createToken
//   OVH_SMS_SERVICE      nom du compte SMS, par exemple « sms-ab12345-1 »
// Facultatif :
//   OVH_SMS_EXPEDITEUR   nom d'expéditeur validé chez OVH (par exemple « CocoNails »)
import { createHash } from "node:crypto";

const API = "https://eu.api.ovh.com/1.0";
export const smsConfigure = () =>
  Boolean(process.env.OVH_APPLICATION_KEY && process.env.OVH_APPLICATION_SECRET && process.env.OVH_CONSUMER_KEY && process.env.OVH_SMS_SERVICE);

let decalage = null; // écart entre l'horloge d'OVH et la nôtre, en secondes
async function horodatage() {
  if (decalage === null) {
    try {
      const r = await fetch(`${API}/auth/time`);
      decalage = r.ok ? Number(await r.text()) - Math.floor(Date.now() / 1000) : 0;
    } catch { decalage = 0; }
  }
  return Math.floor(Date.now() / 1000) + decalage;
}

async function ovh(methode, chemin, corps) {
  const url = API + chemin, texte = corps ? JSON.stringify(corps) : "";
  const t = String(await horodatage());
  const signature = "$1$" + createHash("sha1").update([process.env.OVH_APPLICATION_SECRET, process.env.OVH_CONSUMER_KEY, methode, url, texte, t].join("+")).digest("hex");
  const rep = await fetch(url, {
    method: methode,
    headers: { "X-Ovh-Application": process.env.OVH_APPLICATION_KEY, "X-Ovh-Consumer": process.env.OVH_CONSUMER_KEY,
      "X-Ovh-Timestamp": t, "X-Ovh-Signature": signature, ...(texte ? { "Content-Type": "application/json" } : {}) },
    body: texte || undefined,
  });
  if (!rep.ok) {
    let detail = ""; try { detail = (await rep.json()).message || ""; } catch {}
    throw new Error(`OVHcloud SMS : erreur ${rep.status} ${detail}`.trim());
  }
  return rep.json();
}

// Numéro français au format international (+33…), ou "" si ce n'est pas un portable français.
export function portable(t) {
  let c = String(t || "").replace(/[^\d+]/g, "");
  if (c.startsWith("00")) c = "+" + c.slice(2);
  if (/^0[67]\d{8}$/.test(c)) c = "+33" + c.slice(1);
  if (/^33[67]\d{8}$/.test(c)) c = "+" + c;
  return /^\+33[67]\d{8}$/.test(c) ? c : "";
}

// Les SMS « simples » (160 caractères) n'acceptent pas tous les accents : ê, â, ç, emojis… doublent le coût.
const REMPLACE = { "ê": "e", "ë": "e", "â": "a", "ä": "a", "î": "i", "ï": "i", "ô": "o", "ö": "o", "û": "u", "ü": "u", "ç": "c", "œ": "oe", "Œ": "OE",
  "Ê": "E", "È": "E", "À": "A", "Â": "A", "Î": "I", "Ô": "O", "Û": "U", "’": "'", "‘": "'", "“": '"', "”": '"', "«": '"', "»": '"', "…": "...", "–": "-", "—": "-", " ": " ", " ": " " };
const GSM = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
export const enGsm = (t) => [...String(t)].map((c) => REMPLACE[c] ?? (GSM.includes(c) ? c : "")).join("").replace(/ {2,}/g, " ").trim();

// Envoie un SMS. commercial = true : OVH ajoute lui-même la mention « STOP au … » et gère les désinscrits.
export async function envoyerSms({ a, texte, commercial = false }) {
  const numero = portable(a);
  if (!numero) throw new Error("Numéro de portable français invalide");
  const corps = { message: enGsm(texte), receivers: [numero], noStopClause: !commercial, priority: "high",
    ...(process.env.OVH_SMS_EXPEDITEUR ? { sender: process.env.OVH_SMS_EXPEDITEUR } : { senderForResponse: true }) };
  const r = await ovh("POST", `/sms/${encodeURIComponent(process.env.OVH_SMS_SERVICE)}/jobs`, corps);
  if (r.invalidReceivers && r.invalidReceivers.length) throw new Error("Numéro refusé par OVHcloud");
  return { id: (r.ids || [])[0], credits: r.totalCreditsRemoved };
}

// Numéros qui ont répondu STOP (liste tenue par OVH).
export async function listeStop() {
  const r = await ovh("GET", `/sms/${encodeURIComponent(process.env.OVH_SMS_SERVICE)}/blacklists`);
  return (Array.isArray(r) ? r : []).map(portable).filter(Boolean);
}
