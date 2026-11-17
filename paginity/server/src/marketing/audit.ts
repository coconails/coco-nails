import fs from 'node:fs';
import path from 'node:path';

/**
 * PAGINITY Marketing — M1 : audit de référencement LOCAL, en lecture seule, sans aucun compte extérieur.
 *
 * Il lit les fichiers d'une version FABRIQUÉE du site (le brouillon fabriqué pour l'occasion, ou la version en
 * ligne) et applique des règles déterministes et documentées : aucune IA, aucun appel réseau, aucun score inventé.
 * Chaque constat dit ce qui a été trouvé, où, pourquoi c'est important et quoi faire.
 *
 * Niveaux : « probleme » (empêche ou gêne nettement l'affichage dans les moteurs), « attention » (à améliorer),
 * « info » (à savoir, peut être volontaire). Les seuils (longueurs de titre, poids d'image…) sont des repères
 * usuels, pas des règles officielles de Google : le texte le dit.
 */

export type Niveau = 'probleme' | 'attention' | 'info';
export interface Constat {
  regle: string;
  niveau: Niveau;
  page: string | null;
  message: string;
  conseil: string;
}
export interface ResultatAudit {
  pages: number;
  pagesIndexables: number;
  constats: Constat[];
  /** Ce qui a été vérifié et trouvé correct (pour que l'absence de problème soit visible). */
  verifie: string[];
}

const MAX_HTML = 2 * 1024 * 1024;
const POIDS_IMAGE = 300 * 1024;

