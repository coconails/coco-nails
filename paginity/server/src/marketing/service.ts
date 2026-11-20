import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../context.js';
import type { SiteRow } from '../sites/service.js';
import { getSetting, setSetting } from '../db.js';
import { raiseAlert } from '../lib/alerts.js';
import { audit } from '../lib/audit.js';
import { now, randomId, UserError } from '../lib/util.js';
import { buildPreview } from '../publish/pipeline.js';
import { auditer, type Constat, type ResultatAudit } from './audit.js';
import { controlerEnLigne } from './en-ligne.js';
import { regleCorrigeable } from './corrections.js';
import { moisCouvert, rapportMensuel, texteRapport, titreRapport, type RapportMensuel } from './rapport.js';
import { heureLocale, jourLocal } from '../lib/fuseau.js';

/**
 * Référencement (M1) : lance l'audit local, garde l'historique (30 derniers par site), compare avec le précédent,
 * et, si vous l'activez, refait l'audit chaque semaine avec une alerte quand de NOUVEAUX problèmes apparaissent.
 * Lecture seule : rien n'est jamais modifié sur le site.
 */
/** brouillon et en-ligne : audit des fichiers ; controle : contrôle du site en ligne par le réseau (à la demande). */
export type Cible = 'brouillon' | 'en-ligne' | 'controle';
const GARDER = 30;
const SEMAINE = 7 * 86_400_000;
const cle = (c: Constat) => `${c.regle}|${c.page ?? ''}|${c.message}`;

interface Ligne {
  id: string;
  site_id: string;
  le: number;
  cible: Cible;
  par: string | null;
  resultat: string;
}

export class Referencement {
  private enCours = new Set<string>();
  /** Pause entre deux requêtes du contrôle en ligne (raccourcie pour les tests). */
  pauseControle?: number;
  constructor(private ctx: Ctx) {}

  reglages(site: SiteRow): { hebdo: boolean; mensuel: boolean } {
    try {
      return { hebdo: false, mensuel: false, ...JSON.parse(getSetting(this.ctx.db, `seo:${site.id}`) ?? '{}') };
    } catch {
      return { hebdo: false, mensuel: false };
    }
  }
  regler(site: SiteRow, input: { hebdo?: unknown; mensuel?: unknown }) {
    const avant = this.reglages(site);
    const r = { ...avant, hebdo: input.hebdo === undefined ? avant.hebdo : input.hebdo === true, mensuel: input.mensuel === undefined ? avant.mensuel : input.mensuel === true };
    setSetting(this.ctx.db, `seo:${site.id}`, JSON.stringify(r));
    return r;
  }

  /** Dossier à auditer : le brouillon fabriqué pour l'occasion (sans toucher à l'aperçu), ou la version en ligne. */
  private async racine(site: SiteRow, cible: Cible): Promise<string> {
    if (cible === 'en-ligne' || cible === 'controle') {
      try {
        return fs.realpathSync(this.ctx.sites.liveLink(site));
      } catch {
        throw new UserError(409, 'Ce site n’est pas encore publié : auditez plutôt le brouillon.');
      }
    }
    const sortie = path.join(this.ctx.sites.dir(site), 'apercu-referencement');
    await buildPreview(this.ctx, site, { sortie });
    return sortie;
  }

