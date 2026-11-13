// Page compta de Coralie (coconails72.com/compta) : tout passe par ici, protégé par mot de passe.
// GET  /api/compta                      état complet (rendez-vous à valider, factures, périodes URSSAF…)
// POST /api/compta {action, …}          connexion, deconnexion, ajouter, modifier, valider, annuler, retablir,
//                                       envoyer (facture par e-mail), whatsapp (note l'envoi), declarer, reglage
import { configuree, json, contenu, creerRendezVous, modifierRendezVous, lireRendezVous, occupe, nouvelId, envoyerMail, instant, enMinutes } from "../lib/agenda.mjs";
import * as C from "../lib/compta.mjs";
import { pdfFacture } from "../lib/facture.mjs";
import { factureCliente } from "../lib/messages.mjs";

const COOKIE = "coco_compta";
const DUREE_SESSION_JOURS = 90;
const MOYENS_DEFAUT = ["Carte bancaire", "Espèces", "Chèque", "Virement"];
const EMAIL = /^[^\s@,;:<>"'()\[\]\\]+@[^\s@,;:<>"'()\[\]\\]+\.[^\s@,;:<>"'()\[\]\\]+$/;
const t = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const arrondi = (n) => Math.round(n * 100) / 100;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function lireCookie(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.get("cookie") || "");
  return m ? m[1] : "";
}
function avecCookie(rep, valeur, maxAge) {
  rep.headers.append("Set-Cookie", `${COOKIE}=${valeur}; Path=/api/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`);
  return rep;
}

// Charge le tableau et les contenus du site (carte des soins, moyens de paiement, infos légales).
async function charger(origine, synchro) {
  const [soins, paiement, legal, coordonnees] = await Promise.all(["soins", "paiement", "legal", "coordonnees"].map((n) => contenu(origine, n)));
  const d = await C.lireTout();
  const alertes = [];
  if (synchro && configuree()) {
    try { await C.synchroniser(d, soins); } catch (e) {
      console.error(e);
      alertes.push("L'agenda n'a pas pu être lu : les derniers rendez-vous confirmés sur le site apparaîtront un peu plus tard.");
    }
  }
  return { d, soins, paiement, legal, coordonnees, alertes, origine };
}

function moyens(ctx) {
  const m = ((ctx.paiement && ctx.paiement.moyens) || []).map((x) => x && x.moyen).filter(Boolean);
  return m.length ? m : MOYENS_DEFAUT;
}

// Ce que voit la page.
function vue(ctx) {
  const { d, soins, legal, coordonnees, origine } = ctx;
  const alertes = [...ctx.alertes];
  if (!legal.siret && !legal.siren) alertes.push("Ajoutez votre SIRET dans Pages CMS > Informations légales : il est obligatoire sur les factures.");
  else if (!legal.siret) alertes.push("Le SIRET n'est pas encore rempli (Pages CMS > Informations légales) : en attendant, les factures affichent le SIREN.");
  if (!coordonnees.adresse) alertes.push("Ajoutez votre adresse dans Pages CMS > Horaires et coordonnées : elle doit figurer sur les factures.");

  const sans = ({ _rang, ...x }) => ({ ...x, montant: x.montant === "" || x.montant == null ? "" : Number(x.montant) });
  const clientes = new Map();
  for (const l of [...d.lignes].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const k = l.cliente.trim().toLowerCase();
    if (!k) continue;
    const c = clientes.get(k) || { nom: l.cliente.trim(), telephone: "", email: "", adresse: "", visites: 0 };
    for (const champ of ["telephone", "email", "adresse"]) if (l[champ]) c[champ] = l[champ];
    if (l.etat === C.ETATS.validee) c.visites++;
    clientes.set(k, c);
  }
  return {
    aujourdhui: C.aujourdhui(),
    lignes: d.lignes.map(sans),
    factures: d.factures.map((f) => {
      let c = {}; try { c = JSON.parse(f.contenu); } catch {}
      return { numero: f.numero, date: f.date, ligne: f.ligne, cliente: f.cliente, montant: Number(f.montant) || 0, paiement: f.paiement, envois: f.envois,
        email: (c.cliente && c.cliente.email) || "", telephone: (c.cliente && c.cliente.telephone) || "", prestation: c.prestation || {}, paye_le: c.paye_le || "",
        lien: C.lienFacture(origine, f.numero) };
    }),
    periodes: C.resumePeriodes(d),
    reglages: d.reglages,
    soins: { soins: (soins.soins || []).map(({ nom, categorie, prix, duree, options_possibles }) => ({ nom, categorie, prix, duree, options_possibles })),
      options: (soins.options || []).map(({ nom, prix, duree }) => ({ nom, prix, duree })) },
    moyens: moyens(ctx),
    clientes: [...clientes.values()],
    agenda: configuree(),
    alertes,
  };
}

