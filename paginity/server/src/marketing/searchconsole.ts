import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../context.js';
import type { SiteRow } from '../sites/service.js';
import { getSetting, setSetting } from '../db.js';
import { raiseAlert } from '../lib/alerts.js';
import { audit } from '../lib/audit.js';
import { now, UserError } from '../lib/util.js';
import { ClientGoogle, lireCle, type CleCompte } from './google.js';
import { fichierPour } from './audit.js';

/**
 * M2 — Google Search Console, en lecture seule.
 * Le propriétaire de la plateforme enregistre UNE clé de compte de service (chiffrée dans le coffre), puis relie chaque
 * site à sa propriété Search Console. PAGINITY relève chaque jour les recherches, apparitions, clics et position
 * moyenne, et rédige un rapport en français simple. Les données de Google ont environ 3 jours de retard.
 * Rien n'est jamais écrit chez Google.
 */
const JOURS = 28;
const RETARD = 3;
/** En dessous, les chiffres sont trop faibles pour conclure (affiché comme tel). */
export const SEUIL_IMPRESSIONS = 100;
const jourISO = (t: number) => new Date(t).toISOString().slice(0, 10);
const moinsJours = (iso: string, n: number) => jourISO(Date.parse(`${iso}T12:00:00Z`) - n * 86_400_000);

interface Totaux {
  clics: number;
  impressions: number;
  ctr: number;
  position: number | null;
}
interface Ligne extends Totaux {
  cle: string;
}
export interface Rapport {
  le: number;
  propriete: string;
  debut: string;
  fin: string;
  total: Totaux;
  precedent: Totaux;
  requetes: Ligne[];
  pages: Ligne[];
}

const totaux = (r?: { clicks: number; impressions: number; ctr: number; position: number }): Totaux =>
  r ? { clics: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.impressions ? r.position : null } : { clics: 0, impressions: 0, ctr: 0, position: null };
const pct = (x: number) => `${(x * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`;
const nb = (x: number) => x.toLocaleString('fr-FR');
const pos = (x: number | null) => (x === null ? '—' : x.toLocaleString('fr-FR', { maximumFractionDigits: 1 }));
const dateFr = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });

/** Rapport rédigé, sans exagération : seuils, position « moyenne », pistes présentées comme des pistes. */
export function rediger(r: Rapport): { phrases: string[]; pistes: string[]; significatif: boolean } {
  const t = r.total;
  const p = r.precedent;
  const significatif = t.impressions >= SEUIL_IMPRESSIONS;
  const phrases = [
    `Du ${dateFr(r.debut)} au ${dateFr(r.fin)}, le site est apparu ${nb(t.impressions)} fois dans les résultats de Google et a reçu ${nb(t.clics)} clic(s) (taux de clic ${pct(t.ctr)}).`,
  ];
  if (t.position !== null) phrases.push(`Position moyenne : ${pos(t.position)}. C’est une moyenne sur toutes les apparitions (elle varie selon la personne, le lieu et la recherche), pas un classement fixe.`);
  if (!significatif) phrases.push(`Avec moins de ${SEUIL_IMPRESSIONS} apparitions, ces chiffres sont trop faibles pour tirer des conclusions : à lire comme une indication.`);
  else if (p.impressions >= SEUIL_IMPRESSIONS) {
    const ev = (a: number, b: number) => (b ? `${a >= b ? '+' : ''}${Math.round(((a - b) / b) * 100)} %` : 'nouveau');
    phrases.push(`Par rapport aux 28 jours précédents : apparitions ${ev(t.impressions, p.impressions)}, clics ${ev(t.clics, p.clics)}. Une variation peut venir de la saison, des vacances ou de Google lui-même.`);
  } else phrases.push('La période précédente a trop peu de données pour une comparaison fiable.');
  if (r.requetes[0]) phrases.push(`Recherche la plus fréquente : « ${r.requetes[0].cle} » (${nb(r.requetes[0].impressions)} apparition(s)).`);
  // Pistes : recherches souvent vues, assez bien placées, mais peu cliquées.
  const pistes = r.requetes
    .filter((q) => q.impressions >= 20 && q.ctr < 0.02 && q.position !== null && q.position <= 15)
    .slice(0, 3)
    .map((q) => `« ${q.cle} » : vu ${nb(q.impressions)} fois (position moyenne ${pos(q.position)}) mais rarement cliqué. Piste : vérifier que le titre et la description de la page correspondante répondent à cette recherche.`);
  return { phrases, pistes, significatif };
}

export class SearchConsole {
  private client: ClientGoogle | null = null;
  private enCours = new Set<string>();
  constructor(private ctx: Ctx) {}