  async lancer(site: SiteRow, cible: Cible, userId: string | null) {
    if (cible !== 'brouillon' && cible !== 'en-ligne' && cible !== 'controle') throw new UserError(400, 'Cible inconnue.');
    if (this.enCours.has(site.id)) throw new UserError(409, 'Un audit est déjà en cours pour ce site.');
    this.enCours.add(site.id);
    try {
      const racine = await this.racine(site, cible);
      const r = cible === 'controle' ? await controlerEnLigne(this.ctx, site, racine, { pause: this.pauseControle }) : auditer(racine, this.ctx.sites.domains(site));
      const precedent = this.dernier(site, cible);
      const id = randomId('seo');
      this.ctx.db.prepare('INSERT INTO seo_audits (id, site_id, le, cible, par, resultat) VALUES (?, ?, ?, ?, ?, ?)').run(id, site.id, now(), cible, userId, JSON.stringify(r));
      const vieux = this.ctx.db.prepare('SELECT id FROM seo_audits WHERE site_id = ? ORDER BY le DESC LIMIT -1 OFFSET ?').all(site.id, GARDER) as { id: string }[];
      for (const v of vieux) this.ctx.db.prepare('DELETE FROM seo_audits WHERE id = ?').run(v.id);
      audit(this.ctx.db, { userId, action: 'seo_audit', siteId: site.id, details: { cible, problemes: r.constats.filter((c) => c.niveau === 'probleme').length } });
      // Audit automatique : alerte seulement pour les NOUVEAUX problèmes (pas de rappel à chaque semaine).
      if (!userId && precedent) {
        const avant = new Set(precedent.resultat.constats.map(cle));
        const nouveaux = r.constats.filter((c) => c.niveau === 'probleme' && !avant.has(cle(c)));
        if (nouveaux.length) raiseAlert(this.ctx, 'attention', `Référencement de « ${site.name} » : ${nouveaux.length} nouveau(x) problème(s), dont « ${nouveaux[0].message} »`, site.id);
      }
      return this.lire(site);
    } finally {
      this.enCours.delete(site.id);
    }
  }

  /** Constat du dernier audit du brouillon (pour une correction assistée) ; null s'il n'y figure pas. */
  constatDuBrouillon(site: SiteRow, c: { regle?: unknown; page?: unknown; message?: unknown }): Constat | null {
    const d = this.dernier(site, 'brouillon');
    return d?.resultat.constats.find((x) => x.regle === c.regle && (x.page ?? null) === (c.page ?? null) && x.message === c.message) ?? null;
  }

  /** Après une correction acceptée : nouvel audit du brouillon ; le constat (même règle, même page) a-t-il disparu ? */
  async verifierCorrection(site: SiteRow, seo: { regle: string; page: string | null }, userId: string): Promise<{ corrige: boolean; message: string }> {
    const r = await this.lancer(site, 'brouillon', userId);
    const reste = r.brouillon?.constats.some((x) => x.regle === seo.regle && (x.page ?? null) === seo.page);
    return reste
      ? { corrige: false, message: 'Nouvel audit du brouillon : le constat est toujours présent. Regardez l’audit pour en savoir plus.' }
      : { corrige: true, message: 'Nouvel audit du brouillon : le constat a disparu. Vérifiez l’aperçu, puis publiez quand vous voulez.' };
  }

  private dernier(site: SiteRow, cible: Cible): { id: string; le: number; resultat: ResultatAudit } | null {
    const l = this.ctx.db.prepare('SELECT * FROM seo_audits WHERE site_id = ? AND cible = ? ORDER BY le DESC LIMIT 1').get(site.id, cible) as Ligne | undefined;
    return l ? { id: l.id, le: l.le, resultat: JSON.parse(l.resultat) } : null;
  }

  lire(site: SiteRow) {
    const lignes = this.ctx.db.prepare('SELECT * FROM seo_audits WHERE site_id = ? ORDER BY le DESC').all(site.id) as unknown as Ligne[];
    const parCible = (cible: Cible) => {
      const [actuel, precedent] = lignes.filter((l) => l.cible === cible);
      if (!actuel) return null;
      const r = JSON.parse(actuel.resultat) as ResultatAudit;
      const avant = precedent ? new Set((JSON.parse(precedent.resultat) as ResultatAudit).constats.map(cle)) : null;
      const maintenant = new Set(r.constats.map(cle));
      return {
        id: actuel.id,
        le: actuel.le,
        automatique: !actuel.par,
        ...r,
        constats: r.constats.map((c) => ({ ...c, nouveau: avant ? !avant.has(cle(c)) : false, corrigeable: cible === 'brouillon' && regleCorrigeable(c.regle) })),
        corriges: precedent ? (JSON.parse(precedent.resultat) as ResultatAudit).constats.filter((c) => !maintenant.has(cle(c))) : [],
        comparaison: precedent ? precedent.le : null,
      };
    };
    return {
      reglages: this.reglages(site),
      enCours: this.enCours.has(site.id),
      publie: site.live_publication !== null,
      brouillon: parCible('brouillon'),
      enLigne: parCible('en-ligne'),
      controle: parCible('controle'),
      historique: lignes.map((l) => {
        const r = JSON.parse(l.resultat) as ResultatAudit;
        const n = (x: string) => r.constats.filter((c) => c.niveau === x).length;
        return { id: l.id, le: l.le, cible: l.cible, automatique: !l.par, problemes: n('probleme'), attention: n('attention'), info: n('info') };
      }),
    };
  }