// Champs communs à « ajouter » et « modifier ».
function lireSaisie(x, soins) {
  const cliente = t(x.cliente, 80);
  if (cliente.length < 2) throw new C.Refus("Indiquez le nom de la cliente.");
  const telephone = t(x.telephone, 30), email = t(x.email, 120);
  if (email && !EMAIL.test(email)) throw new C.Refus("L'adresse e-mail n'est pas valide.");
  const date = t(x.date, 10);
  if (!C.dateValide(date)) throw new C.Refus("La date n'est pas valide.");
  const heure = t(x.heure, 5);
  if (heure && !/^([01]\d|2[0-3]):[0-5]\d$/.test(heure)) throw new C.Refus("L'heure n'est pas valide.");
  const soin = t(x.soin, 80);
  if (!soin) throw new C.Refus("Choisissez le soin.");
  const options = (Array.isArray(x.options) ? x.options : []).map((o) => t(o, 60)).filter(Boolean).slice(0, 8);
  const tarif = C.tarifDe(soins, soin, options);
  const brut = x.montant === "" || x.montant == null ? tarif.montant : Number(String(x.montant).replace(",", "."));
  if (!(brut >= 0 && brut < 10000)) throw new C.Refus("Le montant n'est pas valide.");
  return { saisie: { cliente, telephone, email, adresse: t(x.adresse, 160), date, heure, soin, options: options.join(", "), tarif: tarif.texte, montant: arrondi(brut), note: t(x.note, 300) }, duree: tarif.duree };
}

function trouver(d, id) {
  const l = d.lignes.find((x) => x.id === id);
  if (!l) throw new C.Refus("Cette ligne est introuvable. Rechargez la page.", 404);
  return l;
}
const exigerAttente = (l) => { if (l.etat !== C.ETATS.attente) throw new C.Refus(`Cette ligne est déjà ${l.etat.toLowerCase()}.`, 409); };

