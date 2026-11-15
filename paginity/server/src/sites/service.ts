import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../context.js';
import { previewOrigin, siteTestOrigin } from '../config.js';
import { Repo, type Author } from '../lib/git.js';
import { KeyedMutex, now, randomId, slugify, UserError } from '../lib/util.js';
import type { UserRow } from '../auth/service.js';
import { readManifest, writeManifest, type SiteManifest } from './manifest.js';

export type Role = 'contributeur' | 'editeur' | 'admin_site' | 'proprietaire';
export const ROLE_RANK: Record<Role, number> = { contributeur: 1, editeur: 2, admin_site: 3, proprietaire: 4 };
export const ROLE_LABEL: Record<Role, string> = {
  contributeur: 'Contributeur',
  editeur: 'Éditeur',
  admin_site: 'Administrateur du site',
  proprietaire: 'Propriétaire',
};

/** Ce que chaque action exige comme rôle minimal (contrôle centralisé des droits). */
export type Action = 'voir' | 'contenus' | 'publier' | 'code' | 'reglages' | 'membres' | 'exporter' | 'supprimer';
const MIN_ROLE: Record<Action, Role> = {
  voir: 'contributeur',
  contenus: 'contributeur',
  publier: 'editeur',
  code: 'admin_site',
  reglages: 'admin_site',
  membres: 'admin_site',
  exporter: 'admin_site',
  supprimer: 'proprietaire',
};

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && v in ROLE_RANK && v !== 'proprietaire';
}

export function roleAllows(role: Role | null, action: Action): boolean {
  return !!role && ROLE_RANK[role] >= ROLE_RANK[MIN_ROLE[action]];
}

export interface SiteRow {
  id: string;
  space_id: string;
  slug: string;
  name: string;
  domains: string;
  created_at: number;
  created_by: string;
  live_publication: number | null;
  last_publication_status: string | null;
}

export class SiteService {
  readonly mutex = new KeyedMutex();
  private domainCache: Map<string, SiteRow> | null = null;
  ctx!: Ctx;

  // -------------------------------------------------------------------------
  // Emplacements sur le disque
  // -------------------------------------------------------------------------
  dir(site: SiteRow): string {
    return path.join(this.ctx.config.dataDir, 'espaces', site.space_id, 'sites', site.id);
  }
  repoDir(site: SiteRow): string {
    return path.join(this.dir(site), 'source');
  }
  versionsDir(site: SiteRow): string {
    return path.join(this.dir(site), 'versions');
  }
  liveLink(site: SiteRow): string {
    return path.join(this.dir(site), 'en-ligne');
  }
  previewLink(site: SiteRow): string {
    return path.join(this.dir(site), 'apercu');
  }
  dataDir(site: SiteRow): string {
    return path.join(this.dir(site), 'donnees');
  }
  repo(site: SiteRow): Repo {
    return new Repo(this.repoDir(site));
  }
  manifest(site: SiteRow): SiteManifest {
    return readManifest(this.repoDir(site));
  }

  /** Exécute une opération sur le dépôt d'un site, une à la fois. */
  lock<T>(siteId: string, fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(siteId, fn);
  }

  // -------------------------------------------------------------------------
  // Lecture et droits
  // -------------------------------------------------------------------------
  get(id: string): SiteRow | undefined {
    return this.ctx.db.prepare('SELECT * FROM sites WHERE id = ?').get(id) as SiteRow | undefined;
  }

  all(): SiteRow[] {
    return this.ctx.db.prepare('SELECT * FROM sites ORDER BY name COLLATE NOCASE').all() as unknown as SiteRow[];
  }

  role(user: UserRow, siteId: string): Role | null {
    if (user.is_owner) return 'proprietaire';
    const r = this.ctx.db.prepare('SELECT role FROM site_members WHERE site_id = ? AND user_id = ?').get(siteId, user.id) as { role: Role } | undefined;
    return r?.role ?? null;
  }

  /** Point de contrôle unique : refuse si l'utilisateur n'a pas le rôle nécessaire sur ce site. */
  require(user: UserRow, siteId: string, action: Action): { site: SiteRow; role: Role } {
    const site = this.get(siteId);
    const role = site ? this.role(user, site.id) : null;
    if (!site || !role) throw new UserError(404, 'Site introuvable.');
    if (!roleAllows(role, action)) {
      throw new UserError(403, `Votre rôle (« ${ROLE_LABEL[role]} ») ne permet pas cette action sur ce site.`);
    }
    return { site, role };
  }