  // ------------------------------------------------------------------ compte
  private cle(): CleCompte | null {
    const v = getSetting(this.ctx.db, 'gsc_cle');
    return v ? (JSON.parse(this.ctx.vault.decrypt(v)) as CleCompte) : null;
  }
  private google(): ClientGoogle {
    const c = this.cle();
    if (!c) throw new UserError(409, 'Search Console n’est pas connecté : le propriétaire peut le faire dans les Réglages de la plateforme.');
    return (this.client ??= new ClientGoogle(c));
  }
  compte() {
    const c = this.cle();
    let info: { connecteLe?: number } = {};
    try {
      info = JSON.parse(getSetting(this.ctx.db, 'gsc_compte') ?? '{}');
    } catch {
      /* rien */
    }
    return { connecte: !!c, email: c?.client_email ?? null, connecteLe: info.connecteLe ?? null, sitesLies: this.ctx.db.prepare('SELECT COUNT(*) AS n FROM seo_gsc_liens').get() as { n: number } };
  }
  /** Enregistre la clé seulement si Google l'accepte ; renvoie les propriétés visibles. */
  async connecter(texte: unknown, userId: string) {
    const c = lireCle(texte);
    const essai = new ClientGoogle(c);
    const proprietes = await essai.proprietes();
    setSetting(this.ctx.db, 'gsc_cle', this.ctx.vault.encrypt(JSON.stringify(c)));
    setSetting(this.ctx.db, 'gsc_compte', JSON.stringify({ connecteLe: now() }));
    this.client = essai;
    audit(this.ctx.db, { userId, action: 'gsc_connexion', details: { compte: c.client_email, proprietes: proprietes.length } });
    return { ...this.compte(), proprietes };
  }
  /** Efface la clé, les liaisons et les données relevées. */
  deconnecter(userId: string) {
    const email = this.cle()?.client_email;
    for (const t of ['seo_gsc_liens', 'seo_gsc_jours', 'seo_gsc_releves']) this.ctx.db.prepare(`DELETE FROM ${t}`).run();
    this.ctx.db.prepare("DELETE FROM settings WHERE key IN ('gsc_cle', 'gsc_compte')").run();
    this.client = null;
    audit(this.ctx.db, { userId, action: 'gsc_deconnexion', details: { compte: email } });
    return this.compte();
  }
  async proprietes() {
    return this.google().proprietes();
  }

  // ------------------------------------------------------------------ liaison site ↔ propriété
  lien(site: SiteRow): string | null {
    return (this.ctx.db.prepare('SELECT propriete FROM seo_gsc_liens WHERE site_id = ?').get(site.id) as { propriete: string } | undefined)?.propriete ?? null;
  }
  async lier(site: SiteRow, propriete: unknown, userId: string) {
    const p = String(propriete ?? '');
    const liste = await this.google().proprietes();
    if (!liste.some((x) => x.siteUrl === p)) throw new UserError(400, 'Cette propriété n’est pas accessible au compte de service.');
    this.ctx.db.prepare('INSERT INTO seo_gsc_liens (site_id, propriete, lie_le, par) VALUES (?, ?, ?, ?) ON CONFLICT(site_id) DO UPDATE SET propriete = excluded.propriete, lie_le = excluded.lie_le, par = excluded.par').run(site.id, p, now(), userId);
    // Changement de propriété : les anciennes données ne correspondent plus.
    this.ctx.db.prepare('DELETE FROM seo_gsc_jours WHERE site_id = ?').run(site.id);
    this.ctx.db.prepare('DELETE FROM seo_gsc_releves WHERE site_id = ?').run(site.id);
    audit(this.ctx.db, { userId, action: 'gsc_liaison', siteId: site.id, details: { propriete: p } });
  }
  delier(site: SiteRow, userId: string) {
    for (const t of ['seo_gsc_liens', 'seo_gsc_jours', 'seo_gsc_releves']) this.ctx.db.prepare(`DELETE FROM ${t} WHERE site_id = ?`).run(site.id);
    audit(this.ctx.db, { userId, action: 'gsc_deliaison', siteId: site.id });
  }

