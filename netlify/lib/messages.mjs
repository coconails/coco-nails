// Textes des e-mails et des pages de confirmation de Coco Nail's.
import { hhmm, instant } from "./agenda.mjs";

const BORDEAUX = "#5e0f1c", ROSE = "#fbe6e8", ENCRE = "#24161a";

export const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// « lundi 23 novembre 2026 »
export function jourLong(date) {
  const [a, m, j] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(a, m - 1, j)));
}
// « 14 h » ou « 9 h 30 »
export const heure = (min) => { const [h, m] = hhmm(min).split(":"); return `${Number(h)} h${m === "00" ? "" : " " + m}`; };
export const quand = (i) => `${jourLong(i.date)} à ${heure(Number(i.debut))}`;

const adresseComplete = (c) => [c.adresse, [c.code_postal, c.ville].filter(Boolean).join(" ")].filter(Boolean).join(", ");

// Liens Appeler / WhatsApp, si un numéro est rempli dans l'espace de gestion.
function liensDirects(c) {
  if (!c || !c.telephone) return null;
  const chiffres = String(c.telephone).replace(/[^\d+]/g, "");
  let intl = chiffres.replace(/^\+/, "").replace(/^00/, "");
  if (/^0\d{9}$/.test(intl)) intl = "33" + intl.slice(1);
  const mot = c.message_whatsapp || "Bonjour Coralie, je vous contacte depuis le site Coco Nail's.";
  return { tel: "tel:" + chiffres, wa: c.whatsapp === false ? null : `https://wa.me/${intl}?text=${encodeURIComponent(mot)}`, affiche: c.telephone };
}
function blocContact(c) {
  const l = liensDirects(c);
  if (!l) return "";
  return `<p style="margin:14px 0 4px">${bouton(l.tel, "Appeler Coralie")}${l.wa ? bouton(l.wa, "Écrire sur WhatsApp", "#1f7a4a") : ""}</p>`;
}
const texteContact = (c) => { const l = liensDirects(c); return l ? `\nTéléphone${l.wa ? " et WhatsApp" : ""} : ${l.affiche}` : ""; };

function bouton(href, texte, couleur = BORDEAUX) {
  return `<a href="${esc(href)}" style="display:inline-block;background:${couleur};color:#ffffff;text-decoration:none;font-weight:700;padding:14px 26px;border-radius:999px;margin:6px 8px 6px 0">${esc(texte)}</a>`;
}
function tableau(lignes) {
  return `<table role="presentation" style="border-collapse:collapse;margin:16px 0;font-size:15px">${lignes
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><td style="padding:6px 16px 6px 0;color:#7a5a60;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;font-weight:600">${v}</td></tr>`)
    .join("")}</table>`;
}
function gabarit(titre, corps) {
  return `<!doctype html><html lang="fr"><body style="margin:0;background:${ROSE};padding:24px 12px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:${ENCRE}">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:18px;padding:28px 24px">
