// Préparation de la page à chaque publication Netlify (commande de build, voir netlify.toml).
// Écrit directement dans public/index.html, à partir des contenus de Pages CMS (public/contenu/*.json) :
//   - la carte beauté (soins, prix, durées), les options, la FAQ, les horaires, le téléphone, les cadres des photos d'accueil ;
//   - les données structurées Schema.org (NailSalon + FAQPage), toujours à jour ;
//   - la date de mise à jour du sitemap.
// Les moteurs de recherche et les assistants IA qui n'exécutent pas JavaScript voient ainsi les vraies informations.
// Le JavaScript de la page réaffiche ensuite les mêmes contenus (rien ne change pour les visiteuses).
// En cas de problème, la page d'origine est laissée telle quelle : le site fonctionne comme avant.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RACINE = fileURLToPath(new URL("../public/", import.meta.url));
const SITE = "https://coconails72.com";
const ORDRE = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
const JOURS_EN = { lundi: "Monday", mardi: "Tuesday", mercredi: "Wednesday", jeudi: "Thursday", vendredi: "Friday", samedi: "Saturday", dimanche: "Sunday" };
// Zone desservie : les communes de la Communauté de communes du Val de Sarthe + Noyen-sur-Sarthe (validé le 15/11/2026).
export const ZONE = ["Saint-Jean-du-Bois", "La Suze-sur-Sarthe", "Fercé-sur-Sarthe", "Chemiré-le-Gaudin", "Louplande", "Roëzé-sur-Sarthe",
  "Malicorne-sur-Sarthe", "Noyen-sur-Sarthe", "Cérans-Foulletourte", "Guécélard", "Parigné-le-Pôlin", "Spay", "Fillé",
  "Étival-lès-le-Mans", "Voivres-lès-le-Mans", "Souligné-Flacé", "Mézeray"];

const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const lire = (nom) => { try { return JSON.parse(readFileSync(RACINE + `contenu/${nom}.json`, "utf8")); } catch { return {}; } };
function enMinutes(h) { const m = /^(\d{1,2})[:h ]?(\d{2})?$/.exec(String(h || "").trim()); return m ? Number(m[1]) * 60 + Number(m[2] || 0) : null; }
const fmtHeure = (m) => { const h = Math.floor(m / 60), mi = m % 60; return `${h} h${mi ? " " + String(mi).padStart(2, "0") : ""}`; };
function fmtDuree(m) { const h = Math.floor(m / 60), mi = m % 60; return (h ? h + " h" : "") + (h && mi ? " " : "") + (mi ? (h ? String(mi).padStart(2, "0") : mi + " min") : ""); }
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const nombres = (t) => (String(t || "").match(/\d+(?:[.,]\d{1,2})?/g) || []).map((x) => Number(x.replace(",", ".")));
const telIntl = (t) => { const c = String(t || "").replace(/[^\d+]/g, ""); return /^0\d{9}$/.test(c) ? "+33" + c.slice(1) : c; };

// ---- Morceaux de page, identiques à ce qu'affiche le JavaScript ----
export function htmlSoins(soins) {
  const groupes = new Map();
  for (const s of (soins.soins || []).filter((x) => x && x.nom)) { const g = s.categorie || "Les soins"; if (!groupes.has(g)) groupes.set(g, []); groupes.get(g).push(s); }
  return [...groupes].map(([g, liste]) => `<div class="carte-groupe"><h3>${esc(g)}</h3><ul class="carte">${liste.map((s) =>
    `<li><div class="ligne"><h3>${esc(s.nom)}</h3><span class="points"></span><span class="tarif">${s.prix ? esc(s.prix) : '<span class="sur-demande">prix sur demande</span>'}</span></div>` +
    `<p>${s.description ? esc(s.description) + " " : ""}${s.duree ? `<span class="duree">Environ ${esc(fmtDuree(Number(s.duree)))}.</span>` : ""}</p></li>`).join("")}</ul></div>`).join("");
}
export const htmlOptions = (soins) => (soins.options || []).filter((o) => o && o.nom).map((o) =>
  `<div class="option"><h4>${esc(o.nom)}</h4>${o.description ? `<p>${esc(o.description)}</p>` : ""}<strong>${esc((o.prix || "") + (o.duree ? ", environ " + fmtDuree(Number(o.duree)) + " en plus" : ""))}</strong></div>`).join("");