// ---------------------------------------------------------------------------- lecture HTML (légère, sans dépendance)
/** Attributs d'une balise : <meta name="x" content="y"> → { name: 'x', content: 'y' }. */
function attributs(balise: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of balise.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const nom = m[1].toLowerCase();
    if (out[nom] === undefined) out[nom] = decoder(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return out;
}
function decoder(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}
const sansCommentaires = (h: string) => h.replace(/<!--[\s\S]*?-->/g, '');
function balises(html: string, nom: string): Record<string, string>[] {
  return [...html.matchAll(new RegExp(`<${nom}\\b([^>]*)>`, 'gi'))].map((m) => attributs(m[1]));
}
const texte = (h: string) => decoder(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

export interface Page {
  fichier: string;
  url: string;
  html: string;
}

/** Adresse publique d'un fichier HTML : index.html → /, a/index.html → /a/, merci.html → /merci.html. */
export function adresseDe(rel: string): string {
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return `/${rel.slice(0, -'index.html'.length)}`;
  return `/${rel}`;
}

/** Fichier servi pour une adresse (mêmes règles que le serveur des sites : /x → x.html ou x/index.html). */
export function fichierPour(racine: string, adresse: string): string | null {
  let p: string;
  try {
    p = decodeURIComponent(adresse.split(/[?#]/)[0]);
  } catch {
    return null;
  }
  p = p.replace(/^\/+/, '');
  const essais = p === '' ? ['index.html'] : p.endsWith('/') ? [`${p}index.html`] : [p, `${p}.html`, `${p}/index.html`];
  for (const e of essais) {
    const abs = path.join(racine, e);
    if (!abs.startsWith(racine + path.sep) && abs !== racine) continue;
    try {
      if (fs.statSync(abs).isFile()) return e;
    } catch {
      /* suivant */
    }
  }
  return null;
}

function fichiers(racine: string, rel = '', out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(racine, rel), { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) fichiers(racine, r, out);
    else if (e.isFile()) out.push(r);
  }
  return out;
}

const telephones = (s: string) => [...s.matchAll(/(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}/g)].map((m) => m[0].replace(/\D/g, '').replace(/^33/, '0'));

// ---------------------------------------------------------------------------- audit
/**
 * @param racine dossier de la version fabriquée (contient index.html)
 * @param domaines domaines du site (sans https://), pour vérifier canonical et sitemap
 */
export function auditer(racine: string, domaines: string[] = []): ResultatAudit {
  const constats: Constat[] = [];
  const verifie: string[] = [];
  const ajouter = (regle: string, niveau: Niveau, page: string | null, message: string, conseil: string) => constats.push({ regle, niveau, page, message, conseil });
  const tous = fichiers(racine);
  const htmls = tous.filter((f) => /\.html?$/i.test(f) && fs.statSync(path.join(racine, f)).size <= MAX_HTML);
  const pages: Page[] = htmls.map((f) => ({ fichier: f, url: adresseDe(f), html: sansCommentaires(fs.readFileSync(path.join(racine, f), 'utf8')) }));
  const domainesMin = domaines.map((d) => d.toLowerCase());

  // ---- robots.txt
  let robots: string | null = null;
  try {
    robots = fs.readFileSync(path.join(racine, 'robots.txt'), 'utf8');
  } catch {
    ajouter('robots-absent', 'info', '/robots.txt', 'Pas de fichier robots.txt.', 'Ce n’est pas obligatoire (tout est alors autorisé), mais un robots.txt qui indique l’adresse du sitemap aide les moteurs.');
  }
  const bloquees: string[] = [];
  if (robots !== null) {
    let pourTous = false;
    for (const ligne of robots.split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim())) {
      const [cle, ...reste] = ligne.split(':');
      const v = reste.join(':').trim();
      if (/^user-agent$/i.test(cle)) pourTous = v === '*';
      else if (pourTous && /^disallow$/i.test(cle) && v) bloquees.push(v);
    }
    if (bloquees.includes('/')) ajouter('robots-tout-bloque', 'probleme', '/robots.txt', 'robots.txt interdit TOUT le site aux moteurs (« Disallow: / »).', 'Si le site doit apparaître dans Google, retirez cette ligne.');
    else verifie.push('robots.txt n’interdit pas le site');
    if (!/^\s*sitemap\s*:/im.test(robots)) ajouter('robots-sans-sitemap', 'info', '/robots.txt', 'robots.txt n’indique pas l’adresse du sitemap.', 'Ajoutez une ligne « Sitemap: https://votre-domaine/sitemap.xml ».');
  }
  const bloqueParRobots = (url: string) => bloquees.some((b) => b !== '/' && url.startsWith(b));

  // ---- sitemap.xml
  let dansSitemap = new Set<string>();
  const cheminSitemap = fichierPour(racine, '/sitemap.xml');
  if (!cheminSitemap) ajouter('sitemap-absent', 'attention', '/sitemap.xml', 'Pas de sitemap.xml.', 'Un sitemap liste les pages à indexer ; il se déclare ensuite dans Google Search Console.');
  else {
    const xml = fs.readFileSync(path.join(racine, cheminSitemap), 'utf8');
    if (!/<urlset[\s>]/i.test(xml) && !/<sitemapindex[\s>]/i.test(xml)) ajouter('sitemap-invalide', 'probleme', '/sitemap.xml', 'Le sitemap n’a pas la forme attendue (<urlset> manquant).', 'Régénérez-le : il doit suivre le format sitemaps.org.');
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decoder(m[1]));
    for (const loc of locs) {
      let u: URL;
      try {
        u = new URL(loc);
      } catch {
        ajouter('sitemap-adresse', 'probleme', '/sitemap.xml', `Adresse invalide dans le sitemap : « ${loc.slice(0, 80)} ».`, 'Le sitemap doit contenir des adresses complètes (https://…).');
        continue;
      }
      if (domainesMin.length && !domainesMin.includes(u.hostname.toLowerCase())) {
        ajouter('sitemap-domaine', 'attention', '/sitemap.xml', `Le sitemap pointe vers un autre domaine (${u.hostname}).`, `Les adresses doivent être sur ${domainesMin[0]}.`);
      }
      const f = fichierPour(racine, u.pathname);
      if (!f) ajouter('sitemap-page-absente', 'probleme', '/sitemap.xml', `Le sitemap annonce ${u.pathname}, mais cette page n’existe pas.`, 'Retirez-la du sitemap ou recréez la page.');
      else dansSitemap.add(adresseDe(f));
    }
    if (locs.length && !constats.some((c) => c.regle.startsWith('sitemap-'))) verifie.push(`sitemap.xml valide (${locs.length} adresse(s), toutes présentes)`);
    for (const m of xml.matchAll(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/gi)) {
      if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/.test(m[1])) {
        ajouter('sitemap-date', 'attention', '/sitemap.xml', `Date « ${m[1]} » au mauvais format dans le sitemap.`, 'Format attendu : AAAA-MM-JJ.');
        break;
      }
    }
  }
  if (!cheminSitemap) dansSitemap = new Set();

  // ---- page 404
  if (fichierPour(racine, '/404.html')) verifie.push('page 404 personnalisée présente');
  else ajouter('404-absente', 'info', null, 'Pas de page 404 personnalisée.', 'Une page « introuvable » aux couleurs du site aide les visiteurs égarés à retrouver l’accueil.');

  // ---- pages
  const titres = new Map<string, string[]>();
  const descriptions = new Map<string, string[]>();
  const telsSite = new Set<string>();
  const telsJsonLd = new Set<string>();
  let indexables = 0;
  let imagesSansAlt = 0;
  for (const p of pages) {
    const h = p.html;
    const est404 = /(^|\/)404\.html$/.test(p.fichier);
    const robotsMeta = balises(h, 'meta').filter((m) => /^(robots|googlebot)$/i.test(m.name ?? '')).map((m) => (m.content ?? '').toLowerCase());
    const noindex = robotsMeta.some((c) => c.includes('noindex') || c.includes('none'));
    if (noindex) {
      if (p.url === '/') ajouter('accueil-noindex', 'probleme', p.url, 'La page d’accueil demande à ne PAS être indexée (« noindex »).', 'Retirez la balise <meta name="robots" content="noindex"> : sinon le site disparaît de Google.');
      else if (dansSitemap.has(p.url)) ajouter('noindex-dans-sitemap', 'probleme', p.url, 'Page marquée « noindex » mais annoncée dans le sitemap : instructions contradictoires.', 'Retirez-la du sitemap, ou retirez le « noindex » si elle doit apparaître.');
      else if (!est404) ajouter('noindex', 'info', p.url, 'Page volontairement exclue des moteurs (« noindex »).', 'Normal pour une page privée, de remerciement ou d’administration. Sinon, retirez le « noindex ».');
      continue; // les autres règles concernent les pages destinées aux moteurs
    }
    if (est404) continue;
    indexables++;
    if (bloqueParRobots(p.url)) ajouter('page-bloquee-robots', 'attention', p.url, 'Page interdite aux moteurs par robots.txt.', 'Si elle doit apparaître dans Google, ajustez robots.txt.');
    if (cheminSitemap && !dansSitemap.has(p.url)) ajouter('hors-sitemap', 'attention', p.url, 'Page indexable absente du sitemap.', 'Ajoutez-la au sitemap (ou marquez-la « noindex » si elle ne doit pas apparaître).');

    // Langue, mobile
    const html = balises(h, 'html')[0] ?? {};
    if (!html.lang) ajouter('langue', 'attention', p.url, 'La langue de la page n’est pas indiquée (<html lang="fr">).', 'Ajoutez lang="fr" à la balise <html>.');
    if (!balises(h, 'meta').some((m) => (m.name ?? '').toLowerCase() === 'viewport')) ajouter('viewport', 'probleme', p.url, 'Pas de balise « viewport » : la page s’affiche mal sur téléphone.', 'Ajoutez <meta name="viewport" content="width=device-width, initial-scale=1">.');

    // Titre
    const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(h);
    const titre = t ? texte(t[1]) : '';
    if (!titre) ajouter('titre-absent', 'probleme', p.url, 'Pas de titre (<title>).', 'Le titre est la ligne bleue cliquable dans Google : décrivez la page et le lieu en quelques mots.');
    else {
      (titres.get(titre) ?? titres.set(titre, []).get(titre)!).push(p.url);
      if (/\{\{|\}\}/.test(titre)) ajouter('titre-modele', 'probleme', p.url, `Le titre contient un texte de modèle non remplacé : « ${titre} ».`, 'Remplacez-le par le vrai nom du site.');
      if (titre.length < 15) ajouter('titre-court', 'attention', p.url, `Titre très court (${titre.length} caractères) : « ${titre} ».`, 'Ajoutez l’activité et la ville, par exemple « Prothésiste ongulaire à … ».');
      if (titre.length > 65) ajouter('titre-long', 'info', p.url, `Titre de ${titre.length} caractères : Google en coupe souvent l’affichage vers 60 caractères.`, 'Placez l’essentiel au début ; la fin peut être coupée dans les résultats.');
    }

    // Description
    const desc = (balises(h, 'meta').find((m) => (m.name ?? '').toLowerCase() === 'description')?.content ?? '').trim();
    if (!desc) ajouter('description-absente', 'attention', p.url, 'Pas de description (<meta name="description">).', 'Sans elle, Google choisit lui-même un extrait. Résumez la page en une ou deux phrases.');
    else {
      (descriptions.get(desc) ?? descriptions.set(desc, []).get(desc)!).push(p.url);
      if (/\{\{|\}\}/.test(desc)) ajouter('description-modele', 'probleme', p.url, 'La description contient un texte de modèle non remplacé.', 'Écrivez une vraie description.');
      if (desc.length < 50) ajouter('description-courte', 'info', p.url, `Description courte (${desc.length} caractères).`, 'Une ou deux phrases (environ 120 à 160 caractères) décrivent mieux la page.');
      if (desc.length > 170) ajouter('description-longue', 'info', p.url, `Description de ${desc.length} caractères : elle sera probablement coupée.`, 'Mettez l’essentiel dans les 150 premiers caractères.');
    }

    // Titre principal
    const h1 = [...h.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => texte(m[1]));
    if (!h1.length) ajouter('h1-absent', 'attention', p.url, 'Pas de titre principal (<h1>).', 'Chaque page devrait avoir un titre principal visible qui dit de quoi elle parle.');
    else if (h1.length > 1) ajouter('h1-multiple', 'info', p.url, `${h1.length} titres principaux (<h1>).`, 'Un seul <h1> par page est plus clair ; les sous-parties utilisent <h2>.');

    // Canonical
    const canon = balises(h, 'link').filter((l) => (l.rel ?? '').toLowerCase().split(/\s+/).includes('canonical'));
    if (canon.length > 1) ajouter('canonical-multiple', 'probleme', p.url, 'Plusieurs adresses « canonical » sur la même page.', 'Gardez-en une seule.');
    if (canon[0]?.href) {
      let u: URL | null = null;
      try {
        u = new URL(canon[0].href);
      } catch {
        ajouter('canonical-relative', 'attention', p.url, `Adresse canonical incomplète : « ${canon[0].href} ».`, 'Indiquez l’adresse complète (https://…).');
      }
      if (u) {
        if (domainesMin.length && !domainesMin.includes(u.hostname.toLowerCase())) ajouter('canonical-domaine', 'probleme', p.url, `L’adresse canonical pointe vers un autre domaine (${u.hostname}).`, 'Google risque d’indexer l’autre adresse à la place de celle-ci.');
        else if (fichierPour(racine, u.pathname) !== fichierPour(racine, p.url)) ajouter('canonical-autre-page', 'attention', p.url, `L’adresse canonical désigne une autre page (${u.pathname}).`, 'Normal seulement si cette page est un doublon de l’autre.');
      }
    }

    // Partage sur les réseaux (Open Graph)
    const og = (prop: string) => balises(h, 'meta').find((m) => (m.property ?? '').toLowerCase() === prop)?.content;
    if (p.url === '/') {
      const manque = ['og:title', 'og:description', 'og:image'].filter((x) => !og(x));
      if (manque.length) ajouter('opengraph', 'info', p.url, `Aperçu de partage incomplet (manque : ${manque.join(', ')}).`, 'Ces balises choisissent le titre, le texte et l’image affichés quand on partage le site sur Facebook, WhatsApp…');
      else verifie.push('aperçu de partage (Open Graph) complet sur l’accueil');
    }

    // Images
    for (const img of balises(h, 'img')) {
      if (img.alt === undefined) imagesSansAlt++;
      const src = img.src;
      if (src && !/^(?:[a-z]+:|\/\/)/i.test(src)) {
        const f = fichierPour(racine, src.startsWith('/') ? src : path.posix.join(path.posix.dirname(p.url.endsWith('/') ? `${p.url}x` : p.url), src));
        if (f) {
          const poids = fs.statSync(path.join(racine, f)).size;
          if (poids > POIDS_IMAGE) ajouter('image-lourde', 'attention', p.url, `Image lourde : ${f} (${Math.round(poids / 1024)} Ko).`, 'Réduisez-la (format WebP, largeur adaptée) : le site s’affiche plus vite sur téléphone.');
        }
      }
      if (src && (!img.width || !img.height)) ajouter('image-dimensions', 'info', p.url, `Image sans largeur/hauteur indiquées : ${src.slice(0, 60)}.`, 'Indiquer width et height évite que la page « saute » pendant le chargement.');
    }

    // Liens internes cassés
    for (const a of balises(h, 'a')) {
      const href = a.href;
      if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\{|\$)/i.test(href)) continue;
      const cible = href.startsWith('/') ? href : path.posix.join(path.posix.dirname(p.url.endsWith('/') ? `${p.url}x` : p.url), href);
      if (!fichierPour(racine, cible)) ajouter('lien-casse', 'probleme', p.url, `Lien vers une page qui n’existe pas : ${href}.`, 'Corrigez le lien ou recréez la page.');
    }

    // Téléphones visibles (liens tel: et texte)
    for (const a of balises(h, 'a')) if ((a.href ?? '').startsWith('tel:')) telephones(a.href.slice(4)).forEach((x) => telsSite.add(x));
    telephones(texte(h.replace(/<script[\s\S]*?<\/script>/gi, ''))).forEach((x) => telsSite.add(x));

    // Données structurées
    for (const m of h.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (!/application\/ld\+json/i.test(attributs(m[1]).type ?? '')) continue;
      let donnees: unknown;
      try {
        donnees = JSON.parse(m[2]);
      } catch {
        ajouter('jsonld-illisible', 'probleme', p.url, 'Données structurées (JSON-LD) illisibles : erreur de syntaxe.', 'Google les ignore entièrement. Corrigez la syntaxe (virgule ou guillemet manquant).');
        continue;
      }
      verifierJsonLd(donnees, p.url, ajouter, verifie, telsJsonLd);
    }
  }
  if (imagesSansAlt) ajouter('image-sans-alt', 'attention', null, `${imagesSansAlt} image(s) sans texte alternatif (attribut alt absent).`, 'Le texte alternatif décrit l’image aux personnes malvoyantes et aux moteurs. Mettez alt="" pour une image purement décorative.');

  for (const [t, urls] of titres) if (urls.length > 1) ajouter('titre-double', 'attention', urls.join(', '), `Même titre sur ${urls.length} pages : « ${t} ».`, 'Chaque page devrait avoir son propre titre.');
  for (const [, urls] of descriptions) if (urls.length > 1) ajouter('description-double', 'info', urls.join(', '), `Même description sur ${urls.length} pages.`, 'Une description propre à chaque page est plus utile.');

  // Cohérence du téléphone (site ↔ données structurées)
  if (telsJsonLd.size && telsSite.size) {
    const absents = [...telsJsonLd].filter((t) => !telsSite.has(t));
    if (absents.length) ajouter('telephone-incoherent', 'probleme', null, `Le téléphone des données structurées (${absents.map(formater).join(', ')}) n’apparaît pas sur les pages du site (${[...telsSite].map(formater).join(', ')}).`, 'Google peut afficher un mauvais numéro : mettez le même partout.');
    else verifie.push(`téléphone identique sur le site et dans les données structurées (${[...telsJsonLd].map(formater).join(', ')})`);
  }
  if (indexables && !constats.some((c) => c.regle.startsWith('titre-'))) verifie.push('chaque page a un titre');
  if (indexables && !constats.some((c) => c.regle === 'lien-casse')) verifie.push('aucun lien interne cassé');
  if (indexables && !constats.some((c) => c.regle === 'viewport')) verifie.push('pages adaptées au téléphone (viewport)');

  const ordre: Record<Niveau, number> = { probleme: 0, attention: 1, info: 2 };
  constats.sort((a, b) => ordre[a.niveau] - ordre[b.niveau] || (a.page ?? '').localeCompare(b.page ?? ''));
  return { pages: pages.length, pagesIndexables: indexables, constats, verifie };
}