  accessibleSites(user: UserRow): SiteRow[] {
    if (user.is_owner) return this.all();
    return this.ctx.db
      .prepare('SELECT s.* FROM sites s JOIN site_members m ON m.site_id = s.id WHERE m.user_id = ? ORDER BY s.name COLLATE NOCASE')
      .all(user.id) as unknown as SiteRow[];
  }

  domains(site: SiteRow): string[] {
    try {
      return JSON.parse(site.domains);
    } catch {
      return [];
    }
  }

  /** Correspondance « nom d'hôte → site » utilisée par le serveur des sites. */
  hostMap(): Map<string, SiteRow> {
    if (this.domainCache) return this.domainCache;
    const m = new Map<string, SiteRow>();
    for (const s of this.all()) {
      m.set(`${s.slug}.${this.ctx.config.sitesBaseDomain}`.toLowerCase(), s);
      for (const d of this.domains(s)) m.set(d.toLowerCase(), s);
    }
    this.domainCache = m;
    return m;
  }

  invalidate(): void {
    this.domainCache = null;
  }

  urls(site: SiteRow) {
    return {
      test: siteTestOrigin(this.ctx.config, site.slug),
      apercu: previewOrigin(this.ctx.config, site.slug),
      domaines: this.domains(site).map((d) => `https://${d}`),
    };
  }

  // -------------------------------------------------------------------------
  // Création
  // -------------------------------------------------------------------------
  uniqueSlug(name: string): string {
    let base = slugify(name) || 'site';
    if (/^\d/.test(base)) base = `site-${base}`;
    const reserved = new Set(['www', 'admin', 'apercu', 'api', 'paginity', 'localhost']);
    let slug = reserved.has(base) ? `${base}-site` : base;
    let i = 2;
    while (this.ctx.db.prepare('SELECT 1 FROM sites WHERE slug = ?').get(slug)) slug = `${base}-${i++}`;
    return slug;
  }

  defaultSpace(): string {
    const r = this.ctx.db.prepare('SELECT id FROM spaces ORDER BY created_at LIMIT 1').get() as { id: string } | undefined;
    if (r) return r.id;
    const id = 'personnel';
    this.ctx.db.prepare('INSERT INTO spaces (id, name, created_at) VALUES (?, ?, ?)').run(id, 'Mon espace', now());
    return id;
  }

