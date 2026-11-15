import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { Ctx } from '../context.js';
import { getUser } from '../auth/service.js';
import { audit } from '../lib/audit.js';
import { now, UserError } from '../lib/util.js';
import { authorOf, type SiteRow } from '../sites/service.js';
import { buildOutput, checkLinks, checkSource, makeReadOnly, readLink, removeTree, swapSymlink } from './build.js';
import { readManifest } from '../sites/manifest.js';
import type { JobRun } from '../jobs/queue.js';

export const PUBLISH_STEPS = [
  'Verrou',
  'Figer le brouillon',
  'Contrôler',
  'Fabriquer',
  'Vérifier le résultat',
  'Ranger la version',
  'Fonctions serveur',
  'Basculer',
  'Vérifier en ligne',
  'Enregistrer',
];

export const RESTORE_STEPS = ['Préparer la version', 'Basculer', 'Vérifier en ligne', 'Enregistrer'];

/** Vérification « en conditions réelles » : on interroge le serveur des sites comme un visiteur. Remplaçable pour les tests. */
export const hooks = {
  verifyLive: async (ctx: Ctx, site: SiteRow, expectedVersion: number): Promise<void> => {
    const host = `${site.slug}.${ctx.config.sitesBaseDomain}`;
    const res = await new Promise<{ status: number; version: string | undefined; length: number }>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: ctx.config.sitesPort, path: '/', headers: { host }, timeout: 10_000 }, (r) => {
        let length = 0;
        r.on('data', (c: Buffer) => (length += c.length));
        r.on('end', () => resolve({ status: r.statusCode ?? 0, version: r.headers['x-paginity-version'] as string | undefined, length }));
      });
      req.on('timeout', () => req.destroy(new Error('délai dépassé')));
      req.on('error', reject);
    });
    if (res.status !== 200 || res.length === 0) throw new Error(`le site a répondu ${res.status}`);
    if (res.version !== String(expectedVersion)) throw new Error(`le site sert la version ${res.version ?? '?'} au lieu de ${expectedVersion}`);
  },
};

function versionDirName(n: number): string {
  return `v${String(n).padStart(4, '0')}`;
}

function tmpDir(ctx: Ctx, name: string): string {
  const d = path.join(ctx.config.dataDir, 'temporaire', name);
  removeTree(d);
  fs.mkdirSync(path.dirname(d), { recursive: true });
  return d;
}

async function switchAndVerify(ctx: Ctx, run: JobRun, site: SiteRow, versionDir: string, number: number): Promise<void> {
  const link = ctx.sites.liveLink(site);
  const previous = readLink(link);
  const previousLive = site.live_publication;
  await run.step('Basculer', async () => {
    swapSymlink(link, versionDir);
    ctx.db.prepare('UPDATE sites SET live_publication = ? WHERE id = ?').run(number, site.id);
    ctx.sites.invalidate();
  }, () => `La version n°${number} est en ligne.`);
  try {
    await run.step('Vérifier en ligne', async () => {
      try {
        await hooks.verifyLive(ctx, ctx.sites.get(site.id)!, number);
      } catch (e) {
        throw new UserError(502, `Le site ne répond pas correctement (${(e as Error).message}).`);
      }
    }, () => 'Le site répond correctement.');
  } catch (e) {
    // Retour automatique à la version précédente.
    if (previous) swapSymlink(link, previous);
    else fs.rmSync(link, { force: true });
    ctx.db.prepare('UPDATE sites SET live_publication = ? WHERE id = ?').run(previousLive, site.id);
    ctx.sites.invalidate();
    throw new UserError(502, `${(e as Error).message} Retour automatique à la version précédente${previousLive ? ` (n°${previousLive})` : ''}.`);
  }
}

function pruneVersions(ctx: Ctx, site: SiteRow): void {
  const dir = ctx.sites.versionsDir(site);
  const live = readLink(ctx.sites.liveLink(site));
  const all = fs.readdirSync(dir).filter((d) => /^v\d+$/.test(d)).sort();
  const excess = all.length - ctx.config.keepVersions;
  for (const d of all.slice(0, Math.max(0, excess))) {
    if (live && path.resolve(live) === path.resolve(dir, d)) continue;
    removeTree(path.join(dir, d));
  }
}

