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

/**
 * Référencement (M1) : lance l'audit local, garde l'historique (30 derniers par site), compare avec le précédent,
 * et, si vous l'activez, refait l'audit chaque semaine avec une alerte quand de NOUVEAUX problèmes apparaissent.
 * Lecture seule : rien n'est jamais modifié sur le site.
 */
export type Cible = 'brouillon' | 'en-ligne';
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
  constructor(private ctx: Ctx) {}

  reglages(site: SiteRow): { hebdo: boolean } {
    try {
      return { hebdo: false, ...JSON.parse(getSetting(this.ctx.db, `seo:${site.id}`) ?? '{}') };
    } catch {
      return { hebdo: false };
    }
  }
  regler(site: SiteRow, input: { hebdo?: unknown }) {
    const r = { ...this.reglages(site), hebdo: input.hebdo === true };
    setSetting(this.ctx.db, `seo:${site.id}`, JSON.stringify(r));
    return r;
  }

  /** Dossier à auditer : le brouillon fabriqué pour l'occasion (sans toucher à l'aperçu), ou la version en ligne. */
  private async racine(site: SiteRow, cible: Cible): Promise<string> {
    if (cible === 'en-ligne') {
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
    if (cible !== 'brouillon' && cible !== 'en-ligne') throw new UserError(400, 'Cible inconnue.');
    if (this.enCours.has(site.id)) throw new UserError(409, 'Un audit est déjà en cours pour ce site.');
    this.enCours.add(site.id);
    try {
      const r = auditer(await this.racine(site, cible), this.ctx.sites.domains(site));
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
        constats: r.constats.map((c) => ({ ...c, nouveau: avant ? !avant.has(cle(c)) : false })),
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
      historique: lignes.map((l) => {
        const r = JSON.parse(l.resultat) as ResultatAudit;
        const n = (x: string) => r.constats.filter((c) => c.niveau === x).length;
        return { id: l.id, le: l.le, cible: l.cible, automatique: !l.par, problemes: n('probleme'), attention: n('attention'), info: n('info') };
      }),
    };
  }

  /** Audit hebdomadaire des sites qui l'ont demandé : la version en ligne (ce que voient les moteurs), sinon le brouillon. */
  async tic(): Promise<void> {
    for (const site of this.ctx.db.prepare('SELECT * FROM sites').all() as unknown as SiteRow[]) {
      if (!this.reglages(site).hebdo || this.enCours.has(site.id)) continue;
      const cible: Cible = site.live_publication !== null ? 'en-ligne' : 'brouillon';
      const d = this.dernier(site, cible);
      if (d && now() - d.le < SEMAINE) continue;
      await this.lancer(site, cible, null).catch((e) => console.error('[référencement]', site.slug, (e as Error).message));
    }
  }
}
