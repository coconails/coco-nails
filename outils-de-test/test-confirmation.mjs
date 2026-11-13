import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.GOOGLE_CLIENT_EMAIL = "site@test.iam.gserviceaccount.com";
process.env.GOOGLE_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).replace(/\n/g, "\\n");
process.env.GOOGLE_CALENDAR_ID = "contact@coconails72.com";
const contenus = Object.fromEntries(["soins","coordonnees","reservation"].map(n=>[n, JSON.parse(readFileSync(`repo/public/contenu/${n}.json`))]));
const evs = new Map(); const mails = []; let delegation = true; const subs = [];
const R = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
globalThis.fetch = async (url, opt = {}) => {
  url = String(url);
  if (url.includes("oauth2.googleapis.com/token")) {
    const charge = JSON.parse(Buffer.from(new URLSearchParams(opt.body).get("assertion").split(".")[1], "base64url"));
    subs.push(charge.sub || "-");
    if (charge.sub && !delegation) return R({ error: "unauthorized_client" }, 401);
    return R({ access_token: "tok-" + (charge.sub || "sa"), expires_in: 3600 });
  }
  if (url.includes("/freeBusy")) {
    const b = JSON.parse(opt.body); const a = Date.parse(b.timeMin), z = Date.parse(b.timeMax);
    const busy = [...evs.values()].filter(e => Date.parse(e.start.dateTime + "+01:00") < z && Date.parse(e.end.dateTime + "+01:00") > a).map(e => ({ start: e.start.dateTime, end: e.end.dateTime }));
    return R({ calendars: { [b.items[0].id]: { busy } } });
  }
  if (url.includes("gmail.googleapis.com")) {
    if (!opt.headers.Authorization.includes("tok-contact@")) return R({}, 403);
    const raw = Buffer.from(JSON.parse(opt.body).raw, "base64url").toString();
    mails.push(raw); return R({ id: "m" + mails.length });
  }
  const m = url.match(/\/events(?:\/([^?]+))?/);
  if (m) {
    const id = m[1] && decodeURIComponent(m[1]);
    if (!id && opt.method === "POST") { const ev = JSON.parse(opt.body); if (!/^[a-v0-9]{5,1024}$/.test(ev.id)) return R({ error: "bad id" }, 400); ev.start.dateTime += ""; evs.set(ev.id, ev); return R(ev); }
    if (!evs.has(id)) return R({}, 404);
    if (opt.method === "PATCH") { Object.assign(evs.get(id), JSON.parse(opt.body)); return R(evs.get(id)); }
    if (opt.method === "DELETE") { evs.delete(id); return new Response(null, { status: 204 }); }
    const e = evs.get(id); return R({ ...e, start: { dateTime: e.start.dateTime + "+01:00" }, end: { dateTime: e.end.dateTime + "+01:00" } });
  }
  const c = url.match(/\/contenu\/(\w+)\.json/); if (c) return R(contenus[c[1]]);
  throw new Error("URL inattendue " + url);
};
Date.now = () => Date.parse("2026-11-16T10:00:00+01:00");
const reserver = (await import("./repo/netlify/functions/reserver.mjs")).default;
const rdv = (await import("./repo/netlify/functions/rdv.mjs")).default;
const O = "https://coconails72.com";
const post = (b) => reserver(new Request(O + "/api/reserver", { method: "POST", body: JSON.stringify(b) }));
const base = { nom: "Julie Test", email: "julie@example.com", telephone: "06 12 34 56 78", soin: "Pose semi-permanent", options: ["Nail art"], message: "Rouge <b>bordeaux</b> svp" };
const ok = (c, t) => console.log((c ? "OK  " : "ÉCHEC ") + t);
const sujet = (raw) => { const s = raw.match(/^Subject: =\?UTF-8\?B\?(.+?)\?=/m)[1]; return Buffer.from(s, "base64").toString(); };
const to = (raw) => raw.match(/^To: (.*)$/m)[1];
const corpsHtml = (raw) => { const parts = raw.split(/Content-Type: text\/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n/)[1].split("\r\n--")[0]; return Buffer.from(parts.replace(/\r\n/g, ""), "base64").toString(); };
mkdirSync("out/mails", { recursive: true });

// 1. Réservation
let r = await post({ ...base, date: "2026-11-23", debut: 14 * 60 }); let j = await r.json();
ok(r.status === 200 && j.mail === true, `Réservation → ${r.status} ${JSON.stringify(j)}`);
const [id] = evs.keys(); const ev = evs.get(id);
ok(ev.summary.startsWith("À confirmer : Julie Test"), "Événement « À confirmer » créé : " + ev.summary);
ok(ev.description.includes("/api/rdv?id=" + id + "&a=confirmer&s="), "Liens dans la description de l'événement");
ok(mails.length === 2 && to(mails[0]) === "contact@coconails72.com" && to(mails[1]) === "julie@example.com", "2 e-mails : Coralie + cliente");
console.log("     Sujet Coralie :", sujet(mails[0])); console.log("     Sujet cliente :", sujet(mails[1]));
ok(!corpsHtml(mails[0]).includes("<b>bordeaux</b>") && corpsHtml(mails[0]).includes("&lt;b&gt;"), "Message de la cliente échappé (pas de HTML injecté)");
ok(/^Reply-To: julie@example.com/m.test(mails[0]), "Coralie peut répondre directement à la cliente");
writeFileSync("out/mails/1-coralie.html", corpsHtml(mails[0])); writeFileSync("out/mails/2-accuse-cliente.html", corpsHtml(mails[1]));
const lien = ev.description.match(/https:\S+a=confirmer\S+/)[0]; const lienRefus = ev.description.match(/https:\S+a=refuser\S+/)[0];