const formater = (t: string) => t.replace(/(\d{2})(?=\d)/g, '$1 ');

const TYPES_LOCAUX = /^(LocalBusiness|NailSalon|BeautySalon|HairSalon|HealthAndBeautyBusiness|DaySpa|Store|Restaurant|ProfessionalService)$/;

/** Contrôles des données structurées : types courants, champs utiles au référencement local et à la FAQ. */
function verifierJsonLd(d: unknown, url: string, ajouter: (r: string, n: Niveau, p: string | null, m: string, c: string) => void, verifie: string[], tels: Set<string>) {
  const noeuds: Record<string, unknown>[] = [];
  const parcourir = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(parcourir);
    else if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      if (o['@graph']) parcourir(o['@graph']);
      if (o['@type']) noeuds.push(o);
    }
  };
  parcourir(d);
  const ctx = JSON.stringify(d);
  if (!/schema\.org/.test(ctx)) ajouter('jsonld-contexte', 'attention', url, 'Données structurées sans « @context » schema.org.', 'Ajoutez "@context": "https://schema.org".');
  for (const n of noeuds) {
    const types = ([] as unknown[]).concat(n['@type']).map(String);
    if (types.some((t) => TYPES_LOCAUX.test(t))) {
      const manque = ['name', 'address', 'telephone'].filter((k) => !n[k]);
      if (manque.length) ajouter('jsonld-local-incomplet', 'attention', url, `Fiche d’entreprise (${types.join(', ')}) incomplète : manque ${manque.join(', ')}.`, 'Nom, adresse et téléphone aident Google à relier le site à l’établissement.');
      else verifie.push(`fiche d’entreprise structurée (${types.join(', ')}) avec nom, adresse et téléphone`);
      if (n.telephone) telephones(String(n.telephone)).forEach((t) => tels.add(t));
      if (!n.openingHoursSpecification && !n.openingHours) ajouter('jsonld-horaires', 'info', url, 'Les horaires ne figurent pas dans les données structurées.', 'Ajoutez openingHoursSpecification (jours et heures).');
    }
    if (types.includes('FAQPage')) {
      const q = ([] as unknown[]).concat(n.mainEntity ?? []) as Record<string, unknown>[];
      const mauvaises = q.filter((x) => !x?.name || !(x?.acceptedAnswer as Record<string, unknown> | undefined)?.text);
      if (!q.length || mauvaises.length) ajouter('jsonld-faq', 'attention', url, `FAQ structurée incomplète (${mauvaises.length || 'aucune'} question(s) sans texte de question ou de réponse).`, 'Chaque Question a besoin de « name » et de « acceptedAnswer.text ».');
      else verifie.push(`FAQ structurée valide (${q.length} questions)`);
    }
  }
}
