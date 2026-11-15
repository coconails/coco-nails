// Services extérieurs SIMULÉS pour tester les fonctions de Coco Nail's dans PAGINITY (P1-7).
// Chargé dans l'exécuteur du site avec « node --import », uniquement par les tests (jamais en service réel).
//  - Google (jeton, Agenda, Gmail, Sheets), OVHcloud SMS (signature vérifiée), SumUp : réponses inventées.
//  - Adresses du site lui-même (*.localhost) : renvoyées vers le serveur des sites de PAGINITY en test.
//  - TOUTE autre adresse est refusée : aucun appel réel ne peut partir, même par erreur.
// L'état (rendez-vous, e-mails, SMS…) est relu et réécrit dans etat.json à chaque appel, pour que le test le lise.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

const DIR = process.env.PAGINITY_SIMULATION_DIR;
const SITES = process.env.PAGINITY_SIMULATION_SITES; // 127.0.0.1:port
const FICHIER = path.join(DIR, "etat.json");
const vide = () => ({ evs: {}, mails: [], feuilles: {}, sms: [], stop: [], sumup: [], versements: [], refuses: [] });
const lire = () => { try { return { ...vide(), ...JSON.parse(fs.readFileSync(FICHIER, "utf8")) }; } catch { return vide(); } };
const ecrireEtat = (G) => fs.writeFileSync(FICHIER, JSON.stringify(G));

// Heure figée (lundi 23 novembre 2026, 10 h à Paris) : les règles de réservation et de rappel ne dépendent pas du jour du test.
// L'heure avance ensuite normalement à partir de ce point.
if (process.env.PAGINITY_SIMULATION_MAINTENANT) {
  const depart = Date.parse(process.env.PAGINITY_SIMULATION_MAINTENANT), reel = Date.now(), vrai = Date.now.bind(Date);
  Date.now = () => depart + (vrai() - reel);
}

// Aucun appel réseau direct en dehors du site lui-même.
for (const mod of [http, https]) {
  const orig = mod.request;
  mod.request = function (...args) {
    const o = typeof args[0] === "string" || args[0] instanceof URL ? new URL(args[0]) : args[0] || {};
    const h = String(o.hostname || o.host || "");
    if (o.socketPath || h === "127.0.0.1" || h === "localhost") return orig.apply(this, args);
    throw new Error(`Simulation : appel réseau réel interdit (${h})`);
  };
  mod.get = function (...args) { const r = mod.request(...args); r.end(); return r; };
}
syncBuiltinESMExports(); // aussi pour « import { request } from "node:https" »

const R = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const versParis = (iso) => (/[+-]\d\d:\d\d$/.test(iso) ? iso : /Z$/.test(iso) ? new Date(Date.parse(iso) + 3600e3).toISOString().slice(0, 19) + "+01:00" : iso + "+01:00");
const col = (l) => l.split("").reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0);
function plage(r) {
  const m = /^'(.+)'!([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/.exec(decodeURIComponent(r));
  if (!m) throw new Error("plage illisible " + r);
  return { feuille: m[1], c1: col(m[2]) - 1, l1: Number(m[3] || 1) - 1, l2: m[5] ? Number(m[5]) - 1 : Infinity };
}
function lirePlage(G, r) {
  const p = plage(r), f = G.feuilles[p.feuille] || [];
  const v = f.slice(p.l1, p.l2 === Infinity ? undefined : p.l2 + 1).map((x) => (x || []).slice(p.c1));
  while (v.length && !(v.at(-1) || []).length) v.pop();
  return v;
}
function ecrire(G, r, valeurs) {
  const p = plage(r), f = G.feuilles[p.feuille];
  valeurs.forEach((ligne, i) => { const row = (f[p.l1 + i] = f[p.l1 + i] || []); ligne.forEach((v, j) => (row[p.c1 + j] = v)); });
}
const entete = (h, n) => { if (!h) return undefined; if (h instanceof Headers) return h.get(n) ?? undefined; const k = Object.keys(h).find((x) => x.toLowerCase() === n.toLowerCase()); return k ? h[k] : undefined; };

/** Vers le serveur des sites de PAGINITY (le site lit ses propres fichiers /contenu/*.json). */
function versSite(url, opt) {
  const [host, port] = SITES.split(":");
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port: Number(port), path: url.pathname + url.search, method: opt.method || "GET", headers: { host: url.host } }, (res) => {
      const morceaux = [];
      res.on("data", (d) => morceaux.push(d));
      res.on("end", () => resolve(new Response(res.statusCode === 304 ? null : Buffer.concat(morceaux), { status: res.statusCode, headers: { "content-type": String(res.headers["content-type"] || "") } })));
    });
    req.on("error", reject);
    req.end();
  });
}

globalThis.fetch = async (entree, opt = {}) => {
  const url = new URL(String(entree instanceof Request ? entree.url : entree));
  if (url.hostname.endsWith(".localhost") || url.hostname === "localhost") return versSite(url, opt);
  const G = lire();
  try {
    return reponse(G, url, opt);
  } finally {
    ecrireEtat(G);
  }
};