  // ------------------------------------------------------------------ relevés
  async collecter(site: SiteRow, maintenant = Date.now()): Promise<Rapport> {
    const propriete = this.lien(site);
    if (!propriete) throw new UserError(409, 'Ce site n’est relié à aucune propriété Search Console.');
    if (this.enCours.has(site.id)) throw new UserError(409, 'Relevé déjà en cours.');
    this.enCours.add(site.id);
    try {
      const g = this.google();
      const fin = jourISO(maintenant - RETARD * 86_400_000);
      const debut = moinsJours(fin, JOURS - 1);
      const finAvant = moinsJours(debut, 1);
      const debutAvant = moinsJours(finAvant, JOURS - 1);
      const base = { type: 'web', dataState: 'final' };
      const [jours, [tot], [totAvant], requetes, pages] = await Promise.all([
        g.analyse(propriete, { ...base, startDate: debutAvant, endDate: fin, dimensions: ['date'], rowLimit: 100 }),
        g.analyse(propriete, { ...base, startDate: debut, endDate: fin }),
        g.analyse(propriete, { ...base, startDate: debutAvant, endDate: finAvant }),
        g.analyse(propriete, { ...base, startDate: debut, endDate: fin, dimensions: ['query'], rowLimit: 25 }),
        g.analyse(propriete, { ...base, startDate: debut, endDate: fin, dimensions: ['page'], rowLimit: 25 }),
      ]);
      const ins = this.ctx.db.prepare('INSERT INTO seo_gsc_jours (site_id, jour, clics, impressions, position) VALUES (?, ?, ?, ?, ?) ON CONFLICT(site_id, jour) DO UPDATE SET clics = excluded.clics, impressions = excluded.impressions, position = excluded.position');
      for (const j of jours) if (j.keys?.[0]) ins.run(site.id, j.keys[0], j.clicks, j.impressions, j.impressions ? j.position : null);
      const ligne = (x: { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }): Ligne => ({ cle: String(x.keys?.[0] ?? '').slice(0, 300), ...totaux(x) });
      const rapport: Rapport = { le: now(), propriete, debut, fin, total: totaux(tot), precedent: totaux(totAvant), requetes: requetes.map(ligne), pages: pages.map(ligne) };
      this.ctx.db.prepare("INSERT INTO seo_gsc_releves (site_id, type, le, donnees) VALUES (?, 'rapport', ?, ?)").run(site.id, rapport.le, JSON.stringify(rapport));
      this.ctx.db.prepare("DELETE FROM seo_gsc_releves WHERE site_id = ? AND type = 'rapport' AND le NOT IN (SELECT le FROM seo_gsc_releves WHERE site_id = ? AND type = 'rapport' ORDER BY le DESC LIMIT 12)").run(site.id, site.id);
      this.ctx.db.prepare("DELETE FROM seo_gsc_jours WHERE site_id = ? AND jour < ?").run(site.id, moinsJours(fin, 480));
      return rapport;
    } finally {
      this.enCours.delete(site.id);
    }
  }

  /** État de l'indexation des pages annoncées dans le sitemap du site en ligne (20 au plus). */
  async inspecter(site: SiteRow) {
    const propriete = this.lien(site);
    if (!propriete) throw new UserError(409, 'Ce site n’est relié à aucune propriété Search Console.');
    const adresses = this.adressesSitemap(site, propriete).slice(0, 20);
    const g = this.google();
    const resultats = [];
    for (const adresse of adresses) {
      try {
        const r = await g.inspecter(propriete, adresse);
        resultats.push({
          adresse,
          verdict: String(r.verdict ?? 'VERDICT_UNSPECIFIED'),
          couverture: String(r.coverageState ?? ''),
          dernierPassage: r.lastCrawlTime ? String(r.lastCrawlTime) : null,
          canonicalGoogle: r.googleCanonical ? String(r.googleCanonical) : null,
          canonicalDeclaree: r.userCanonical ? String(r.userCanonical) : null,
          robots: String(r.robotsTxtState ?? ''),
          erreur: null as string | null,
        });
      } catch (e) {
        resultats.push({ adresse, verdict: 'ERREUR', couverture: '', dernierPassage: null, canonicalGoogle: null, canonicalDeclaree: null, robots: '', erreur: (e as Error).message });
        if (e instanceof UserError && e.status === 429) break;
      }
    }
    const donnees = { le: now(), resultats };
    this.ctx.db.prepare("DELETE FROM seo_gsc_releves WHERE site_id = ? AND type = 'inspection'").run(site.id);
    this.ctx.db.prepare("INSERT INTO seo_gsc_releves (site_id, type, le, donnees) VALUES (?, 'inspection', ?, ?)").run(site.id, donnees.le, JSON.stringify(donnees));
    return donnees;
  }

