// Archivage des justificatifs (tickets, factures fournisseurs) dans le Google Drive de Coralie.
// Le site agit au nom de contact@coconails72.com (délégation au niveau du domaine, autorisation
// « drive.file » : il ne voit QUE les fichiers et dossiers qu'il a lui-même créés).
import { createHash } from "node:crypto";
import { jeton, expediteur } from "./agenda.mjs";
import { Refus, majReglage } from "./compta.mjs";

const SCOPE_DRIVE = "https://www.googleapis.com/auth/drive.file";
const DOSSIER = "application/vnd.google-apps.folder";
export const TYPES_ACCEPTES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "application/pdf": "pdf" };
export const TAILLE_MAX = 4 * 1024 * 1024;

async function autorisation() {
  try { return `Bearer ${await jeton(SCOPE_DRIVE, expediteur())}`; }
  catch {
    throw new Refus("Le classement des tickets dans Google Drive n'est pas encore autorisé (réglage à faire dans la console d'administration Google).", 503);
  }
}
async function drive(url, options) {
  const rep = await fetch(url, { ...options, headers: { Authorization: await autorisation(), ...(options.headers || {}) } });
  if (rep.status === 401 || rep.status === 403)
    throw new Refus("Google Drive refuse l'accès : vérifiez que l'API Google Drive est activée et autorisée pour le site.", 503);
  if (!rep.ok) throw new Error(`Google Drive : erreur ${rep.status}`);
  return rep.json();
}
async function creerDossier(nom, parent) {
  const r = await drive("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: nom, mimeType: DOSSIER, ...(parent ? { parents: [parent] } : {}) }),
  });
  return r.id;
}
// Un dossier « Comptabilité Coco Nail's — Justificatifs », puis un sous-dossier par année.
async function dossierAnnee(annee, donnees) {
  let racine = donnees.reglages.dossier_justificatifs;
  if (!racine) { racine = await creerDossier("Comptabilité Coco Nail's — Justificatifs"); await majReglage("dossier_justificatifs", racine, donnees); }
  const cle = `dossier_justificatifs_${annee}`;
  let id = donnees.reglages[cle];
  if (!id) { id = await creerDossier(String(annee), racine); await majReglage(cle, id, donnees); }
  return id;
}

const propre = (t) => String(t || "").normalize("NFC").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);

// Dépose un fichier et renvoie {id, lien, empreinte}.
export async function deposer(depense, { type, donnees: octets }, donnees) {
  if (!TYPES_ACCEPTES[type]) throw new Refus("Format non accepté : envoyez une photo (JPEG, PNG) ou un PDF.");
  if (!octets.length || octets.length > TAILLE_MAX) throw new Refus("Le fichier est trop lourd (4 Mo au maximum).");
  const empreinte = createHash("sha256").update(octets).digest("hex");
  const montant = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(depense.montant) || 0).replace(/[  ]/g, " ");
  const nom = `${depense.date} ${propre(depense.fournisseur || depense.libelle)} ${montant} €.${TYPES_ACCEPTES[type]}`;
  const parent = await dossierAnnee(depense.date.slice(0, 4), donnees);
  const meta = { name: nom, parents: [parent], description: `${depense.libelle} — ${depense.categorie} — empreinte SHA-256 : ${empreinte}`, appProperties: { depense: depense.id, sha256: empreinte } };
  const borne = "coco" + empreinte.slice(0, 24);
  const corps = Buffer.concat([
    Buffer.from(`--${borne}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${borne}\r\nContent-Type: ${type}\r\n\r\n`),
    octets, Buffer.from(`\r\n--${borne}--`),
  ]);
  const r = await drive("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
    method: "POST", headers: { "Content-Type": `multipart/related; boundary=${borne}` }, body: corps,
  });
  return { id: r.id, lien: r.webViewLink || `https://drive.google.com/file/d/${r.id}/view`, empreinte };
}
