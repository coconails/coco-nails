// Rappel automatique de déclaration URSSAF, envoyé par e-mail à Coralie.
// Tourne tous les matins (Netlify) mais n'écrit que :
//  - le 5 du mois, s'il reste une période terminée non déclarée ;
//  - 5 jours avant la date limite, si elle n'est toujours pas marquée « déclarée ».
import { configuree, contenu, envoyerMail, destinataireAlertes } from "../lib/agenda.mjs";
import * as C from "../lib/compta.mjs";
import { rappelUrssaf } from "../lib/messages.mjs";

const JOUR_MS = 86400000;

export async function verifierRappel(origine) {
  const d = await C.lireTout();
  if (configuree()) {
    try { await C.synchroniser(d, await contenu(origine, "soins")); } catch (e) { console.error(e); }
  }
  const auj = C.aujourdhui();
  const enRetard = C.resumePeriodes(d).filter((p) => p.terminee && !p.declaration).sort((a, b) => (a.periode < b.periode ? -1 : 1));
  if (!enRetard.length) return null;
  const jours = (p) => Math.round((Date.parse(p.echeance + "T00:00:00Z") - Date.parse(auj + "T00:00:00Z")) / JOUR_MS);
  const proche = enRetard.filter((p) => jours(p) === 5);
  let mail = null;
  if (auj.slice(8, 10) === "05") mail = rappelUrssaf(enRetard, origine, false);
  else if (proche.length) mail = rappelUrssaf(proche, origine, true);
  if (mail) await envoyerMail({ a: destinataireAlertes(), ...mail });
  return mail;
}

export default async () => {
  if (!C.comptaConfiguree()) return;
  try { await verifierRappel(process.env.URL || "https://coconails72.com"); } catch (e) { console.error(e); }
};

// Tous les jours à 7 h (heure universelle), soit 8 h ou 9 h à Paris.
export const config = { schedule: "0 7 * * *" };
