// Rappels automatiques aux clientes, chaque matin vers 10 h :
//  1. la veille d'un rendez-vous confirmé (message de service, sauf si la cliente a décoché) ;
//  2. « votre prochain soin approche », selon le délai du soin, seulement aux clientes qui l'ont accepté,
//     sans rendez-vous déjà prévu, jamais le dimanche ni un jour férié ; une seule relance 3 semaines après.
// Par SMS (OVHcloud) si un portable est connu et les clés OVH présentes, sinon par e-mail.
import { configuree, contenu, envoyerMail, hhmm, enMinutes, ferie } from "../lib/agenda.mjs";
import * as C from "../lib/compta.mjs";
import { smsConfigure, envoyerSms, portable, listeStop } from "../lib/sms.mjs";
import { rappelVeilleMail, prochainSoinMail } from "../lib/messages.mjs";

const PREFIXE = /^\s*À confirmer\s*:/i;
const JOUR_MS = 86400000;
const plusJours = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * JOUR_MS).toISOString().slice(0, 10);
const { lienGestion } = C;

const heureCourte = (min) => { const [h, m] = hhmm(min).split(":"); return `${Number(h)}h${m === "00" ? "" : m}`; };

// Textes des SMS (160 caractères au plus pour ne consommer qu'un crédit).
export function smsVeille(i, c) {
  const base = `Coco Nail's : rappel de votre RDV demain à ${heureCourte(Number(i.debut))}`;
  const lieu = [c.adresse, c.ville].filter(Boolean).join(", ");
  const tel = c.telephone ? ` Un imprévu ? Prévenez Coralie au ${c.telephone}` : "";
  let t = `${base} (${i.soin}). ${lieu}.${tel}`;
  if (t.length > 160) t = `${base}. ${lieu}.${tel}`;
  if (t.length > 160) t = `${base}.${tel}`;
  return t;
}
export function smsProchain(soin, site, relance) {
  if (relance) return `Coco Nail's : envie d'une pause beauté ? Coralie serait ravie de vous revoir. Réservez en 1 min sur ${site}/rdv`;
  return `Coco Nail's : il est temps de penser à votre prochaine pause beauté ! Réservez en 1 min sur ${site}/rdv - Coralie`;
}

