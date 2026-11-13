import { generateKeyPairSync, createVerify } from "node:crypto";
import { readFileSync } from "node:fs";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.GOOGLE_CLIENT_EMAIL = "site@test.iam.gserviceaccount.com";
process.env.GOOGLE_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).replace(/\n/g, "\\n");
process.env.GOOGLE_CALENDAR_ID = "coralie@gmail.com";
const contenus = Object.fromEntries(["soins","coordonnees","reservation"].map(n=>[n, JSON.parse(readFileSync(`repo/public/contenu/${n}.json`))]));
let agenda = [{ start: "2026-11-23T08:00:00Z", end: "2026-11-23T10:00:00Z" }]; // lundi 23 nov 9h-11h Paris
const crees = []; let jwtOk = false;
globalThis.fetch = async (url, opt = {}) => {
  url = String(url);
  if (url.includes("oauth2.googleapis.com/token")) {
    const a = new URLSearchParams(opt.body).get("assertion").split(".");
    const v = createVerify("RSA-SHA256"); v.update(a[0] + "." + a[1]); jwtOk = v.verify(publicKey, Buffer.from(a[2], "base64url"));
    return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
  }
  if (url.includes("/freeBusy")) {
    const b = JSON.parse(opt.body); const a = Date.parse(b.timeMin), z = Date.parse(b.timeMax);
    const busy = agenda.filter(x => Date.parse(x.start) < z && Date.parse(x.end) > a);
    return new Response(JSON.stringify({ calendars: { [b.items[0].id]: { busy } } }));
  }
  if (url.includes("/events")) { const ev = JSON.parse(opt.body); crees.push(ev); agenda.push({ start: ev.start.dateTime, end: ev.end.dateTime, local: true }); return new Response(JSON.stringify({ id: "e1" })); }
  const m = url.match(/\/contenu\/(\w+)\.json/); if (m) return new Response(JSON.stringify(contenus[m[1]]));
  throw new Error("URL inattendue " + url);
};
// Fige "aujourd'hui" au 16 novembre 2026 pour les délais
const vraiNow = Date.now; Date.now = () => Date.parse("2026-11-16T10:00:00+01:00");
const dispo = (await import("./repo/netlify/functions/disponibilites.mjs")).default;
const reserver = (await import("./repo/netlify/functions/reserver.mjs")).default;
const post = (b) => reserver(new Request("https://coconails.example/api/reserver", { method: "POST", body: JSON.stringify(b) }));
const base = { nom: "Julie Test", email: "julie@example.com", telephone: "06 12 34 56 78", soin: "Remplissage 4 semaines", options: ["Nail art"] };
const cas = [
  ["Disponibilités", await dispo(new Request("https://coconails.example/api/disponibilites?du=2026-11-17&au=2027-01-15"))],
  ["Créneau libre lundi 23 nov 14h (2h30)", await post({ ...base, date: "2026-11-23", debut: 14 * 60 })],
  ["Même créneau une 2e fois", await post({ ...base, date: "2026-11-23", debut: 14 * 60 })],
  ["Chevauche un RDV existant (lundi 10h)", await post({ ...base, date: "2026-11-23", debut: 10 * 60 })],
  ["Mercredi 10h, 2h30 dépasse midi", await post({ ...base, date: "2026-11-25", debut: 10 * 60 })],
  ["Dimanche", await post({ ...base, date: "2026-11-22", debut: 10 * 60 })],
  ["Jour férié 25 déc", await post({ ...base, date: "2026-12-25", debut: 10 * 60 })],
  ["Aujourd'hui (trop tôt)", await post({ ...base, date: "2026-11-16", debut: 15 * 60 })],
  ["Option sur dépose", await post({ ...base, soin: "Dépose", date: "2026-11-24", debut: 10 * 60 })],
  ["Soin inventé", await post({ ...base, soin: "Pose à 1 €", date: "2026-11-24", debut: 10 * 60 })],
  ["E-mail invalide", await post({ ...base, email: "x", date: "2026-11-24", debut: 10 * 60 })],
  ["Robot (piège rempli)", await post({ ...base, "bot-field": "spam", date: "2026-11-24", debut: 10 * 60 })],
];
for (const [n, r] of cas) console.log((n + " ").padEnd(42, "."), r.status, (await r.text()).slice(0, 110));
console.log("Signature JWT valide :", jwtOk, "| événements créés :", crees.length);
console.log(JSON.stringify(crees[0], null, 1));
delete process.env.GOOGLE_CALENDAR_ID;
const r = await dispo(new Request("https://x/api/disponibilites?du=2026-11-17&au=2026-11-20")); console.log("Sans configuration :", r.status, await r.text());
