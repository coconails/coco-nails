// Facture PDF de Coco Nail's (format A4), recréée à l'identique à chaque fois à partir du contenu
// figé au moment de la validation (onglet « Factures » du tableau de compta).
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { LOGO_JPEG } from "./logo-facture.mjs";

const hex = (h) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const BORDEAUX = hex("#5e0f1c"), POUDRE = hex("#fbe6e8"), ROSE = hex("#f2c3c4"), ENCRE = hex("#24161a"), GRIS = hex("#6d585c"), CARAMEL = hex("#b9804a");

export const euros = (n) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(Number(n) || 0).replace(/[  ]/g, " ");
export function dateFr(d, long = false) {
  if (!d) return "";
  const [a, m, j] = d.split("-").map(Number);
  return new Intl.DateTimeFormat("fr-FR", long ? { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" } : { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(a, m - 1, j)));
}

export async function pdfFacture(f) {
  const doc = await PDFDocument.create();
  doc.setTitle(`Facture ${f.numero} — Coco Nail's`);
  doc.setAuthor("Coco Nail's");
  doc.setSubject(`Facture ${f.numero}`);
  doc.setProducer("coconails72.com");
  doc.setCreator("coconails72.com");
  const fixe = new Date(`${f.date}T12:00:00Z`);
  doc.setCreationDate(fixe);
  doc.setModificationDate(fixe);

  const page = doc.addPage([595.28, 841.89]);
  const W = page.getWidth(), H = page.getHeight(), G = 50;
  const P = {
    n: await doc.embedFont(StandardFonts.Helvetica),
    g: await doc.embedFont(StandardFonts.HelveticaBold),
    i: await doc.embedFont(StandardFonts.TimesRomanBoldItalic),
  };
  // Les polices standard ne connaissent pas les émojis et quelques signes : on les retire proprement.
  const propre = (t, police) => [...String(t == null ? "" : t).replace(/[   ]/g, " ").replace(/[‘’]/g, "'").replace(/[“”]/g, '"')]
    .map((c) => { try { police.encodeText(c); return c; } catch { return ""; } }).join("").replace(/ {2,}/g, " ");
  const ecrire = (t, x, y, { police = P.n, taille = 10, couleur = ENCRE, aDroite = false, centre = false } = {}) => {
    const s = propre(t, police);
    const l = police.widthOfTextAtSize(s, taille);
    page.drawText(s, { x: aDroite ? x - l : centre ? x - l / 2 : x, y, size: taille, font: police, color: couleur });
  };
  const couper = (t, police, taille, largeur) => {
    const lignes = [];
    for (const para of String(t || "").split("\n")) {
      let cour = "";
      for (const mot of propre(para, police).split(" ")) {
        const essai = cour ? cour + " " + mot : mot;
        if (police.widthOfTextAtSize(essai, taille) > largeur && cour) { lignes.push(cour); cour = mot; } else cour = essai;
      }
      lignes.push(cour);
    }
    return lignes;
  };
  const bloc = (lignes, x, y, opts = {}) => { lignes.filter(Boolean).forEach((l, k) => ecrire(l, x, y - k * (opts.interligne || 14), opts)); };

  // Bandeau du haut
  page.drawRectangle({ x: 0, y: H - 150, width: W, height: 150, color: POUDRE });
  page.drawRectangle({ x: 0, y: H - 154, width: W, height: 4, color: ROSE });
  const logo = await doc.embedJpg(Buffer.from(LOGO_JPEG, "base64"));
  page.drawImage(logo, { x: G, y: H - 117, width: 84, height: 84 });
  ecrire("Coco Nail's", G + 102, H - 72, { police: P.i, taille: 30, couleur: BORDEAUX });
  ecrire("Prothésiste ongulaire", G + 104, H - 92, { taille: 10.5, couleur: GRIS });
  ecrire("FACTURE", W - G, H - 66, { police: P.g, taille: 24, couleur: BORDEAUX, aDroite: true });
  ecrire(`N° ${f.numero}`, W - G, H - 88, { police: P.g, taille: 12, aDroite: true });
  ecrire(`Date : ${dateFr(f.date)}`, W - G, H - 105, { taille: 10.5, couleur: GRIS, aDroite: true });

  // Émettrice et cliente
  const e = f.emetteur || {}, c = f.cliente || {};
  let y = H - 200;
  ecrire("ÉMISE PAR", G, y, { police: P.g, taille: 8.5, couleur: CARAMEL });
  ecrire("CLIENTE", 330, y, { police: P.g, taille: 8.5, couleur: CARAMEL });
  y -= 18;
  ecrire(e.nom, G, y, { police: P.g, taille: 11 });
  bloc([e.adresse, [e.code_postal, e.ville].filter(Boolean).join(" "), e.siret ? `SIRET : ${e.siret}` : e.siren ? `SIREN : ${e.siren}` : "",
    e.telephone ? `Tél. : ${e.telephone}` : "", e.email], G, y - 16, { taille: 10, couleur: GRIS });
  ecrire(c.nom, 330, y, { police: P.g, taille: 11 });
  bloc([...couper(c.adresse, P.n, 10, W - G - 330), c.telephone ? `Tél. : ${c.telephone}` : "", c.email], 330, y - 16, { taille: 10, couleur: GRIS });

  // Tableau de la prestation
  y = H - 345;
  page.drawRectangle({ x: G, y: y - 8, width: W - 2 * G, height: 28, color: BORDEAUX });
  ecrire("Désignation", G + 14, y + 2, { police: P.g, taille: 10.5, couleur: hex("#ffffff") });
  ecrire("Montant", W - G - 14, y + 2, { police: P.g, taille: 10.5, couleur: hex("#ffffff"), aDroite: true });
  y -= 34;
  const p = f.prestation || {};
  const designation = couper([p.soin, p.options].filter(Boolean).join(" + "), P.g, 11.5, W - 2 * G - 140);
  designation.forEach((l, k) => ecrire(l, G + 14, y - k * 15, { police: P.g, taille: 11.5 }));
  ecrire(euros(f.montant), W - G - 14, y, { police: P.g, taille: 11.5, aDroite: true });
  y -= designation.length * 15 + 2;
  if (p.date) { ecrire(`Prestation du ${dateFr(p.date, true)}`, G + 14, y, { taille: 9.5, couleur: GRIS }); y -= 14; }
  y -= 10;
  page.drawLine({ start: { x: G, y }, end: { x: W - G, y }, thickness: 1, color: ROSE });

  // Total
  y -= 34;
  page.drawRectangle({ x: W - G - 230, y: y - 12, width: 230, height: 36, color: POUDRE });
  ecrire("Total à payer", W - G - 216, y, { police: P.g, taille: 12, couleur: BORDEAUX });
  ecrire(euros(f.montant), W - G - 14, y, { police: P.g, taille: 14, couleur: BORDEAUX, aDroite: true });
  y -= 34;
  ecrire(f.mention_tva || "TVA non applicable, article 293 B du CGI", W - G, y, { taille: 9.5, couleur: GRIS, aDroite: true });

  // Paiement
  y -= 46;
  page.drawRectangle({ x: G, y: y - 14, width: W - 2 * G, height: 40, color: hex("#eef6ef"), borderColor: hex("#2f6b3a"), borderWidth: 1 });
  ecrire(`Facture acquittée : payée le ${dateFr(f.paye_le)}${f.paiement ? " par " + f.paiement.toLowerCase() : ""}.`, G + 16, y, { police: P.g, taille: 11, couleur: hex("#2f6b3a") });

  y -= 56;
  ecrire("Merci pour votre confiance et à très bientôt chez Coco Nail's !", W / 2, y, { police: P.i, taille: 14, couleur: BORDEAUX, centre: true });

  // Pied de page : mentions légales
  page.drawLine({ start: { x: G, y: 92 }, end: { x: W - G, y: 92 }, thickness: 0.8, color: ROSE });
  const pied = [
    [e.nom, [e.adresse, [e.code_postal, e.ville].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean).join(" · "),
    [e.siret ? `SIRET ${e.siret}` : e.siren ? `SIREN ${e.siren}` : "", e.rne].filter(Boolean).join(" · "),
    [f.mention_tva || "TVA non applicable, article 293 B du CGI", e.site].filter(Boolean).join(" · "),
  ];
  let yp = 76;
  for (const l of pied) for (const morceau of couper(l, P.n, 8, W - 2 * G)) { ecrire(morceau, W / 2, yp, { taille: 8, couleur: GRIS, centre: true }); yp -= 11; }

  return doc.save({ useObjectStreams: false });
}