  // ------------------------------------------------------------------ rapport mensuel
  /** Aperçu du rapport du mois (rien n'est envoyé). */
  rapport(site: SiteRow): RapportMensuel {
    return rapportMensuel(this.ctx, site);
  }
  /** Rapports déjà envoyés (12 derniers). */
  rapportsEnvoyes(site: SiteRow): RapportMensuel[] {
    return (this.ctx.db.prepare("SELECT donnees FROM seo_gsc_releves WHERE site_id = ? AND type = 'rapport-mensuel' ORDER BY le DESC LIMIT 12").all(site.id) as { donnees: string }[]).map((r) => JSON.parse(r.donnees));
  }
  /**
   * Envoi du rapport du mois écoulé (sites qui l'ont demandé), le 1er du mois à partir de 8 h (heure de Paris) :
   * gardé dans PAGINITY, signalé sur le tableau de bord, envoyé par e-mail si l'envoi est configuré.
   */
  async envoyerRapports(maintenant = Date.now()): Promise<number> {
    const jour = jourLocal(maintenant);
    if (Number(jour.slice(8, 10)) !== 1 || heureLocale(maintenant) < 8) return 0;
    const mois = moisCouvert(jour);
    let n = 0;
    for (const site of this.ctx.db.prepare('SELECT * FROM sites').all() as unknown as SiteRow[]) {
      if (!this.reglages(site).mensuel || getSetting(this.ctx.db, `seo-rapport:${site.id}`) === mois) continue;
      setSetting(this.ctx.db, `seo-rapport:${site.id}`, mois);
      const r = rapportMensuel(this.ctx, site, mois);
      this.ctx.db.prepare("INSERT INTO seo_gsc_releves (site_id, type, le, donnees) VALUES (?, 'rapport-mensuel', ?, ?)").run(site.id, r.le, JSON.stringify(r));
      this.ctx.db.prepare("DELETE FROM seo_gsc_releves WHERE site_id = ? AND type = 'rapport-mensuel' AND le NOT IN (SELECT le FROM seo_gsc_releves WHERE site_id = ? AND type = 'rapport-mensuel' ORDER BY le DESC LIMIT 12)").run(site.id, site.id);
      raiseAlert(this.ctx, 'information', `Rapport de référencement de « ${site.name} » disponible (${r.mois}) : voir « Référencement ».`, site.id);
      if (this.ctx.mailer?.configured()) {
        const dest = site.notify_email || null;
        const envoi = dest ? this.ctx.mailer.send(dest, titreRapport(r), texteRapport(r)) : this.ctx.mailer.sendAlert(titreRapport(r), texteRapport(r));
        await envoi.catch((e) => console.error('[rapport référencement] e-mail non envoyé :', (e as Error).message));
      }
      n++;
    }
    return n;
  }

  /** Audit hebdomadaire des sites qui l'ont demandé : la version en ligne (ce que voient les moteurs), sinon le brouillon. */
  async tic(): Promise<void> {
    await this.envoyerRapports().catch((e) => console.error('[rapport référencement]', (e as Error).message));
    for (const site of this.ctx.db.prepare('SELECT * FROM sites').all() as unknown as SiteRow[]) {
      if (!this.reglages(site).hebdo || this.enCours.has(site.id)) continue;
      const cible: Cible = site.live_publication !== null ? 'en-ligne' : 'brouillon';
      const d = this.dernier(site, cible);
      if (d && now() - d.le < SEMAINE) continue;
      await this.lancer(site, cible, null).catch((e) => console.error('[référencement]', site.slug, (e as Error).message));
    }
  }
}