export async function executerRappels(origine) {
  const resultat = { veille: 0, prochain: 0, echecs: 0 };
  const d = await C.lireTout();
  const [soins, coord] = await Promise.all(["soins", "coordonnees"].map((n) => contenu(origine, n)));
  await C.synchroniser(d, soins);
  if (d.reglages.rappels_auto === "non") return resultat;
  const sms = smsConfigure();
  const site = new URL(origine).host.replace(/^www\./, "");

  // Clientes qui ont répondu STOP (liste tenue par OVHcloud) : plus aucun message « prochain soin ».
  if (sms) {
    try {
      const stop = new Set(await listeStop());
      for (const c of d.clientes) if (!c.stop_le && stop.has(portable(c.telephone))) { c.stop_le = C.horodatage(); c.ok_prochain = "non"; await C.majCliente(c); }
    } catch (e) { console.error(e); }
  }

  const deja = new Set(d.rappels.filter((r) => r.resultat === "envoyé").map((r) => r.ref));
  async function envoyer({ type, ref, cliente, telephone, email, texteSms, mail, commercial }) {
    let canal = "", res = "envoyé", detail = "";
    try {
      if (sms && portable(telephone)) {
        canal = "SMS";
        const r = await envoyerSms({ a: telephone, texte: texteSms, commercial });
        detail = r.id ? `OVHcloud n° ${r.id}` : "";
      } else if (email) {
        canal = "E-mail";
        await envoyerMail({ a: email, ...mail });
      } else return;
    } catch (e) { console.error(e); res = "échec"; detail = String(e.message || e).slice(0, 200); resultat.echecs++; }
    await C.noterRappel({ type, canal, client: cliente.id, cliente: cliente.nom, ref, resultat: res, detail }, d);
    if (res === "envoyé") { deja.add(ref); resultat[type === "Veille" ? "veille" : "prochain"]++; }
  }

  // 1. Rappel la veille
  const auj = C.aujourdhui(), demain = plusJours(auj, 1);
  for (const ev of d.evenements || []) {
    const p = ev.extendedProperties && ev.extendedProperties.private;
    const debut = ev.start && ev.start.dateTime, fin = ev.end && ev.end.dateTime;
    if (!p || !p.id || !debut || PREFIXE.test(ev.summary || "") || debut.slice(0, 10) !== demain) continue;
    const ref = `veille:${ev.id}:${debut.slice(0, 16)}`;
    if (deja.has(ref)) continue;
    let cliente = C.trouverCliente(d, p.telephone, p.email);
    if (cliente ? cliente.ok_veille === "non" : p.ok_veille === "non") continue;
    // Réservation faite avant l'arrivée des cases à cocher : le rappel de service est envoyé par défaut.
    if (!cliente) cliente = await C.enregistrerAccord(d, { nom: p.nom, telephone: p.telephone, email: p.email, ok_veille: true, ok_prochain: false,
      par: "rappel de service par défaut (réservation sans choix enregistré)", le: C.horodatage() });
    if (!cliente) continue;
    const i = { ...p, date: demain, debut: String(enMinutes(debut.slice(11, 16))), fin: String(enMinutes((fin || debut).slice(11, 16))) };
    await envoyer({ type: "Veille", ref, cliente, telephone: p.telephone, email: p.email, commercial: false,
      texteSms: smsVeille(i, coord), mail: rappelVeilleMail(i, coord, lienGestion(origine, cliente.id)) });
  }

  // 2. « Votre prochain soin approche » (jamais le dimanche ni un jour férié)
  const t = Date.parse(auj + "T00:00:00Z");
  if (new Date(t).getUTCDay() !== 0 && !ferie(t)) {
    for (const c of d.clientes) {
      if (c.ok_prochain !== "oui" || c.stop_le) continue;
      const memeCliente = (tel, mail) => { const k = C.cleCliente(tel, mail); return k === c.cle || (mail && c.email && mail.toLowerCase() === c.email.toLowerCase()); };
      const lignes = d.lignes.filter((l) => memeCliente(l.telephone, l.email));
      const faites = lignes.filter((l) => l.etat === C.ETATS.validee).sort((a, b) => (a.date < b.date ? -1 : 1));
      const derniere = faites[faites.length - 1];
      if (!derniere) continue;
      const jours = C.joursRappel(soins, derniere.soin);
      if (!jours) continue;
      // Un autre rendez-vous est déjà prévu (compta ou agenda, même en attente de confirmation) : rien à envoyer.
      if (lignes.some((l) => l.date > derniere.date && l.etat !== C.ETATS.annulee)) continue;
      if ((d.evenements || []).some((ev) => { const p = ev.extendedProperties && ev.extendedProperties.private;
        return p && ev.start && ev.start.dateTime && ev.start.dateTime.slice(0, 10) > derniere.date && memeCliente(p.telephone, p.email); })) continue;
      const echeance = plusJours(derniere.date, jours);
      if (auj < echeance || auj > plusJours(echeance, 60)) continue;
      const refP = `prochain:${derniere.id}`, refR = `relance:${derniere.id}`;
      const relance = deja.has(refP);
      if (relance && (deja.has(refR) || auj < plusJours(echeance, 21))) continue;
      await envoyer({ type: relance ? "Relance" : "Prochain soin", ref: relance ? refR : refP, cliente: c, telephone: c.telephone, email: c.email, commercial: true,
        texteSms: smsProchain(derniere.soin, site, relance),
        mail: prochainSoinMail({ nom: c.nom, soin: derniere.soin, relance }, origine, lienGestion(origine, c.id)) });
    }
  }
  return resultat;
}

export default async () => {
  if (!C.comptaConfiguree() || !configuree()) return;
  try { console.log(await executerRappels(process.env.URL || "https://coconails72.com")); } catch (e) { console.error(e); }
};

// Tous les jours à 9 h (heure universelle), soit 10 h à Paris en hiver, 11 h en été.
export const config = { schedule: "0 9 * * *" };
