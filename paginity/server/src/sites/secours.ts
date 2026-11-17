import type { Ctx } from '../context.js';
import type { SiteRow } from './service.js';
import { getSetting, setSetting } from '../db.js';
import { UserError } from '../lib/util.js';
import { loadSchema, readEntry } from '../content/service.js';
import { isServerCode } from './server-code.js';

/**
 * Page de secours : une seule page HTML, autonome (aucun fichier, police ni script extérieur), avec l'essentiel pour
 * que les clientes puissent joindre l'entreprise quand le serveur de la maison est arrêté : nom, message, téléphone
 * (lien d'appel), lien de prise de contact (WhatsApp, Planity…), e-mail, adresse, horaires.
 * Elle est déposée une fois pour toutes chez un hébergeur gratuit (voir le manuel) et n'a besoin de rien d'autre.
 */
export interface FicheSecours {
  nom: string;
  message: string;
  telephone: string;
  lien: string;
  lienLibelle: string;
  email: string;
  adresse: string;
  horaires: string;
  couleur: string;
}
const CHAMPS: (keyof FicheSecours)[] = ['nom', 'message', 'telephone', 'lien', 'lienLibelle', 'email', 'adresse', 'horaires', 'couleur'];
const MAX: Record<keyof FicheSecours, number> = { nom: 80, message: 400, telephone: 30, lien: 300, lienLibelle: 60, email: 120, adresse: 200, horaires: 600, couleur: 7 };

const echapper = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Cherche dans les contenus du site un téléphone, un e-mail, une adresse (pour pré-remplir la fiche). */
function trouver(ctx: Ctx, site: SiteRow): Partial<FicheSecours> {
  const out: Partial<FicheSecours> = {};
  const visiter = (v: unknown, cle = '') => {
    if (typeof v === 'string') {
      const k = cle.toLowerCase();
      if (!out.telephone && /(^|\D)0[1-9](?:[ .]?\d{2}){4}(\D|$)/.test(v) && (k.includes('tel') || k.includes('phone') || v.replace(/\D/g, '').length === 10)) out.telephone = v.match(/0[1-9](?:[ .]?\d{2}){4}/)![0];
      if (!out.email && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v.trim())) out.email = v.trim();
      if (!out.adresse && k.includes('adresse') && v.length < 200 && !v.includes('@')) out.adresse = v;
      return;
    }
    if (Array.isArray(v)) v.forEach((x) => visiter(x, cle));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visiter(x, k);
  };
  try {
    for (const e of loadSchema(ctx, site).entries) {
      if (e.type !== 'file' || isServerCode(ctx, site, e.path)) continue;
      try {
        visiter(readEntry(ctx, site, e.name).valeur);
      } catch {
        /* rubrique illisible */
      }
    }
  } catch {
    /* pas de schéma */
  }
  return out;
}

export function lireFiche(ctx: Ctx, site: SiteRow): { fiche: FicheSecours; enregistree: boolean } {
  const brut = getSetting(ctx.db, `secours:${site.id}`);
  if (brut) return { fiche: JSON.parse(brut), enregistree: true };
  const t = trouver(ctx, site);
  return {
    fiche: {
      nom: site.name,
      message: 'Notre site est momentanément indisponible. Vous pouvez nous joindre directement :',
      telephone: t.telephone ?? '',
      lien: '',
      lienLibelle: 'Nous écrire sur WhatsApp',
      email: t.email ?? '',
      adresse: t.adresse ?? '',
      horaires: '',
      couleur: '#c9a227',
    },
    enregistree: false,
  };
}

export function enregistrerFiche(ctx: Ctx, site: SiteRow, input: Record<string, unknown>): FicheSecours {
  const f = {} as FicheSecours;
  for (const c of CHAMPS) {
    const v = String(input[c] ?? '').trim();
    if (v.length > MAX[c]) throw new UserError(400, `« ${c} » est trop long (${MAX[c]} caractères au plus).`);
    f[c] = v;
  }
  if (!f.nom) throw new UserError(400, 'Le nom est obligatoire.');
  if (!f.telephone && !f.email && !f.lien) throw new UserError(400, 'Indiquez au moins un moyen de contact (téléphone, e-mail ou lien).');
  if (f.telephone && !/^\+?[\d .()-]{6,30}$/.test(f.telephone)) throw new UserError(400, 'Téléphone invalide.');
  if (f.email && !/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(f.email)) throw new UserError(400, 'E-mail invalide.');
  if (f.lien && !/^https:\/\/[^\s<>"]+$/.test(f.lien)) throw new UserError(400, 'Le lien doit commencer par https://');
  if (f.couleur && !/^#[0-9a-f]{6}$/i.test(f.couleur)) throw new UserError(400, 'Couleur au format #c9a227.');
  setSetting(ctx.db, `secours:${site.id}`, JSON.stringify(f));
  return f;
}

/** La page elle-même : autonome, lisible sur téléphone, sans rien d'extérieur. */
export function pageSecours(f: FicheSecours): string {
  const tel = f.telephone.replace(/[^\d+]/g, '').replace(/^0/, '+33');
  const c = /^#[0-9a-f]{6}$/i.test(f.couleur) ? f.couleur : '#c9a227';
  const ligne = (html: string) => `<p>${html}</p>`;
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${echapper(f.nom)}</title>
<meta name="description" content="${echapper(`${f.nom} — ${f.telephone || f.email}`)}">
<style>
:root{--c:${c};color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#faf7f2;color:#222;line-height:1.5;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
@media (prefers-color-scheme:dark){body{background:#16161a;color:#eee}.carte{background:#1f1f25!important}}
.carte{background:#fff;max-width:480px;width:100%;border-radius:18px;padding:28px 24px;box-shadow:0 6px 30px rgba(0,0,0,.08);text-align:center;border-top:6px solid var(--c)}
h1{margin:0 0 8px;font-size:1.7rem}
.message{opacity:.85}
.bouton{display:block;margin:12px 0;padding:14px 18px;border-radius:999px;background:var(--c);color:#fff;font-weight:700;text-decoration:none;font-size:1.1rem}
.bouton.second{background:transparent;color:inherit;border:2px solid var(--c)}
.infos{margin-top:18px;font-size:.95rem;white-space:pre-line}
.infos p{margin:6px 0}
small{display:block;margin-top:18px;opacity:.6}
</style>
</head>
<body>
<main class="carte">
<h1>${echapper(f.nom)}</h1>
${f.message ? `<p class="message">${echapper(f.message)}</p>` : ''}
${f.telephone ? `<a class="bouton" href="tel:${echapper(tel)}">Appeler le ${echapper(f.telephone)}</a>` : ''}
${f.lien ? `<a class="bouton second" href="${echapper(f.lien)}" rel="noopener">${echapper(f.lienLibelle || 'Nous contacter')}</a>` : ''}
${f.email ? `<a class="bouton second" href="mailto:${echapper(f.email)}">${echapper(f.email)}</a>` : ''}
<div class="infos">
${f.adresse ? ligne(echapper(f.adresse)) : ''}
${f.horaires ? ligne(echapper(f.horaires)) : ''}
</div>
<small>Le site complet revient très vite. Merci de votre patience.</small>
</main>
</body>
</html>
`;
}