  /** Adresses du sitemap du site en ligne ; à défaut, la page d'accueil de la propriété. */
  private adressesSitemap(site: SiteRow, propriete: string): string[] {
    const accueil = propriete.startsWith('sc-domain:') ? `https://${propriete.slice('sc-domain:'.length)}/` : propriete;
    try {
      const racine = fs.realpathSync(this.ctx.sites.liveLink(site));
      const f = fichierPour(racine, '/sitemap.xml');
      if (f) {
        const locs = [...fs.readFileSync(path.join(racine, f), 'utf8').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
        if (locs.length) return locs;
      }
    } catch {
      /* pas publié */
    }
    return [accueil];
  }

  lire(site: SiteRow) {
    const releve = (type: string) => {
      const r = this.ctx.db.prepare('SELECT donnees FROM seo_gsc_releves WHERE site_id = ? AND type = ? ORDER BY le DESC LIMIT 1').get(site.id, type) as { donnees: string } | undefined;
      return r ? JSON.parse(r.donnees) : null;
    };
    const rapport = releve('rapport') as Rapport | null;
    return {
      compte: this.compte(),
      propriete: this.lien(site),
      rapport: rapport && { ...rapport, redaction: rediger(rapport) },
      jours: rapport
        ? (this.ctx.db.prepare('SELECT jour, clics, impressions, position FROM seo_gsc_jours WHERE site_id = ? AND jour >= ? ORDER BY jour').all(site.id, rapport.debut) as { jour: string; clics: number; impressions: number; position: number | null }[])
        : [],
      inspection: releve('inspection'),
      indexnow: this.indexNowReglage(site),
    };
  }

  /** Relevé quotidien des sites reliés (une fois par jour au plus). */
  async tic(): Promise<void> {
    if (!this.cle()) return;
    for (const l of this.ctx.db.prepare('SELECT site_id FROM seo_gsc_liens').all() as { site_id: string }[]) {
      const site = this.ctx.sites.get(l.site_id);
      if (!site) continue;
      const dernier = this.ctx.db.prepare("SELECT MAX(le) AS le FROM seo_gsc_releves WHERE site_id = ? AND type = 'rapport'").get(site.id) as { le: number | null };
      if (dernier.le && now() - dernier.le < 20 * 3_600_000) continue;
      try {
        await this.collecter(site);
        this.ctx.db.prepare('DELETE FROM settings WHERE key = ?').run(`gsc_alerte:${site.id}`);
      } catch (e) {
        // Une alerte au premier échec, puis au plus une par semaine tant que le problème dure.
        const derniere = Number(getSetting(this.ctx.db, `gsc_alerte:${site.id}`) ?? 0);
        if (now() - derniere > 7 * 86_400_000) {
          raiseAlert(this.ctx, 'attention', `Search Console (« ${site.name} ») : relevé impossible — ${(e as Error).message}`, site.id);
          setSetting(this.ctx.db, `gsc_alerte:${site.id}`, String(now()));
        }
      }
    }
  }

  // ------------------------------------------------------------------ IndexNow (Bing, Yandex… ; PAS Google)
  indexNowReglage(site: SiteRow): { actif: boolean; cle: string | null; dernier: null | { le: number; ok: boolean; message: string; adresses: number } } {
    try {
      return { actif: false, cle: null, dernier: null, ...JSON.parse(getSetting(this.ctx.db, `indexnow:${site.id}`) ?? '{}') };
    } catch {
      return { actif: false, cle: null, dernier: null };
    }
  }
  reglerIndexNow(site: SiteRow, actif: unknown) {
    const r = this.indexNowReglage(site);
    r.actif = actif === true;
    if (r.actif && !r.cle) r.cle = crypto.randomBytes(16).toString('hex');
    setSetting(this.ctx.db, `indexnow:${site.id}`, JSON.stringify(r));
    return r;
  }
  /** Fichier de clé IndexNow servi à la racine du site (sans rien écrire dans le site). */
  cleIndexNow(site: SiteRow, chemin: string): string | null {
    const r = this.indexNowReglage(site);
    return r.actif && r.cle && chemin === `/${r.cle}.txt` ? r.cle : null;
  }
  /** Après une publication réussie : signale les pages du sitemap aux moteurs IndexNow. */
  async apresPublication(site: SiteRow): Promise<void> {
    const r = this.indexNowReglage(site);
    const domaine = this.ctx.sites.domains(site)[0];
    if (!r.actif || !r.cle || !domaine) return;
    const adresses = this.adressesSitemap(site, `https://${domaine}/`)
      .filter((a) => {
        try {
          return new URL(a).hostname === domaine;
        } catch {
          return false;
        }
      })
      .slice(0, 1000);
    let dernier: { le: number; ok: boolean; message: string; adresses: number };
    try {
      const rep = await fetch(process.env.PAGINITY_INDEXNOW_URL ?? 'https://api.indexnow.org/indexnow', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ host: domaine, key: r.cle, keyLocation: `https://${domaine}/${r.cle}.txt`, urlList: adresses }),
        signal: AbortSignal.timeout(15_000),
      });
      dernier = { le: now(), ok: rep.ok, message: rep.ok ? 'reçu' : `refusé (code ${rep.status})`, adresses: adresses.length };
    } catch {
      dernier = { le: now(), ok: false, message: 'service injoignable', adresses: adresses.length };
    }
    setSetting(this.ctx.db, `indexnow:${site.id}`, JSON.stringify({ ...r, dernier }));
  }
}