const ACTIONS = {
  async ajouter(ctx, x) {
    const origine = C.ORIGINES.includes(x.origine) && x.origine !== "Site" ? x.origine : "Téléphone";
    const { saisie, duree } = lireSaisie(x, ctx.soins);
    const l = { id: C.nouvelIdLigne(), etat: C.ETATS.attente, origine, ...saisie, paiement: "", paye_le: "", facture: "", rdv: "" };
    // Bloquer aussi le créneau dans l'agenda (et donc sur le site), si demandé.
    if (x.agenda && saisie.heure && saisie.date >= C.aujourdhui() && configuree()) {
      const debut = enMinutes(saisie.heure), fin = debut + duree;
      if (!x.forcer) {
        const pris = await occupe(new Date(instant(saisie.date, debut)).toISOString(), new Date(instant(saisie.date, fin)).toISOString());
        if (pris.length) throw Object.assign(new C.Refus("Ce créneau est déjà occupé dans votre agenda.", 409), { code: "occupe" });
      }
      const id = nouvelId();
      await creerRendezVous({
        id, date: saisie.date, debut, fin, couleur: "10",
        titre: `${saisie.cliente}, ${saisie.soin}${saisie.options ? " + " + saisie.options : ""}`,
        description: [`Rendez-vous pris par ${origine === "Message" ? "message" : "téléphone"}, ajouté depuis la compta.`,
          saisie.telephone ? `Téléphone : ${saisie.telephone}` : "", saisie.email ? `E-mail : ${saisie.email}` : "", saisie.note ? `Note : ${saisie.note}` : ""].filter(Boolean).join("\n"),
        infos: { id, nom: saisie.cliente, telephone: saisie.telephone, email: saisie.email, soin: saisie.soin, options: saisie.options,
          prix: saisie.tarif.slice(0, 500), date: saisie.date, debut: String(debut), fin: String(fin), origine: "compta" },
      });
      l.rdv = id;
    }
    await C.nouvellesLignes([l], ctx.d);
    return { ligne: l.id };
  },

  async modifier(ctx, x) {
    const l = trouver(ctx.d, x.id);
    exigerAttente(l);
    const { saisie } = lireSaisie(x, ctx.soins);
    if (l.rdv && saisie.heure && (saisie.date !== l.date || saisie.heure !== l.heure) && configuree()) {
      const ev = await lireRendezVous(l.rdv).catch(() => null);
      if (ev && ev.start && ev.start.dateTime && ev.end && ev.end.dateTime) {
        const duree = (Date.parse(ev.end.dateTime) - Date.parse(ev.start.dateTime)) / 60000;
        const debut = enMinutes(saisie.heure);
        const z = (m) => new Date(instant(saisie.date, m)).toISOString();
        await modifierRendezVous(l.rdv, { start: { dateTime: z(debut), timeZone: "Europe/Paris" }, end: { dateTime: z(debut + duree), timeZone: "Europe/Paris" } });
      }
    }
    if (l.rdv && !saisie.heure) saisie.heure = l.heure;
    Object.assign(l, saisie);
    await C.majLigne(l);
    return {};
  },

  async annuler(ctx, x) {
    const l = trouver(ctx.d, x.id);
    exigerAttente(l);
    l.etat = C.ETATS.annulee;
    await C.majLigne(l);
    return {};
  },

  async retablir(ctx, x) {
    const l = trouver(ctx.d, x.id);
    if (l.etat !== C.ETATS.annulee) throw new C.Refus("Seule une ligne annulée peut être remise à valider.", 409);
    l.etat = C.ETATS.attente;
    await C.majLigne(l);
    return {};
  },

  async valider(ctx, x) {
    const { d, legal, coordonnees, origine } = ctx;
    const l = trouver(d, x.id);
    exigerAttente(l);
    const montant = arrondi(Number(String(x.montant == null ? "" : x.montant).replace(",", ".")));
    if (!(montant > 0 && montant < 10000)) throw new C.Refus("Indiquez le montant encaissé.");
    const paiement = t(x.paiement, 30);
    if (![...moyens(ctx), ...MOYENS_DEFAUT].includes(paiement)) throw new C.Refus("Choisissez le moyen de paiement.");
    const auj = C.aujourdhui();
    const paye_le = t(x.paye_le, 10) || auj;
    if (!C.dateValide(paye_le)) throw new C.Refus("La date de paiement n'est pas valide.");
    if (paye_le > auj) throw new C.Refus("La date de paiement ne peut pas être dans le futur.");
    if (C.periodeDeclaree(paye_le, d)) throw new C.Refus("Cette date tombe dans une période déjà déclarée à l'URSSAF : mettez la date d'aujourd'hui.", 409);
    const cliente = t(x.cliente, 80) || l.cliente;
    if (cliente.length < 2) throw new C.Refus("Indiquez le nom de la cliente.");
    // Un champ non envoyé garde sa valeur ; un champ envoyé vide est effacé.
    const garder = (champ, max) => (x[champ] === undefined ? l[champ] : t(x[champ], max));
    const email = garder("email", 120), telephone = garder("telephone", 30), adresse = garder("adresse", 160);
    if (email && !EMAIL.test(email)) throw new C.Refus("L'adresse e-mail n'est pas valide.");
    if (!legal.nom_entreprise || (!legal.siret && !legal.siren)) throw new C.Refus("Il manque le nom de l'entreprise ou le SIRET (Pages CMS > Informations légales) pour faire une facture.", 409);

    const numero = C.prochainNumero(d, auj.slice(0, 4));
    const contenuFacture = {
      numero, date: auj, paye_le, paiement, montant,
      emetteur: { nom: legal.nom_entreprise, adresse: coordonnees.adresse || "", code_postal: coordonnees.code_postal || "", ville: coordonnees.ville || "",
        siret: legal.siret || "", siren: legal.siren || "", rne: legal.rne || "", email: coordonnees.email || "", telephone: coordonnees.telephone || "",
        site: new URL(origine).host.replace(/^www\./, "") },
      cliente: { nom: cliente, adresse, email, telephone },
      prestation: { date: l.date, soin: l.soin, options: l.options },
      mention_tva: "TVA non applicable, article 293 B du CGI",
    };
    // La facture d'abord (elle fait foi), puis la ligne.
    await C.enregistrerFacture({ numero, date: auj, ligne: l.id, cliente, montant, paiement, envois: "", contenu: JSON.stringify(contenuFacture) }, d);
    Object.assign(l, { etat: C.ETATS.validee, montant, paiement, paye_le, facture: numero, cliente, email, telephone, adresse });
    await C.majLigne(l);
    return { facture: numero };
  },

  async envoyer(ctx, x) {
    const f = ctx.d.factures.find((y) => y.numero === x.numero);
    if (!f) throw new C.Refus("Facture introuvable.", 404);
    const c = JSON.parse(f.contenu);
    const email = t(x.email, 120) || (c.cliente && c.cliente.email);
    if (!email || !EMAIL.test(email)) throw new C.Refus("Indiquez une adresse e-mail valide pour la cliente.");
    const pdf = await pdfFacture(c);
    await envoyerMail({ a: email, ...factureCliente(c, C.lienFacture(ctx.origine, f.numero)),
      pieces: [{ nom: `facture-${f.numero}.pdf`, type: "application/pdf", donnees: pdf }] });
    f.envois = [f.envois, `E-mail à ${email} le ${C.horodatage()}`].filter(Boolean).join(" · ");
    await C.majFacture(f);
    return { envoye: email };
  },

  async whatsapp(ctx, x) {
    const f = ctx.d.factures.find((y) => y.numero === x.numero);
    if (!f) throw new C.Refus("Facture introuvable.", 404);
    f.envois = [f.envois, `WhatsApp le ${C.horodatage()}`].filter(Boolean).join(" · ");
    await C.majFacture(f);
    return {};
  },

  async declarer(ctx, x) {
    const p = C.resumePeriodes(ctx.d).find((y) => y.periode === x.periode);
    if (!p) throw new C.Refus("Période introuvable.", 404);
    if (!p.terminee) throw new C.Refus("Cette période n'est pas encore terminée : la déclaration se fait après.", 409);
    if (p.declaration) throw new C.Refus("Cette période est déjà marquée comme déclarée.", 409);
    await C.enregistrerDeclaration({ periode: p.periode, montant: p.total, declare_le: C.horodatage(), nb: String(p.nb) }, ctx.d);
    return {};
  },

  async reglage(ctx, x) {
    if (!["mensuelle", "trimestrielle"].includes(x.periodicite)) throw new C.Refus("Réglage inconnu.");
    await C.majReglage("periodicite", x.periodicite, ctx.d);
    return {};
  },
};

