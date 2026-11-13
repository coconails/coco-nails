// Bloque un créneau : revérifie tout côté serveur, crée un rendez-vous « À confirmer » dans l'agenda de Coralie,
// puis envoie un e-mail à Coralie (boutons Confirmer / Refuser) et un accusé de réception à la cliente.
// POST /api/reserver  {soin, options[], date, debut, nom, email, telephone, message}
import { configuree, occupe, creerRendezVous, contenu, verifier, instant, hhmm, json, nouvelId, lienAction, envoyerMail, destinataireAlertes } from "../lib/agenda.mjs";
import { alerteCoralie, accuseCliente } from "../lib/messages.mjs";

const texte = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const EMAIL = /^[^\s@,;:<>"'()\[\]\\]+@[^\s@,;:<>"'()\[\]\\]+\.[^\s@,;:<>"'()\[\]\\]+$/;

export default async (req) => {
  if (req.method !== "POST") return json({ erreur: "Méthode non autorisée." }, 405);
  if (!configuree()) return json({ erreur: "Agenda non configuré." }, 503);
  let d;
  try { d = await req.json(); } catch { return json({ erreur: "Demande illisible." }, 400); }
  if (d["bot-field"]) return json({ ok: true }); // piège à robots : on ne crée rien

  const nom = texte(d.nom, 80), email = texte(d.email, 120), tel = texte(d.telephone, 30), message = texte(d.message, 600);
  if (nom.length < 2 || !EMAIL.test(email) || tel.replace(/\D/g, "").length < 9)
    return json({ erreur: "Merci de vérifier votre nom, votre e-mail et votre téléphone." }, 400);

  const origine = new URL(req.url).origin;
  let infos, liens, coordonnees;
  try {
    let soins, reservation;
    [soins, coordonnees, reservation] = await Promise.all(["soins", "coordonnees", "reservation"].map((n) => contenu(origine, n)));
    const v = verifier({ soins, coordonnees, reservation }, d);
    if (!v.ok) return json({ erreur: v.erreur }, 422);

    const debut = Number(d.debut), fin = debut + v.duree;
    const plages = await occupe(new Date(instant(d.date, debut)).toISOString(), new Date(instant(d.date, fin)).toISOString());
    if (plages.length) return json({ erreur: "Ce créneau vient d'être réservé. Choisissez-en un autre." }, 409);

    const id = nouvelId();
    const opts = v.options.map((o) => o.nom).join(", ");
    liens = { confirmer: lienAction(origine, id, "confirmer"), refuser: lienAction(origine, id, "refuser") };
    infos = { id, nom, email, telephone: tel, message, soin: v.soin.nom, prix: v.soin.prix || "", options: opts, date: d.date, debut: String(debut), fin: String(fin) };
    await creerRendezVous({
      id, date: d.date, debut, fin,
      titre: `À confirmer : ${nom}, ${v.soin.nom}${opts ? " + " + opts : ""}`,
      infos,
      description: [
        `Soin : ${v.soin.nom}${v.soin.prix ? " (" + v.soin.prix + ")" : ""}`,
        `Options : ${opts || "aucune"}`,
        `Horaire : ${hhmm(debut).replace(":", " h ")} à ${hhmm(fin).replace(":", " h ")}`,
        `Téléphone : ${tel}`,
        `E-mail : ${email}`,
        ...(message ? [`Message : ${message}`] : []),
        "",
        `✅ Confirmer (la cliente reçoit un e-mail) : ${liens.confirmer}`,
        "",
        `❌ Refuser (le créneau se libère) : ${liens.refuser}`,
      ].join("\n"),
    });
  } catch (e) {
    console.error(e);
    return json({ erreur: "Agenda momentanément indisponible." }, 503);
  }

  // Le rendez-vous est enregistré. Les e-mails sont un plus : s'ils échouent, le site passe par le formulaire Netlify.
  const [r1, r2] = await Promise.allSettled([
    envoyerMail({ a: destinataireAlertes(), repondreA: email, ...alerteCoralie(infos, liens) }),
    envoyerMail({ a: email, ...accuseCliente(infos, coordonnees) }),
  ]);
  for (const r of [r1, r2]) if (r.status === "rejected") console.error(r.reason);
  return json({ ok: true, mail: r1.status === "fulfilled" });
};

export const config = { path: "/api/reserver" };