export const htmlFaq = (q) => (q.questions || []).filter((x) => x && x.question).map((x) =>
  `<details><summary>${esc(x.question)}</summary><p>${esc(x.reponse || "")}</p></details>`).join("");
export function htmlHoraires(co) {
  const sem = co.semaine || {};
  return ORDRE.filter((j) => sem[j]).map((j) => {
    const h = sem[j], a = enMinutes(h.debut), b = enMinutes(h.fin);
    return `<tr><td>${j.charAt(0).toUpperCase() + j.slice(1)}</td><td>${h.ouvert && a != null && b != null ? `${fmtHeure(a)} – ${fmtHeure(b)}` : "Fermé"}</td></tr>`;
  }).join("");
}
// Seulement les cadres en forme d'ongle : ils réservent la place (pas de saut d'affichage) ;
// les photos y sont glissées par le JavaScript, pour ne pas ralentir le premier affichage.
export const htmlMain = (photos) => (photos.photos || []).filter((p) => p && p.image).slice(0, 5).map((p, i) =>
  `<div class="ongle o${i + 1}"></div>`).join("");

// ---- Données structurées Schema.org ----
export function donneesStructurees({ soins, questions, co, paiement, existant }) {
  const sem = co.semaine || {};
  const plages = new Map();
  for (const j of ORDRE) {
    const h = sem[j]; if (!h || !h.ouvert) continue;
    const a = enMinutes(h.debut), b = enMinutes(h.fin); if (a == null || b == null || b <= a) continue;
    const k = `${hhmm(a)}-${hhmm(b)}`; if (!plages.has(k)) plages.set(k, []); plages.get(k).push(JOURS_EN[j]);
  }
  const prix = (soins.soins || []).flatMap((s) => nombres(s.prix));
  const offre = (nom, description, prixTexte) => {
    const n = nombres(prixTexte);
    const o = { "@type": "Offer", itemOffered: { "@type": "Service", name: nom, ...(description ? { description } : {}) } };
    if (n.length === 1) Object.assign(o, { price: n[0], priceCurrency: "EUR" });
    else if (n.length >= 2) o.priceSpecification = { "@type": "PriceSpecification", minPrice: Math.min(...n), maxPrice: Math.max(...n), priceCurrency: "EUR" };
    return o;
  };
  const salon = {
    ...existant, "@type": "NailSalon", "@id": `${SITE}/#salon`, name: "Coco Nail's", url: `${SITE}/`,
    ...(co.email ? { email: co.email } : {}),
    ...(co.telephone ? { telephone: telIntl(co.telephone) } : {}),
    address: { "@type": "PostalAddress", streetAddress: co.adresse || existant.address?.streetAddress, postalCode: co.code_postal || existant.address?.postalCode,
      addressLocality: co.ville || existant.address?.addressLocality, addressRegion: "Pays de la Loire", addressCountry: "FR" },
    ...(co.lien_google_maps ? { hasMap: co.lien_google_maps } : {}),
    sameAs: [co.instagram ? `https://www.instagram.com/${co.instagram}/` : null, co.lien_google_maps || null].filter(Boolean),
    areaServed: ZONE.map((name) => ({ "@type": "City", name })),
    ...(prix.length ? { priceRange: `${Math.min(...prix)} € – ${Math.max(...prix)} €` } : {}),
    paymentAccepted: ((paiement.moyens || []).map((m) => m && m.moyen).filter(Boolean).join(", ")) || existant.paymentAccepted,
    openingHoursSpecification: [...plages].map(([k, jours]) => ({ "@type": "OpeningHoursSpecification", dayOfWeek: jours, opens: k.slice(0, 5), closes: k.slice(6) })),
    hasOfferCatalog: { "@type": "OfferCatalog", name: "La carte beauté", itemListElement: [
      ...(soins.soins || []).filter((s) => s && s.nom).map((s) => offre(s.nom, s.description, s.prix)),
      ...(soins.options || []).filter((o) => o && o.nom).map((o) => offre(o.nom, o.description, o.prix)),
    ] },
  };
  delete salon["@context"];
  const faq = (questions.questions || []).filter((x) => x && x.question && x.reponse);
  return { "@context": "https://schema.org", "@graph": [salon, ...(faq.length ? [{ "@type": "FAQPage", "@id": `${SITE}/#faq`,
    mainEntity: faq.map((x) => ({ "@type": "Question", name: x.question, acceptedAnswer: { "@type": "Answer", text: x.reponse } })) }] : [])] };
}