<p style="margin:0 0 4px;font-family:Georgia,serif;font-style:italic;font-size:22px;color:${BORDEAUX}">Coco Nail's</p>
<h1 style="margin:0 0 16px;font-family:Georgia,serif;font-style:italic;font-size:26px;color:${BORDEAUX};font-weight:600">${esc(titre)}</h1>
${corps}
</div></body></html>`;
}
const para = (t) => `<p style="margin:0 0 12px;line-height:1.55">${t}</p>`;

function lignesRdv(i) {
  return [
    ["Soin", esc(i.soin) + (i.prix ? ` (${esc(i.prix)})` : "")],
    ["Options", i.options ? esc(i.options) : ""],
    ["Quand", esc(quand(i))],
    ["Horaire", `${esc(heure(Number(i.debut)))} à ${esc(heure(Number(i.fin)))}`],
  ];
}

// 1. Pour Coralie : nouvelle demande, avec les boutons Confirmer / Refuser.
export function alerteCoralie(i, liens) {
  const sujet = `Nouvelle demande : ${i.nom}, ${quand(i)}`;
  const html = gabarit("Nouvelle demande de rendez-vous", [
    tableau([
      ["Cliente", esc(i.nom)],
      ["Téléphone", `<a href="tel:${esc(i.telephone.replace(/[^\d+]/g, ""))}" style="color:${BORDEAUX}">${esc(i.telephone)}</a>`],
      ["E-mail", `<a href="mailto:${esc(i.email)}" style="color:${BORDEAUX}">${esc(i.email)}</a>`],
      ...lignesRdv(i),
      ["Message", i.message ? esc(i.message).replace(/\n/g, "<br>") : ""],
    ]),
    para("Le créneau est déjà bloqué sur le site et noté en jaune « À confirmer » dans votre agenda."),
    `<p style="margin:18px 0">${bouton(liens.confirmer, "Confirmer le rendez-vous", "#2f6b3a")}${bouton(liens.refuser, "Refuser", "#8a7a7d")}</p>`,
    para(`<span style="color:#7a5a60;font-size:13px">En confirmant, la cliente reçoit automatiquement un e-mail avec la date, l'adresse et le rappel des 48 h. En refusant, le créneau se libère et la cliente est invitée à en choisir un autre.</span>`),
  ].join(""));
  const texte = `Nouvelle demande de rendez-vous

Cliente : ${i.nom}
Téléphone : ${i.telephone}
E-mail : ${i.email}
Soin : ${i.soin}${i.options ? "\nOptions : " + i.options : ""}
Quand : ${quand(i)} (jusqu'à ${heure(Number(i.fin))})${i.message ? "\nMessage : " + i.message : ""}

Confirmer : ${liens.confirmer}
Refuser : ${liens.refuser}`;
  return { sujet, html, texte };
}

// 2. Pour la cliente, tout de suite : demande bien reçue.
export function accuseCliente(i, c) {
  const sujet = "Votre demande de rendez-vous chez Coco Nail's";
  const html = gabarit("Demande bien reçue", [
    para(`Bonjour ${esc(i.nom)},`),
    para("Merci pour votre demande. Votre créneau est réservé, en attente de confirmation par Coralie. Vous recevrez un e-mail dès qu'elle l'aura confirmé."),
    tableau(lignesRdv(i)),
    para(`Une question ? Répondez simplement à cet e-mail${c.telephone ? " ou contactez Coralie directement&nbsp;:" : "."}`),
    blocContact(c),
  ].join(""));
  const texte = `Bonjour ${i.nom},

Merci pour votre demande. Votre créneau est réservé, en attente de confirmation par Coralie. Vous recevrez un e-mail dès qu'elle l'aura confirmé.

Soin : ${i.soin}${i.options ? "\nOptions : " + i.options : ""}
Quand : ${quand(i)}

Une question ? Répondez simplement à cet e-mail.${texteContact(c)}
Coco Nail's`;
  return { sujet, html, texte };
}

// 3. Pour la cliente : rendez-vous confirmé, avec le fichier agenda.
export function confirmationCliente(i, c, origine) {
  const sujet = `Rendez-vous confirmé : ${quand(i)}`;
  const adr = adresseComplete(c);
  const debut = new Date(instant(i.date, Number(i.debut))), fin = new Date(instant(i.date, Number(i.fin)));
  const z = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lienGoogle = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent("Coco Nail's : " + i.soin)}&dates=${z(debut)}/${z(fin)}&location=${encodeURIComponent(adr)}`;
  const html = gabarit("Votre rendez-vous est confirmé", [
    para(`Bonjour ${esc(i.nom)},`),
    para("Coralie confirme votre rendez-vous. À très bientôt !"),
    tableau([...lignesRdv(i), ["Adresse", esc(adr) + (c.lien_google_maps ? `<br><a href="${esc(c.lien_google_maps)}" style="color:${BORDEAUX};font-weight:400">Voir sur Google Maps</a>` : "")], ["Paiement", "Sur place"]]),
    `<p style="margin:18px 0">${bouton(lienGoogle, "Ajouter à mon agenda Google")}</p>`,
    para(`<span style="color:#7a5a60;font-size:13px">Sur iPhone ou Outlook, ouvrez la pièce jointe « rendez-vous-coco-nails.ics ».</span>`),
    para(`En cas d'empêchement, merci de prévenir au moins <strong>48 heures à l'avance</strong> (passé ce délai, la prestation reste due), en répondant à cet e-mail${c.telephone ? " ou directement&nbsp;:" : "."}`),
    blocContact(c),
  ].join(""));
  const texte = `Bonjour ${i.nom},