export async function runPublication(ctx: Ctx, run: JobRun): Promise<unknown> {
  const site = ctx.sites.get(run.siteId!);
  if (!site) throw new UserError(404, 'Site introuvable.');
  const user = run.userId ? getUser(ctx, run.userId) : undefined;
  if (!user) throw new UserError(403, 'Utilisateur introuvable.');
  const started = now();
  let number: number | null = null;
  const srcDir = tmpDir(ctx, `source-${run.id}`);
  const outDir = tmpDir(ctx, `sortie-${run.id}`);
  const message = typeof run.payload.message === 'string' ? run.payload.message.slice(0, 200) : '';
  const warnings: string[] = [];
  try {
    await run.step('Verrou', async () => undefined, () => 'Aucune autre publication en cours pour ce site.');

    const commit = await run.step(
      'Figer le brouillon',
      () =>
        ctx.sites.lock(site.id, async () => {
          const repo = ctx.sites.repo(site);
          await repo.commitAll('Enregistrement avant publication', authorOf(user));
          const head = await repo.head();
          if (!head) throw new UserError(400, 'Le site est vide.');
          const r = ctx.db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM publications WHERE site_id = ?').get(site.id) as { n: number };
          number = r.n;
          ctx.db
            .prepare('INSERT INTO publications (site_id, number, commit_hash, message, created_by, created_at, status, job_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(site.id, number, head, message, user.id, started, 'en_cours', run.id);
          await repo.extract(head, '', srcDir);
          return head;
        }),
      (h) => `Version ${h.slice(0, 8)} figée : publication n°${number}.`,
    );

    const check = await run.step('Contrôler', async () => checkSource(srcDir), (c) => `${c.files} fichiers contrôlés${c.warnings.length ? `, ${c.warnings.length} avertissement(s)` : ''}.`);
    warnings.push(...check.warnings);

    if (check.manifest.build) {
      run.note('Fabriquer', 'Étape de préparation non exécutée (prise en charge isolée en phase 3).');
    }
    const count = await run.step('Fabriquer', async () => buildOutput(srcDir, check.manifest, outDir, String(number)), (n) => `${n} fichiers prêts à publier.`);
    void count;

    const linkWarnings = await run.step('Vérifier le résultat', async () => checkLinks(outDir), (w) => (w.length ? `${w.length} lien(s) à vérifier.` : 'Aucun lien cassé détecté.'));
    warnings.push(...linkWarnings);

    const versionDir = path.join(ctx.sites.versionsDir(site), versionDirName(number!));
    await run.step('Ranger la version', async () => {
      removeTree(versionDir);
      fs.renameSync(outDir, versionDir);
      makeReadOnly(versionDir);
      fs.chmodSync(versionDir, 0o555);
    }, () => `Rangée en lecture seule (${versionDirName(number!)}).`);

    if (check.manifest.functionsDir && fs.existsSync(path.join(srcDir, check.manifest.functionsDir))) {
      run.skip('Fonctions serveur', 'Fonctions détectées : elles seront exécutées dans des conteneurs isolés à partir de la phase 3.');
    } else {
      run.skip('Fonctions serveur', 'Aucune fonction serveur pour ce site.');
    }

    await switchAndVerify(ctx, run, site, versionDir, number!);

    await run.step('Enregistrer', async () => {
      await ctx.sites.lock(site.id, () => ctx.sites.repo(site).tag(`pub-${number}`, commit));
      ctx.db
        .prepare("UPDATE publications SET status = 'reussie', duration_ms = ?, warnings = ? WHERE site_id = ? AND number = ?")
        .run(now() - started, JSON.stringify(warnings), site.id, number);
      ctx.db.prepare("UPDATE sites SET last_publication_status = 'reussie' WHERE id = ?").run(site.id);
      pruneVersions(ctx, site);
      audit(ctx.db, { userId: user.id, action: 'publication', siteId: site.id, details: { numero: number, commit } });
    }, () => `Publication n°${number} enregistrée en ${((now() - started) / 1000).toFixed(1)} s.`);

    return { numero: number, duree: now() - started, avertissements: warnings };
  } catch (e) {
    if (number !== null) {
      ctx.db.prepare("UPDATE publications SET status = 'echouee', duration_ms = ?, warnings = ? WHERE site_id = ? AND number = ?").run(now() - started, JSON.stringify(warnings), site.id, number);
    }
    ctx.db.prepare("UPDATE sites SET last_publication_status = 'echouee' WHERE id = ?").run(site.id);
    audit(ctx.db, { userId: user.id, action: 'publication_echouee', siteId: site.id, details: { numero: number, erreur: (e as Error).message } });
    throw e;
  } finally {
    removeTree(srcDir);
    removeTree(outDir);
  }
}

/** Remet en ligne une publication précédente (sans toucher au brouillon ni aux données métier). */
export async function runRestore(ctx: Ctx, run: JobRun): Promise<unknown> {
  const site = ctx.sites.get(run.siteId!);
  if (!site) throw new UserError(404, 'Site introuvable.');
  const number = Number(run.payload.numero);
  const pub = ctx.db.prepare("SELECT * FROM publications WHERE site_id = ? AND number = ? AND status = 'reussie'").get(site.id, number) as
    | { commit_hash: string }
    | undefined;
  if (!pub) throw new UserError(404, 'Cette publication est introuvable ou n’avait pas réussi.');
  const versionDir = path.join(ctx.sites.versionsDir(site), versionDirName(number));
  await run.step('Préparer la version', async () => {
    if (fs.existsSync(path.join(versionDir, 'index.html'))) return 'existante';
    // Version trop ancienne : on la refabrique depuis l'historique.
    const srcDir = tmpDir(ctx, `source-${run.id}`);
    const outDir = tmpDir(ctx, `sortie-${run.id}`);
    try {
      await ctx.sites.lock(site.id, () => ctx.sites.repo(site).extract(pub.commit_hash, '', srcDir));
      const check = checkSource(srcDir);
      buildOutput(srcDir, check.manifest, outDir, String(number));
      removeTree(versionDir);
      fs.renameSync(outDir, versionDir);
      makeReadOnly(versionDir);
      return 'refabriquee';
    } finally {
      removeTree(srcDir);
      removeTree(outDir);
    }
  }, (r) => (r === 'existante' ? 'Version encore disponible : bascule immédiate.' : 'Version refabriquée depuis l’historique.'));
  await switchAndVerify(ctx, run, site, versionDir, number);
  await run.step('Enregistrer', async () => {
    ctx.db.prepare("UPDATE sites SET last_publication_status = 'reussie' WHERE id = ?").run(site.id);
    audit(ctx.db, { userId: run.userId, action: 'remise_en_ligne', siteId: site.id, details: { numero: number } });
  }, () => `La publication n°${number} est de nouveau en ligne. Le brouillon et les données n’ont pas été modifiés.`);
  return { numero: number };
}

/** Fabrique l'aperçu privé du brouillon (sans fonctions serveur réelles). */
export async function buildPreview(ctx: Ctx, site: SiteRow): Promise<{ duree: number; avertissements: string[] }> {
  const started = now();
  return ctx.sites.lock(site.id, async () => {
    const repo = ctx.sites.repo(site);
    const head = await repo.head();
    if (!head) throw new UserError(400, 'Le site est vide.');
    const srcDir = tmpDir(ctx, `apercu-src-${site.id}`);
    const base = path.join(ctx.sites.dir(site), 'apercus');
    fs.mkdirSync(base, { recursive: true });
    const outDir = path.join(base, `a${Date.now()}`);
    try {
      await repo.extract(head, '', srcDir);
      const manifest = readManifest(srcDir);
      const pub = path.join(srcDir, manifest.publishDir === '.' ? '' : manifest.publishDir);
      if (!fs.existsSync(pub)) throw new UserError(422, `Le dossier publié « ${manifest.publishDir} » n'existe pas.`);
      buildOutput(srcDir, manifest, outDir, 'apercu');
      const warnings = fs.existsSync(path.join(outDir, 'index.html')) ? checkLinks(outDir) : ["Il manque la page d'accueil index.html."];
      const link = ctx.sites.previewLink(site);
      const old = readLink(link);
      swapSymlink(link, outDir);
      if (old && path.resolve(old) !== path.resolve(outDir)) setTimeout(() => removeTree(old), 30_000).unref();
      return { duree: now() - started, avertissements: warnings };
    } catch (e) {
      removeTree(outDir);
      throw e;
    } finally {
      removeTree(srcDir);
    }
  });
}

export function defineSiteJobs(ctx: Ctx): void {
  ctx.jobs.define('publication', { steps: PUBLISH_STEPS, run: (r) => runPublication(ctx, r) });
  ctx.jobs.define('remise-en-ligne', { steps: RESTORE_STEPS, run: (r) => runRestore(ctx, r) });
}