// 2. Liens
r = await rdv(new Request(lien.replace(/s=(\w)/, (m, c) => "s=" + (c === "A" ? "B" : "A")))); ok(r.status === 403, "Lien modifié refusé → " + r.status);
r = await rdv(new Request(lien.replace("a=confirmer", "a=refuser"))); ok(r.status === 403, "Signature de Confirmer réutilisée pour Refuser → " + r.status);
r = await rdv(new Request(lien)); let h = await r.text();
ok(r.status === 200 && h.includes("Confirmer ?") && h.includes('method="POST"') && evs.get(id).summary.startsWith("À confirmer"), "Ouvrir le lien ne change rien, affiche le bouton");
writeFileSync("out/mails/page-confirmer.html", h);
const form = (u) => { const q = new URL(u).searchParams; return new Request(O + "/api/rdv", { method: "POST", body: new URLSearchParams({ id: q.get("id"), a: q.get("a"), s: q.get("s") }) }); };
// Coralie a déplacé le rendez-vous à 15 h dans son agenda avant de confirmer
evs.get(id).start.dateTime = "2026-11-23T15:00:00"; evs.get(id).end.dateTime = "2026-11-23T16:45:00";
r = await rdv(form(lien)); h = await r.text();
ok(r.status === 200 && h.includes("Rendez-vous confirmé") && h.includes("a reçu l'e-mail"), "Confirmation → page OK");
ok(evs.get(id).summary === "Julie Test, Pose semi-permanent + Nail art" && evs.get(id).colorId === "10", "Agenda : « À confirmer » retiré, couleur verte");
ok(mails.length === 3 && to(mails[2]) === "julie@example.com", "E-mail de confirmation envoyé à la cliente : " + sujet(mails[2]));
ok(sujet(mails[2]).includes("15 h") && mails[2].includes("rendez-vous-coco-nails.ics"), "Confirmation à la nouvelle heure (15 h) + fichier agenda joint");
const ics = Buffer.from(mails[2].split('filename="rendez-vous-coco-nails.ics"\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1].split("\r\n--")[0].replace(/\r\n/g,""), "base64").toString();
ok(ics.includes("DTSTART:20261123T140000Z") && ics.includes("DTEND:20261123T154500Z"), "Fichier .ics à la bonne heure (UTC)");
writeFileSync("out/mails/3-confirmation-cliente.html", corpsHtml(mails[2]));
r = await rdv(form(lien)); h = await r.text(); ok(h.includes("Déjà confirmé") && mails.length === 3, "Double clic : « Déjà confirmé », aucun 2e e-mail");
r = await rdv(form(lienRefus)); h = await r.text(); ok(h.includes("Déjà confirmé") && evs.has(id), "Refuser après confirmation : rien supprimé");

// 3. Refus
r = await post({ ...base, nom: "Léa Refus", email: "lea@example.com", date: "2026-11-24", debut: 10 * 60, options: [] }); j = await r.json();
const id2 = [...evs.keys()][1]; const refus2 = evs.get(id2).description.match(/https:\S+a=refuser\S+/)[0];
r = await rdv(form(refus2)); h = await r.text();
ok(h.includes("Rendez-vous refusé") && !evs.has(id2), "Refus → événement supprimé, créneau libre");
ok(to(mails.at(-1)) === "lea@example.com" && corpsHtml(mails.at(-1)).includes("/#reserver"), "E-mail de refus avec lien pour rechoisir : " + sujet(mails.at(-1)));
writeFileSync("out/mails/4-refus-cliente.html", corpsHtml(mails.at(-1)));
r = await rdv(form(refus2)); h = await r.text(); ok(h.includes("introuvable"), "Refus en double : « introuvable », rien de plus");
r = await post({ ...base, nom: "Léa Refus", email: "lea@example.com", date: "2026-11-24", debut: 10 * 60, options: [] });
ok(r.status === 200, "Le créneau refusé est de nouveau réservable → " + r.status);

// 4. Délégation pas encore faite
delegation = false; const avant = mails.length;
r = await post({ ...base, nom: "Sans Gmail", date: "2026-11-26", debut: 14 * 60, options: [] }); j = await r.json();
ok(r.status === 200 && j.mail === false, "Sans délégation Gmail : RDV créé, mail:false (le site passe par le formulaire Netlify) → " + JSON.stringify(j));
const id4 = [...evs.keys()].at(-1);
r = await rdv(form(evs.get(id4).description.match(/https:\S+a=confirmer\S+/)[0])); h = await r.text();
ok(h.includes("n'a pas pu partir") && h.includes("tel:") && !evs.get(id4).summary.startsWith("À confirmer"), "Confirmation sans Gmail : agenda mis à jour, bouton Appeler la cliente");
ok(mails.length === avant, "Aucun e-mail envoyé sans délégation");

// 5. Sécurité diverses
r = await post({ ...base, email: "a,b@c.fr", date: "2026-11-27", debut: 9 * 60 }); ok(r.status === 400, "E-mail avec virgule refusé → " + r.status);
r = await rdv(new Request(O + "/api/rdv?id=x&a=supprimer&s=y")); ok(r.status === 403, "Action inconnue refusée → " + r.status);