Coralie confirme votre rendez-vous. À très bientôt !

Soin : ${i.soin}${i.options ? "\nOptions : " + i.options : ""}
Quand : ${quand(i)}
Adresse : ${adr}
Paiement : sur place

En cas d'empêchement, merci de prévenir au moins 48 heures à l'avance en répondant à cet e-mail. Passé ce délai, la prestation reste due.${texteContact(c)}
Coco Nail's`;
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Coco Nail's//Rendez-vous//FR", "METHOD:PUBLISH", "BEGIN:VEVENT",
    `UID:${i.id || z(debut)}@coconails`, `DTSTAMP:${z(new Date())}`, `DTSTART:${z(debut)}`, `DTEND:${z(fin)}`,
    `SUMMARY:Coco Nail's : ${i.soin.replace(/[,;\\]/g, " ")}`, `LOCATION:${adr.replace(/[,;\\]/g, (x) => "\\" + x)}`,
    `URL:${origine}`, "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
  return { sujet, html, texte, ics };
}

// 4. Pour la cliente : créneau refusé.
export function refusCliente(i, origine) {
  const sujet = "Votre demande de rendez-vous chez Coco Nail's";
  const html = gabarit("Créneau indisponible", [
    para(`Bonjour ${esc(i.nom)},`),
    para(`Coralie n'est malheureusement pas disponible le ${esc(quand(i))}. Le créneau a été libéré : vous pouvez en choisir un autre en quelques clics.`),
    `<p style="margin:18px 0">${bouton(origine + "/#reserver", "Choisir un autre créneau")}</p>`,
    para("Merci de votre compréhension, et à bientôt !"),
  ].join(""));
  const texte = `Bonjour ${i.nom},

Coralie n'est malheureusement pas disponible le ${quand(i)}. Le créneau a été libéré : vous pouvez en choisir un autre sur ${origine}/#reserver

Merci de votre compréhension, et à bientôt !
Coco Nail's`;
  return { sujet, html, texte };
}