function reponse(G, url, opt) {
  const u = url.href;
  const corps = opt.body && typeof opt.body === "string" ? opt.body : null;
  const methode = opt.method || "GET";
  if (u.startsWith("https://oauth2.googleapis.com/token")) {
    const charge = JSON.parse(Buffer.from(new URLSearchParams(opt.body).get("assertion").split(".")[1], "base64url"));
    return R({ access_token: "tok-" + (charge.sub || "sa") + "-" + charge.scope.split("/").pop(), expires_in: 3600 });
  }
  if (url.hostname === "sheets.googleapis.com") {
    if (!String(entete(opt.headers, "Authorization")).includes("spreadsheets")) return R({}, 401);
    const chemin = decodeURIComponent(url.pathname).replace(/^\/v4\/spreadsheets\/[^/:]+/, "");
    if (chemin === "" && methode === "GET") return R({ sheets: Object.keys(G.feuilles).map((title) => ({ properties: { title } })) });
    if (chemin === ":batchUpdate") { for (const q of JSON.parse(corps).requests) G.feuilles[q.addSheet.properties.title] = []; return R({}); }
    if (chemin === "/values:batchGet") return R({ valueRanges: url.searchParams.getAll("ranges").map((r) => ({ range: r, values: lirePlage(G, r) })) });
    const m = /^\/values\/(.+?)(:append)?$/.exec(chemin);
    const r = url.pathname.split("/values/")[1].replace(/:append$/, "");
    if (m && m[2]) { const p = plage(r), f = G.feuilles[p.feuille]; let n = f.length; while (n > 0 && !(f[n - 1] || []).length) n--; ecrire(G, `'${p.feuille}'!A${n + 1}`, JSON.parse(corps).values); return R({}); }
    if (m && methode === "PUT") { ecrire(G, r, JSON.parse(corps).values); return R({}); }
    if (m) return R({ values: lirePlage(G, r) });
  }
  if (u.startsWith("https://www.googleapis.com/calendar/v3/freeBusy")) {
    const b = JSON.parse(corps); const a = Date.parse(b.timeMin), z = Date.parse(b.timeMax);
    const t0 = (x) => Date.parse(x.dateTime || x.date + "T00:00:00+01:00");
    const busy = Object.values(G.evs).filter((e) => e.transparency !== "transparent" && t0(e.start) < z && t0(e.end) > a).map((e) => ({ start: e.start.dateTime || e.start.date, end: e.end.dateTime || e.end.date }));
    return R({ calendars: { [b.items[0].id]: { busy } } });
  }
  if (url.hostname === "gmail.googleapis.com") {
    const raw = Buffer.from(JSON.parse(corps).raw, "base64url").toString();
    G.mails.push(raw);
    return R({ id: "m" + G.mails.length });
  }
  if (u.startsWith("https://eu.api.ovh.com/1.0")) {
    if (url.pathname === "/1.0/auth/time") return new Response(String(Math.floor(Date.now() / 1000)));
    const h = (n) => entete(opt.headers, n);
    const attendu = "$1$" + createHash("sha1").update(["secret-ovh", "conso-ovh", methode, u, corps || "", h("X-Ovh-Timestamp")].join("+")).digest("hex");
    if (h("X-Ovh-Application") !== "appli-ovh" || h("X-Ovh-Signature") !== attendu) return R({ message: "Invalid signature" }, 400);
    if (url.pathname === "/1.0/sms/sms-test-1/jobs" && methode === "POST") { const b = JSON.parse(corps); G.sms.push(b); return R({ ids: [1000 + G.sms.length], validReceivers: b.receivers, invalidReceivers: [], totalCreditsRemoved: 1 }); }
    if (url.pathname === "/1.0/sms/sms-test-1/blacklists") return R(G.stop);
    return R({ message: "inconnu" }, 404);
  }
  if (url.hostname === "api.sumup.com") {
    if (entete(opt.headers, "Authorization") !== "Bearer sup_sk_test") return R({ error_code: "NOT_AUTHORIZED" }, 401);
    const q = url.searchParams;
    if (url.pathname === "/v0.1/memberships") return R({ items: [{ id: "mem1", resource_id: "MTEST01", type: "merchant", resource: { id: "MTEST01", type: "merchant", name: "Coco Nail's" } }], total_count: 1 });
    if (url.pathname === "/v2.1/merchants/MTEST01/transactions/history") {
      const a = Date.parse(q.get("oldest_time") || 0), z = Date.parse(q.get("newest_time") || "2100-01-01");
      return R({ items: G.sumup.filter((t) => Date.parse(t.timestamp) >= a && Date.parse(t.timestamp) < z), links: [] });
    }
    if (url.pathname === "/v1.0/merchants/MTEST01/payouts") return R(G.versements.filter((v) => v.date >= q.get("start_date") && v.date <= q.get("end_date")));
    return R({}, 404);
  }
  const m = url.hostname === "www.googleapis.com" && u.match(/\/calendar\/v3\/calendars\/[^/]+\/events(?:\/([^?]+))?(\?.*)?$/);
  if (m) {
    const id = m[1] && decodeURIComponent(m[1]);
    if (!id && methode === "POST") { const ev = JSON.parse(corps); ev.start.dateTime = versParis(ev.start.dateTime); ev.end.dateTime = versParis(ev.end.dateTime); G.evs[ev.id] = ev; return R(ev); }
    if (!id) {
      const q = url.searchParams; const a = Date.parse(q.get("timeMin")), z = Date.parse(q.get("timeMax"));
      const t0 = (x) => Date.parse(x.dateTime || x.date + "T00:00:00+01:00");
      return R({ items: Object.values(G.evs).filter((e) => t0(e.start) < z && t0(e.end) > a) });
    }
    if (!G.evs[id]) return R({}, 404);
    if (methode === "PATCH") { const ch = JSON.parse(corps); if (ch.start) ch.start.dateTime = versParis(ch.start.dateTime); if (ch.end) ch.end.dateTime = versParis(ch.end.dateTime); Object.assign(G.evs[id], ch); return R(G.evs[id]); }
    if (methode === "DELETE") { delete G.evs[id]; return new Response(null, { status: 204 }); }
    return R(G.evs[id]);
  }
  // Adresse non simulée : refusée et notée (le test vérifie qu'il n'y en a aucune).
  G.refuses.push(u);
  throw new Error("Simulation : appel réseau réel interdit (" + url.hostname + ")");
}
