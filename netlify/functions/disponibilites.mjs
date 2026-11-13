// Renvoie les plages occupées de l'agenda de Coralie (heures seulement, aucun détail sur les clientes).
// GET /api/disponibilites?du=2026-11-12&au=2027-01-10
import { configuree, occupe, instant, json } from "../lib/agenda.mjs";

export default async (req) => {
  if (!configuree()) return json({ actif: false, occupe: [] });
  const url = new URL(req.url);
  const du = url.searchParams.get("du"), au = url.searchParams.get("au");
  const ok = /^\d{4}-\d{2}-\d{2}$/;
  if (!ok.test(du || "") || !ok.test(au || "")) return json({ erreur: "Dates invalides." }, 400);
  const debut = instant(du, 0), fin = instant(au, 24 * 60);
  if (fin <= debut || fin - debut > 70 * 86400000) return json({ erreur: "Période trop longue." }, 400);
  try {
    const plages = await occupe(new Date(debut).toISOString(), new Date(fin).toISOString());
    return json({ actif: true, occupe: plages });
  } catch (e) {
    console.error(e);
    return json({ actif: false, occupe: [], erreur: "Agenda momentanément indisponible." }, 503);
  }
};

export const config = { path: "/api/disponibilites" };
