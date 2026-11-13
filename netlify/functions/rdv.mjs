// Boutons « Confirmer » / « Refuser » de Coralie.
// GET  /api/rdv?id=…&a=confirmer|refuser&s=…  affiche le rendez-vous et un bouton de validation
//      (rien n'est modifié à l'ouverture : les messageries ouvrent parfois les liens toutes seules pour les analyser).
// POST /api/rdv                               applique le choix, puis prévient la cliente par e-mail.
import { configuree, signatureValide, lireRendezVous, modifierRendezVous, supprimerRendezVous, envoyerMail, contenu, enMinutes } from "../lib/agenda.mjs";
import { page, resume, esc, confirmationCliente, refusCliente } from "../lib/messages.mjs";

const PREFIXE = /^\s*À confirmer\s*:\s*/i;

// Infos de la cliente + date et heure réelles de l'événement (Coralie a pu le déplacer dans son agenda).
function infosDe(ev) {
  const i = { ...((ev.extendedProperties && ev.extendedProperties.private) || {}) };
  const d = ev.start && ev.start.dateTime, f = ev.end && ev.end.dateTime;
  if (d && f) {
    i.date = d.slice(0, 10);
    i.debut = String(enMinutes(d.slice(11, 16)));
    i.fin = String(enMinutes(f.slice(11, 16)));
  }
  return i.nom && i.email && i.date ? i : null;
}

const NOMS = { confirmer: "Confirmer le rendez-vous", refuser: "Refuser le rendez-vous" };

export default async (req) => {
  if (!configuree()) return page("Agenda non relié", "<p>L'agenda Google n'est pas encore relié au site.</p>", 503);
  let p;
  if (req.method === "POST") {
    const f = await req.formData().catch(() => null);
    p = f ? { id: f.get("id"), a: f.get("a"), s: f.get("s") } : {};
  } else {
    const u = new URL(req.url).searchParams;
    p = { id: u.get("id"), a: u.get("a"), s: u.get("s") };
  }
  if (!NOMS[p.a] || !p.id || !signatureValide(p.id, p.a, p.s)) return page("Lien non valide", "<p>Ce lien est incomplet ou n'a pas été créé par le site Coco Nail's.</p>", 403);

  let ev;
  try { ev = await lireRendezVous(p.id); } catch (e) { console.error(e); return page("Agenda indisponible", "<p>Impossible de joindre l'agenda pour le moment. Réessayez dans quelques minutes.</p>", 503); }
  if (!ev) return page("Rendez-vous introuvable", "<p>Ce rendez-vous a déjà été refusé ou supprimé de l'agenda. Le créneau est libre.</p>");
  const i = infosDe(ev);
  if (!i) return page("Rendez-vous incomplet", "<p>Ce rendez-vous ne contient pas les coordonnées de la cliente. Prévenez-la directement.</p>");
  const enAttente = PREFIXE.test(ev.summary || "");

  if (!enAttente) {
    return page("Déjà confirmé", `${resume(i)}<p>Ce rendez-vous est déjà confirmé.${p.a === "refuser" ? " Pour l'annuler, supprimez-le dans votre agenda et prévenez la cliente." : ""}</p>`);
  }

  if (req.method !== "POST") {
    const couleur = p.a === "confirmer" ? "vert" : "gris";
    const explication = p.a === "confirmer"
      ? "La cliente recevra un e-mail de confirmation avec la date, l'adresse et le rappel des 48 h."
      : "Le créneau sera libéré, et la cliente recevra un e-mail l'invitant à choisir un autre créneau.";
    return page(p.a === "confirmer" ? "Confirmer ?" : "Refuser ?", `${resume(i)}<p>${explication}</p>
<form method="POST" action="/api/rdv"><input type="hidden" name="id" value="${esc(p.id)}"><input type="hidden" name="a" value="${esc(p.a)}"><input type="hidden" name="s" value="${esc(p.s)}">
<button class="${couleur}" type="submit">${esc(NOMS[p.a])}</button></form>`);
  }

  const origine = new URL(req.url).origin;
  try {
    if (p.a === "confirmer") {
      await modifierRendezVous(p.id, { summary: (ev.summary || "").replace(PREFIXE, ""), colorId: "10" });
    } else {
      await supprimerRendezVous(p.id);
    }
  } catch (e) {
    console.error(e);
    return page("Action impossible", "<p>L'agenda n'a pas pu être modifié. Réessayez dans quelques minutes.</p>", 503);
  }

  let envoye = true;
  try {
    if (p.a === "confirmer") {
      const coordonnees = await contenu(origine, "coordonnees");
      await envoyerMail({ a: i.email, ...confirmationCliente(i, coordonnees, origine) });
    } else {
      await envoyerMail({ a: i.email, ...refusCliente(i, origine) });
    }
  } catch (e) {
    console.error(e);
    envoye = false;
  }
  const appel = `<a class="lien" href="tel:${esc(String(i.telephone).replace(/[^\d+]/g, ""))}">Appeler ${esc(i.nom)}</a>`;
  if (p.a === "confirmer") {
    return page("Rendez-vous confirmé", `${resume(i)}<p>${envoye ? `C'est noté en vert dans votre agenda, et ${esc(i.nom)} a reçu l'e-mail de confirmation.` : `C'est noté dans votre agenda, mais l'e-mail n'a pas pu partir : prévenez ${esc(i.nom)} par téléphone ou par SMS.`}</p>${envoye ? "" : appel}`);
  }
  return page("Rendez-vous refusé", `${resume(i)}<p>Le créneau est libéré${envoye ? `, et ${esc(i.nom)} a reçu un e-mail l'invitant à choisir un autre créneau.` : `. L'e-mail n'a pas pu partir : prévenez ${esc(i.nom)} par téléphone ou par SMS.`}</p>${envoye ? "" : appel}`);
};

export const config = { path: "/api/rdv" };
