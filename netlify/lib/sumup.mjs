// Lecture des paiements par carte SumUp de Coralie (lecture seule).
// Variables Netlify :
//   SUMUP_API_KEY        clé créée dans le compte SumUp (Paramètres > Clés API) — secrète
//   SUMUP_MERCHANT_CODE  facultatif : code marchand (sinon retrouvé automatiquement)
import { decalageParis, instant } from "./agenda.mjs";

const HOTE = "https://api.sumup.com";
export const TAUX_SUMUP = 0.0175; // commission sans abonnement, pour estimer quand SumUp n'a pas encore versé
export const sumupConfigure = () => Boolean(process.env.SUMUP_API_KEY);

async function appel(chemin) {
  const rep = await fetch(HOTE + chemin, { headers: { Authorization: `Bearer ${process.env.SUMUP_API_KEY}`, Accept: "application/json" } });
  if (rep.status === 401 || rep.status === 403) throw Object.assign(new Error("La clé SumUp est refusée : vérifiez-la dans Netlify."), { publique: true });
  if (!rep.ok) throw new Error(`SumUp : erreur ${rep.status}`);
  return rep.json();
}

let code = null;
export async function codeMarchand() {
  if (process.env.SUMUP_MERCHANT_CODE) return process.env.SUMUP_MERCHANT_CODE;
  if (code) return code;
  const r = await appel("/v0.1/memberships?kind=merchant");
  const m = (r.items || []).find((x) => x.resource && /merchant/i.test(x.resource.type || "")) || (r.items || [])[0];
  if (!m) throw new Error("SumUp : aucun compte marchand trouvé avec cette clé");
  code = m.resource_id || (m.resource && m.resource.id);
  return code;
}

// Date et heure de Paris d'un horodatage SumUp.
function enParis(iso) {
  const ms = Date.parse(iso);
  const local = new Date(ms + decalageParis(ms) * 60000).toISOString();
  return { date: local.slice(0, 10), heure: local.slice(11, 16) };
}

// Paiements par carte réussis entre deux dates de Paris (incluses).
export async function paiements(du, au) {
  const mc = encodeURIComponent(await codeMarchand());
  const base = `/v2.1/merchants/${mc}/transactions/history`;
  let q = new URLSearchParams({ oldest_time: new Date(instant(du, 0)).toISOString(), newest_time: new Date(instant(au, 24 * 60)).toISOString(), limit: "100", order: "ascending" }).toString();
  const tous = [];
  for (let page = 0; page < 30 && q; page++) {
    const r = await appel(`${base}?${q}`);
    tous.push(...(r.items || []));
    const suivant = (r.links || []).find((l) => l.rel === "next");
    q = suivant && suivant.href ? suivant.href.replace(/^\?/, "") : "";
  }
  return tous
    .filter((t) => (t.type || "PAYMENT") === "PAYMENT" && ["SUCCESSFUL", "REFUNDED"].includes(t.status))
    .map((t) => ({ code: t.transaction_code || t.id, montant: Number(t.amount) || 0, rembourse: Number(t.refunded_amount) || 0,
      statut: t.status, carte: t.card_type || "", ...enParis(t.timestamp) }));
}

// Commissions réellement retenues par SumUp, par code de transaction (d'après les versements).
export async function commissions(du, au) {
  const mc = encodeURIComponent(await codeMarchand());
  const r = await appel(`/v1.0/merchants/${mc}/payouts?${new URLSearchParams({ start_date: du, end_date: au, format: "json", limit: "9999" })}`);
  const frais = new Map();
  for (const v of Array.isArray(r) ? r : r.items || []) {
    if (v.type === "PAYOUT" && v.transaction_code) frais.set(v.transaction_code, (frais.get(v.transaction_code) || 0) + (Number(v.fee) || 0));
  }
  return frais;
}
