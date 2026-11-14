// Page « Gérer mes messages » (lien en bas des e-mails de rappel).
// GET  /api/desinscription?id=…&s=…   affiche les deux choix de la cliente
// POST /api/desinscription            enregistre ses nouveaux choix
import * as C from "../lib/compta.mjs";
import { page, esc } from "../lib/messages.mjs";

export default async (req) => {
  let p;
  if (req.method === "POST") {
    const f = await req.formData().catch(() => null);
    p = f ? { id: f.get("id"), s: f.get("s"), ok_veille: f.get("ok_veille") === "oui", ok_prochain: f.get("ok_prochain") === "oui", envoi: true } : {};
  } else {
    const u = new URL(req.url).searchParams;
    p = { id: u.get("id"), s: u.get("s") };
  }
  if (!p.id || !C.lienGestionValide(p.id, p.s)) return page("Lien non valide", "<p>Ce lien est incomplet ou n'a pas été créé par Coco Nail's.</p>", 403);
  if (!C.comptaConfiguree()) return page("Indisponible", "<p>Ce service n'est pas disponible pour le moment.</p>", 503);
  let d;
  try { d = await C.lireTout(); } catch (e) { console.error(e); return page("Indisponible", "<p>Réessayez dans quelques minutes.</p>", 503); }
  const c = d.clientes.find((x) => x.id === p.id);
  if (!c) return page("Introuvable", "<p>Nous ne retrouvons pas vos préférences. Contactez Coralie directement.</p>", 404);

  if (p.envoi) {
    Object.assign(c, { ok_veille: p.ok_veille ? "oui" : "non", ok_prochain: p.ok_prochain && !c.stop_le ? "oui" : "non",
      accord_par: "la cliente, via le lien « Gérer mes messages »", accord_le: C.horodatage() });
    try { await C.majCliente(c); } catch (e) { console.error(e); return page("Indisponible", "<p>Votre choix n'a pas pu être enregistré. Réessayez dans quelques minutes.</p>", 503); }
    return page("C'est noté", `<p>Merci ${esc(c.nom.split(" ")[0])}, vos préférences sont enregistrées :</p>
<p>${c.ok_veille === "oui" ? "✅" : "❌"} Rappel la veille de vos rendez-vous<br>${c.ok_prochain === "oui" ? "✅" : "❌"} Message quand votre prochain soin approche</p>`);
  }
  const coche = (v) => (v === "oui" ? "checked" : "");
  return page("Mes messages", `<p>Bonjour ${esc(c.nom.split(" ")[0])}, choisissez les messages que vous souhaitez recevoir de Coco Nail's :</p>
<form method="POST" action="/api/desinscription" style="text-align:left;margin-top:18px">
<input type="hidden" name="id" value="${esc(c.id)}"><input type="hidden" name="s" value="${esc(p.s)}">
<label style="display:flex;gap:10px;align-items:flex-start;margin:10px 0"><input type="checkbox" name="ok_veille" value="oui" ${coche(c.ok_veille)} style="width:22px;height:22px;accent-color:#5e0f1c"> Un rappel la veille de mes rendez-vous</label>
<label style="display:flex;gap:10px;align-items:flex-start;margin:10px 0"><input type="checkbox" name="ok_prochain" value="oui" ${coche(c.ok_prochain)} ${c.stop_le ? "disabled" : ""} style="width:22px;height:22px;accent-color:#5e0f1c"> Un petit message quand mon prochain soin approche${c.stop_le ? " (désactivé : vous avez répondu STOP)" : ""}</label>
<button type="submit">Enregistrer mes choix</button></form>`);
};

export const config = { path: "/api/desinscription" };