// Page affichée à Coralie quand elle touche un bouton.
export function page(titre, corps, statut = 200) {
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(titre)} — Coco Nail's</title>
<link rel="icon" type="image/png" href="/images/favicon.png">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:${ROSE};color:${ENCRE};font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;padding:24px}
main{max-width:460px;width:100%;box-sizing:border-box;background:#fff;border-radius:20px;padding:28px 24px;text-align:center}
img{width:80px;height:80px;border-radius:50%}h1{font-family:Georgia,serif;font-style:italic;color:${BORDEAUX};font-size:1.9rem;margin:.4em 0}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;text-align:left;margin:18px 0}dt{color:#7a5a60}dd{margin:0;font-weight:600}
button,.lien{display:block;width:100%;box-sizing:border-box;border:0;cursor:pointer;font:inherit;font-weight:700;font-size:1.05rem;padding:16px;border-radius:999px;color:#fff;background:${BORDEAUX};text-decoration:none;margin-top:10px}
a{color:${BORDEAUX}}.lien{color:#fff}.vert{background:#2f6b3a}.gris{background:#8a7a7d}p{line-height:1.5}</style></head>
<body><main><img src="/images/logo-coco-nails.webp" alt=""><h1>${esc(titre)}</h1>${corps}</main></body></html>`;
  return new Response(html, { status: statut, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}
export function resume(i) {
  return `<dl><dt>Cliente</dt><dd>${esc(i.nom)}</dd><dt>Soin</dt><dd>${esc(i.soin)}${i.options ? " + " + esc(i.options) : ""}</dd><dt>Quand</dt><dd>${esc(quand(i))}</dd><dt>Téléphone</dt><dd><a href="tel:${esc(String(i.telephone).replace(/[^\d+]/g, ""))}">${esc(i.telephone)}</a></dd></dl>`;
}

// 5. Pour la cliente : sa facture (PDF joint).
export function factureCliente(f, lien) {
  const prenom = String((f.cliente && f.cliente.nom) || "").trim();
  const montant = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(Number(f.montant) || 0);
  const sujet = `Votre facture Coco Nail's n° ${f.numero}`;
  const p = f.prestation || {};
  const html = gabarit("Votre facture", [
    para(`Bonjour ${esc(prenom)},`),
    para("Merci pour votre visite chez Coco Nail's ! Vous trouverez votre facture en pièce jointe."),
    tableau([
      ["Facture", esc(f.numero)],
      ["Prestation", esc([p.soin, p.options].filter(Boolean).join(" + "))],
      ["Date", p.date ? esc(jourLong(p.date)) : ""],
      ["Montant", esc(montant) + " (payé)"],
    ]),
    `<p style="margin:18px 0">${bouton(lien, "Voir ma facture")}</p>`,
    para("À très bientôt !<br>Coralie"),
  ].join(""));
  const texte = `Bonjour ${prenom},

Merci pour votre visite chez Coco Nail's ! Vous trouverez votre facture n° ${f.numero} en pièce jointe (${montant}, payé).
Vous pouvez aussi la consulter ici : ${lien}

À très bientôt !
Coralie — Coco Nail's`;
  return { sujet, html, texte };
}

// 6. Pour Coralie : rappel de déclaration URSSAF.
// periodes : [{libelle, total, echeance, aValider}] ; relance : true si la date limite approche.
export function rappelUrssaf(periodes, origine, relance = false) {
  const eur = (n) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(Number(n) || 0);
  const date = (d) => new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(d + "T00:00:00Z"));
  const p0 = periodes[0];
  const sujet = relance
    ? `Rappel : déclaration URSSAF de ${p0.libelle} avant le ${date(p0.echeance)}`
    : `Déclaration URSSAF de ${p0.libelle} : ${eur(p0.total)} à déclarer`;
  const html = gabarit(relance ? "N'oubliez pas l'URSSAF" : "C'est le moment de déclarer", [
    para("Bonjour Coralie,"),
    para(relance ? "Petit rappel : cette déclaration n'est pas encore marquée comme faite dans votre compta." : "Votre déclaration de chiffre d'affaires à l'URSSAF est à faire :"),
    tableau(periodes.flatMap((p) => [
      ["Période", `<span style="text-transform:capitalize">${esc(p.libelle)}</span>`],
      ["À déclarer", `<span style="font-size:20px">${esc(eur(p.total))}</span>`],
      ["Avant le", esc(date(p.echeance))],
      ["À valider", p.aValider ? `<span style="color:#b3261e">${p.aValider} rendez-vous pas encore validé${p.aValider > 1 ? "s" : ""}</span>` : ""],
    ])),
    periodes.some((p) => p.aValider) ? para("Validez d'abord ces rendez-vous dans votre compta : le montant à déclarer se mettra à jour.") : "",
    `<p style="margin:18px 0">${bouton(origine + "/compta/#urssaf", "Ouvrir ma compta")}</p>`,
    para(`<span style="color:#7a5a60;font-size:13px">Une fois la déclaration faite sur le site de l'URSSAF, touchez « C'est déclaré » dans votre compta pour arrêter les rappels.</span>`),
  ].join(""));
  const texte = `Bonjour Coralie,

${relance ? "Petit rappel : cette déclaration n'est pas encore marquée comme faite." : "Votre déclaration de chiffre d'affaires à l'URSSAF est à faire :"}
${periodes.map((p) => `- ${p.libelle} : ${eur(p.total)} à déclarer avant le ${date(p.echeance)}${p.aValider ? ` (${p.aValider} rendez-vous à valider d'abord)` : ""}`).join("\n")}

Ouvrir ma compta : ${origine}/compta/#urssaf`;
  return { sujet, html, texte };
}

// 7. Pour la cliente : rappel la veille du rendez-vous (message de service).
export function rappelVeilleMail(i, c, lienDesinscription) {
  const adr = adresseComplete(c);
  const sujet = `Rappel : votre rendez-vous demain à ${heure(Number(i.debut))} chez Coco Nail's`;
  const html = gabarit("À demain !", [
    para(`Bonjour ${esc(i.nom)},`),
    para("Petit rappel de votre rendez-vous chez Coco Nail's :"),
    tableau([...lignesRdv(i), ["Adresse", esc(adr) + (c.lien_google_maps ? `<br><a href="${esc(c.lien_google_maps)}" style="color:${BORDEAUX};font-weight:400">Voir sur Google Maps</a>` : "")]]),
    para(`Un empêchement ? Merci de prévenir Coralie le plus tôt possible${c.telephone ? "&nbsp;:" : ", en répondant à cet e-mail."}`),
    blocContact(c),
    lienDesinscription ? para(`<span style="color:#7a5a60;font-size:12px">Vous ne souhaitez plus recevoir de rappels ? <a href="${esc(lienDesinscription)}" style="color:#7a5a60">Gérer mes messages</a></span>`) : "",
  ].join(""));
  const texte = `Bonjour ${i.nom},

Petit rappel de votre rendez-vous chez Coco Nail's :
Soin : ${i.soin}${i.options ? "\nOptions : " + i.options : ""}
Quand : ${quand(i)}
Adresse : ${adr}

Un empêchement ? Merci de prévenir Coralie le plus tôt possible.${texteContact(c)}
Coco Nail's${lienDesinscription ? "\n\nNe plus recevoir de rappels : " + lienDesinscription : ""}`;
  return { sujet, html, texte };
}

// 8. Pour la cliente : « votre prochain soin approche » (uniquement si elle l'a accepté).
export function prochainSoinMail({ nom, soin, relance }, origine, lienDesinscription) {
  const prenom = String(nom || "").trim().split(/\s+/)[0];
  const sujet = relance ? "Coco Nail's : on garde une place pour vous ?" : "Coco Nail's : c'est bientôt le moment de reprendre rendez-vous";
  const html = gabarit(relance ? "Envie de vous faire plaisir ?" : "C'est bientôt le moment !", [
    para(`Bonjour ${esc(prenom)},`),
    para(relance
      ? "Cela fait un moment que nous ne nous sommes pas vues ! Coralie serait ravie de s'occuper à nouveau de vos ongles."
      : `Votre dernier soin (${esc(soin)}) date déjà de quelques semaines : c'est le bon moment pour réserver le prochain et garder de jolis ongles.`),
    `<p style="margin:18px 0">${bouton(origine + "/rdv", "Réserver mon créneau")}</p>`,
    para("À très bientôt,<br>Coralie"),
    para(`<span style="color:#7a5a60;font-size:12px">Vous recevez ce message car vous avez accepté d'être prévenue de votre prochain soin. <a href="${esc(lienDesinscription)}" style="color:#7a5a60">Ne plus recevoir ces messages</a></span>`),
  ].join(""));
  const texte = `Bonjour ${prenom},

${relance ? "Cela fait un moment que nous ne nous sommes pas vues ! Coralie serait ravie de s'occuper à nouveau de vos ongles." : `Votre dernier soin (${soin}) date déjà de quelques semaines : c'est le bon moment pour réserver le prochain.`}
Réservez en 1 minute : ${origine}/rdv

À très bientôt,
Coralie — Coco Nail's

Ne plus recevoir ces messages : ${lienDesinscription}`;
  return { sujet, html, texte };
}