// Remplace le contenu d'une balise repérée par son attribut, uniquement si elle est encore vide.
function remplir(html, ouverture, fermeture, contenu) {
  const i = html.indexOf(ouverture);
  if (i < 0 || !contenu) return html;
  const j = i + ouverture.length;
  if (!html.startsWith(fermeture, j)) return html; // déjà rempli : on ne touche à rien
  return html.slice(0, j) + contenu + html.slice(j);
}

export function preparer(html, c) {
  let h = html;
  h = remplir(h, '<div class="main" data-main role="img" aria-label="Photos de réalisations Coco Nail\'s présentées en forme d\'ongles">', "</div>", htmlMain(c.photos));
  h = remplir(h, "<div data-soins>", "</div>", htmlSoins(c.soins));
  h = remplir(h, '<div class="options-carte" data-options>', "</div>", htmlOptions(c.soins));
  h = remplir(h, '<div class="faq" data-faq>', "</div>", htmlFaq(c.questions));
  h = remplir(h, '<table class="table-horaires" data-table-horaires aria-label="Horaires d\'ouverture">', "</table>", htmlHoraires(c.co));
  if (c.co.telephone) h = h.replace('<dt data-tel-dt hidden>Téléphone</dt><dd data-tel-dd hidden></dd>',
    `<dt data-tel-dt>Téléphone</dt><dd data-tel-dd><a href="tel:${esc(String(c.co.telephone).replace(/\s/g, ""))}">${esc(c.co.telephone)}</a></dd>`);
  const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(h);
  if (m) {
    let existant = {}; try { existant = JSON.parse(m[1]); } catch {}
    if (existant["@graph"]) existant = existant["@graph"][0] || {};
    const ld = JSON.stringify(donneesStructurees({ ...c, existant }), null, 1).replace(/</g, "\\u003c");
    h = h.replace(m[0], `<script type="application/ld+json">\n${ld}\n</script>`);
  }
  return h;
}

export function contenus() {
  return { photos: lire("photos"), soins: lire("soins"), questions: lire("questions"), co: lire("coordonnees"), paiement: lire("paiement") };
}

// Exécution directe (build Netlify)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const page = RACINE + "index.html";
    const avant = readFileSync(page, "utf8");
    const apres = preparer(avant, contenus());
    if (!apres.includes("</html>") || apres.length < avant.length) throw new Error("résultat suspect, page laissée telle quelle");
    writeFileSync(page, apres);
    const plan = RACINE + "sitemap.xml";
    writeFileSync(plan, readFileSync(plan, "utf8").replace(/<lastmod>[^<]*<\/lastmod>/g, "").replace("</loc></url>", `</loc><lastmod>${new Date().toISOString().slice(0, 10)}</lastmod></url>`));
    console.log(`Page préparée : ${apres.length - avant.length} caractères ajoutés (carte beauté, FAQ, horaires, données structurées).`);
  } catch (e) {
    console.error("Préparation de la page ignorée :", e.message);
  }
}
