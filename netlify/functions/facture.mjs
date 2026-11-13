// Affiche une facture en PDF.
// GET /api/facture?n=F2026-001&s=…   (lien signé : seul le site peut le fabriquer, il est envoyé à la cliente)
import * as C from "../lib/compta.mjs";
import { pdfFacture } from "../lib/facture.mjs";
import { page } from "../lib/messages.mjs";

export default async (req) => {
  const u = new URL(req.url).searchParams;
  const n = u.get("n") || "", s = u.get("s") || "";
  if (!/^F\d{4}-\d{3,}$/.test(n) || !C.lienFactureValide(n, s)) return page("Lien non valide", "<p>Ce lien de facture est incomplet ou n'a pas été créé par Coco Nail's.</p>", 403);
  if (!C.comptaConfiguree()) return page("Facture indisponible", "<p>Les factures ne sont pas encore disponibles en ligne.</p>", 503);
  let f;
  try { f = await C.lireFacture(n); } catch (e) {
    console.error(e);
    return page("Facture indisponible", "<p>Impossible d'afficher la facture pour le moment. Réessayez dans quelques minutes.</p>", 503);
  }
  if (!f) return page("Facture introuvable", "<p>Cette facture n'existe pas ou plus. Contactez Coco Nail's.</p>", 404);
  const pdf = await pdfFacture(f);
  return new Response(pdf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="facture-coco-nails-${n}.pdf"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
};

export const config = { path: "/api/facture" };