  /**
   * Crée l'enregistrement et les dossiers d'un site. `fill` remplit le dossier source
   * (copie d'un modèle, import…). En cas d'échec, tout est nettoyé.
   */
  async createSite(input: { name: string; user: UserRow; fill: (repoDir: string) => Promise<void>; message: string }): Promise<SiteRow> {
    const name = input.name.trim().slice(0, 80);
    if (!name) throw new UserError(400, 'Donnez un nom au site.');
    const id = randomId('s');
    const site: SiteRow = {
      id,
      space_id: this.defaultSpace(),
      slug: this.uniqueSlug(name),
      name,
      domains: '[]',
      created_at: now(),
      created_by: input.user.id,
      live_publication: null,
      last_publication_status: null,
    };
    const dir = this.dir(site);
    try {
      fs.mkdirSync(this.repoDir(site), { recursive: true });
      fs.mkdirSync(this.versionsDir(site), { recursive: true });
      fs.mkdirSync(this.dataDir(site), { recursive: true });
      fs.mkdirSync(path.join(dir, 'journaux'), { recursive: true });
      await input.fill(this.repoDir(site));
      // Les dossiers techniques importés ne doivent pas entrer dans l'historique.
      fs.rmSync(path.join(this.repoDir(site), '.git'), { recursive: true, force: true });
      fs.rmSync(path.join(this.repoDir(site), 'node_modules'), { recursive: true, force: true });
      const repo = this.repo(site);
      await repo.init();
      if (!fs.existsSync(path.join(this.repoDir(site), 'paginity.yml'))) {
        const m = readManifest(this.repoDir(site));
        writeManifest(this.repoDir(site), m);
      }
      const commit = await repo.commitAll(input.message, authorOf(input.user));
      if (!commit) throw new UserError(400, 'Le site est vide.');
      this.ctx.db
        .prepare('INSERT INTO sites (id, space_id, slug, name, domains, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(site.id, site.space_id, site.slug, site.name, site.domains, site.created_at, site.created_by);
      if (!input.user.is_owner) {
        this.ctx.db.prepare('INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, ?)').run(site.id, input.user.id, 'admin_site');
      }
      this.invalidate();
      return this.get(site.id)!;
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }

  updateSettings(site: SiteRow, input: { name?: unknown; domains?: unknown }): SiteRow {
    if (input.name !== undefined) {
      const name = String(input.name).trim().slice(0, 80);
      if (!name) throw new UserError(400, 'Le nom ne peut pas être vide.');
      this.ctx.db.prepare('UPDATE sites SET name = ? WHERE id = ?').run(name, site.id);
    }
    if (input.domains !== undefined) {
      if (!Array.isArray(input.domains)) throw new UserError(400, 'Liste de domaines invalide.');
      const list = [...new Set(input.domains.map((d) => String(d).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean))];
      for (const d of list) {
        if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(d)) throw new UserError(400, `Nom de domaine invalide : ${d}`);
        const other = this.hostMap().get(d);
        if (other && other.id !== site.id) throw new UserError(409, `Le domaine ${d} est déjà utilisé par le site « ${other.name} ».`);
      }
      this.ctx.db.prepare('UPDATE sites SET domains = ? WHERE id = ?').run(JSON.stringify(list), site.id);
    }
    this.invalidate();
    return this.get(site.id)!;
  }

  async deleteSite(site: SiteRow): Promise<void> {
    await this.lock(site.id, async () => {
      this.ctx.db.prepare('DELETE FROM sites WHERE id = ?').run(site.id);
      fs.rmSync(this.dir(site), { recursive: true, force: true });
      this.invalidate();
    });
  }

  // -------------------------------------------------------------------------
  // État de publication
  // -------------------------------------------------------------------------
  liveTag(site: SiteRow): string | null {
    return site.live_publication ? `pub-${site.live_publication}` : null;
  }

  /** Dernière publication réussie : référence pour « modifications non publiées ». */
  lastPublishedTag(site: SiteRow): string | null {
    const r = this.ctx.db
      .prepare("SELECT number FROM publications WHERE site_id = ? AND status = 'reussie' ORDER BY number DESC LIMIT 1")
      .get(site.id) as { number: number } | undefined;
    return r ? `pub-${r.number}` : null;
  }

  async pendingFiles(site: SiteRow) {
    const repo = this.repo(site);
    const head = await repo.head();
    if (!head) return [];
    const base = this.liveTag(site);
    const list = await repo.diffNameStatus(base ? await repo.resolve(base) : null, head);
    return list.filter((f) => f.path !== 'paginity.yml' || !!base);
  }

  async summary(site: SiteRow, role: Role) {
    const pending = await this.pendingFiles(site).catch(() => []);
    let etat: 'jamais_publie' | 'en_ligne' | 'modifications' | 'erreur' = 'jamais_publie';
    if (site.last_publication_status === 'echouee') etat = 'erreur';
    else if (site.live_publication) etat = pending.length ? 'modifications' : 'en_ligne';
    const last = this.ctx.db
      .prepare('SELECT number, created_at, status FROM publications WHERE site_id = ? ORDER BY number DESC LIMIT 1')
      .get(site.id) as { number: number; created_at: number; status: string } | undefined;
    const live = site.live_publication
      ? (this.ctx.db.prepare('SELECT number, created_at FROM publications WHERE site_id = ? AND number = ?').get(site.id, site.live_publication) as
          | { number: number; created_at: number }
          | undefined)
      : undefined;
    return {
      id: site.id,
      slug: site.slug,
      nom: site.name,
      espace: site.space_id,
      role,
      roleLibelle: ROLE_LABEL[role],
      urls: this.urls(site),
      etat,
      modificationsEnAttente: pending.length,
      enLigne: live ? { numero: live.number, le: live.created_at } : null,
      dernierePublication: last ? { numero: last.number, le: last.created_at, etat: last.status } : null,
      creeLe: site.created_at,
    };
  }
}

export function authorOf(user: UserRow): Author {
  return { name: user.name, email: user.email };
}