export default async (req) => {
  if (!C.comptaConfiguree()) return json({ erreur: "La compta n'est pas encore reliée au tableau Google (réglages Netlify à faire).", configuration: true }, 503);
  const origine = new URL(req.url).origin;
  let x = {};
  if (req.method === "POST") {
    if (!(req.headers.get("content-type") || "").includes("application/json")) return json({ erreur: "Demande illisible." }, 415);
    try { x = await req.json(); } catch { return json({ erreur: "Demande illisible." }, 400); }
    if (!x || typeof x !== "object") return json({ erreur: "Demande illisible." }, 400);
  } else if (req.method !== "GET") return json({ erreur: "Méthode non autorisée." }, 405);

  if (x.action === "deconnexion") return avecCookie(json({ ok: true }), "", 0);
  let session = null;
  if (x.action === "connexion") {
    if (!C.motDePasseOk(t(x.motdepasse, 200))) { await pause(1500); return json({ erreur: "Mot de passe incorrect." }, 401); }
    session = C.creerSession(DUREE_SESSION_JOURS);
  } else if (!C.sessionValide(lireCookie(req))) {
    return json({ erreur: "Veuillez vous connecter.", connexion: true }, 401);
  }

  try {
    const action = req.method === "GET" || x.action === "connexion" ? null : ACTIONS[x.action];
    if (req.method === "POST" && x.action !== "connexion" && !action) return json({ erreur: "Action inconnue." }, 400);
    const ctx = await charger(origine, !action);
    const resultat = action ? await action(ctx, x) : {};
    const rep = json({ ok: true, ...resultat, vue: vue(ctx) });
    return session ? avecCookie(rep, session, DUREE_SESSION_JOURS * 86400) : rep;
  } catch (e) {
    if (!e.publique) console.error(e);
    const rep = json({ erreur: e.publique ? e.message : "Le tableau de compta ne répond pas pour le moment. Réessayez dans un instant.", code: e.code }, e.statut || 503);
    return session ? avecCookie(rep, session, DUREE_SESSION_JOURS * 86400) : rep;
  }
};

export const config = { path: "/api/compta" };
