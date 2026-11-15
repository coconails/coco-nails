import fs from 'node:fs';
import path from 'node:path';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { execFile } from 'node:child_process';
import type { Ctx } from '../context.js';
import type { UserRow } from '../auth/service.js';
import { getUser } from '../auth/service.js';
import { audit } from '../lib/audit.js';
import { UserError } from '../lib/util.js';
import { assertNoSymlinks, removeTree } from '../publish/build.js';
import type { JobRun } from '../jobs/queue.js';
import { readManifest } from './manifest.js';
import type { SiteRow } from './service.js';

const MAX_TOTAL = 500 * 1024 * 1024;
const MAX_FILES = 20_000;
const SKIP = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|\.git|node_modules)(\/|$)/;

/** Extraction sûre d'une archive ZIP : aucun fichier hors du dossier, aucun lien symbolique, tailles limitées. */
export function extractZip(zipPath: string, dest: string): Promise<number> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) return reject(new UserError(400, 'Cette archive ZIP est illisible ou endommagée.'));
      let total = 0;
      let count = 0;
      const fail = (e: Error) => {
        zip.close();
        reject(e);
      };
      zip.on('error', (e) => fail(new UserError(400, `Archive ZIP endommagée : ${e.message}`)));
      zip.on('end', () => resolve(count));
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName.replace(/\\/g, '/');
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (SKIP.test(name)) return zip.readEntry();
        if (mode === 0o120000) return fail(new UserError(400, `L'archive contient un lien symbolique (${name}), refusé par sécurité.`));
        const norm = path.posix.normalize(name);
        if (norm.startsWith('../') || norm === '..' || path.posix.isAbsolute(norm) || norm.split('/').includes('..')) {
          return fail(new UserError(400, `Chemin dangereux dans l'archive : ${name}`));
        }
        const abs = path.join(dest, norm);
        if (!abs.startsWith(dest + path.sep) && abs !== dest) return fail(new UserError(400, `Chemin dangereux dans l'archive : ${name}`));
        if (name.endsWith('/')) {
          fs.mkdirSync(abs, { recursive: true });
          return zip.readEntry();
        }
        count++;
        total += entry.uncompressedSize;
        if (count > MAX_FILES) return fail(new UserError(400, `L'archive contient trop de fichiers (plus de ${MAX_FILES}).`));
        if (total > MAX_TOTAL) return fail(new UserError(400, 'L’archive décompressée dépasse 500 Mo.'));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        zip.openReadStream(entry, (e2, stream) => {
          if (e2 || !stream) return fail(new UserError(400, `Fichier illisible dans l'archive : ${name}`));
          const out = fs.createWriteStream(abs, { mode: 0o644 });
          stream.on('error', (e) => fail(new UserError(400, `Fichier illisible dans l'archive : ${e.message}`)));
          out.on('error', fail);
          out.on('close', () => zip.readEntry());
          stream.pipe(out);
        });
      });
      zip.readEntry();
    });
  });
}

/** Si tout est rangé dans un unique dossier (archive « mon-site/... »), on remonte son contenu. */
export function flattenSingleFolder(dir: string): void {
  const entries = fs.readdirSync(dir).filter((n) => !n.startsWith('.') || n === '.pages.yml');
  if (entries.length === 1 && fs.statSync(path.join(dir, entries[0])).isDirectory() && !fs.existsSync(path.join(dir, 'index.html'))) {
    const inner = path.join(dir, entries[0]);
    for (const n of fs.readdirSync(inner)) fs.renameSync(path.join(inner, n), path.join(dir, n));
    fs.rmdirSync(inner);
  }
}

export function cloneGit(url: string, dest: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new UserError(400, 'Adresse de dépôt invalide.');
  }
  if (u.protocol !== 'https:' || u.username || u.password) throw new UserError(400, 'Seules les adresses https:// publiques sont acceptées (sans identifiant dans l’adresse).');
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', 'clone', '--depth', '1', '--no-tags', '--single-branch', u.toString(), dest],
      { env: { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: '0', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy, GIT_SSL_CAINFO: process.env.GIT_SSL_CAINFO, SSL_CERT_FILE: process.env.SSL_CERT_FILE }, timeout: 180_000 },
      (err, _o, stderr) => (err ? reject(new UserError(400, `Le dépôt n'a pas pu être récupéré : ${stderr.split('\n').filter(Boolean).pop() ?? err.message}`)) : resolve()),
    );
  });
}

export const IMPORT_STEPS = ['Recevoir les fichiers', 'Vérifier', 'Créer le site', 'Analyser'];

export async function runImport(ctx: Ctx, run: JobRun): Promise<unknown> {
  const user = getUser(ctx, run.userId!) as UserRow;
  const p = run.payload as { nom: string; zip?: string; git?: string };
  const staging = path.join(ctx.config.dataDir, 'temporaire', `import-${run.id}`);
  removeTree(staging);
  fs.mkdirSync(staging, { recursive: true });
  try {
    await run.step('Recevoir les fichiers', async () => {
      if (p.zip) return extractZip(p.zip, staging);
      if (p.git) {
        removeTree(staging);
        await cloneGit(p.git, staging);
        return 0;
      }
      throw new UserError(400, 'Rien à importer.');
    }, (n) => (p.zip ? `${n} fichiers extraits de l'archive.` : 'Dépôt récupéré.'));
    const manifest = await run.step('Vérifier', async () => {
      removeTree(path.join(staging, '.git'));
      // Un dépôt Git peut contenir des liens symboliques (une archive ZIP est déjà refusée dans ce cas).
      assertNoSymlinks(staging);
      flattenSingleFolder(staging);
      const m = readManifest(staging);
      if (!fs.existsSync(path.join(staging, m.publishDir === '.' ? '' : m.publishDir, 'index.html'))) {
        throw new UserError(422, 'Aucune page d’accueil (index.html) trouvée. Vérifiez le contenu de l’archive.');
      }
      return m;
    }, (m) => `Dossier publié : « ${m.publishDir} » (fiche ${m.source}).`);
    const site = await run.step('Créer le site', () =>
      ctx.sites.createSite({
        name: p.nom,
        user,
        message: p.zip ? 'Import du site (archive ZIP)' : `Import du site depuis ${p.git}`,
        fill: async (repoDir) => {
          fs.rmSync(repoDir, { recursive: true, force: true });
          fs.renameSync(staging, repoDir);
        },
      }),
    (s) => `Site « ${s.name} » créé.`);
    const info = await run.step('Analyser', async () => manifest.warnings, (w) => (w.length ? w.join(' ') : 'Aucune remarque.'));
    audit(ctx.db, { userId: user.id, action: 'import_site', siteId: site.id, details: { source: p.zip ? 'zip' : p.git } });
    return { siteId: site.id, remarques: info };
  } finally {
    removeTree(staging);
    if (p.zip) fs.rmSync(p.zip, { force: true });
  }
}

export async function createFromTemplate(ctx: Ctx, user: UserRow, name: string, template: string): Promise<SiteRow> {
  if (!/^[a-z0-9-]+$/.test(template)) throw new UserError(400, 'Modèle inconnu.');
  const src = path.join(ctx.config.templatesDir, template);
  if (!fs.existsSync(src)) throw new UserError(400, 'Modèle inconnu.');
  const site = await ctx.sites.createSite({
    name,
    user,
    message: `Création du site à partir du modèle « ${template} »`,
    fill: async (repoDir) => {
      fs.cpSync(src, repoDir, { recursive: true });
      // Le nom du site remplace le texte d'exemple du modèle.
      for (const f of ['public/contenu/site.json', 'public/index.html']) {
        const p = path.join(repoDir, f);
        if (fs.existsSync(p)) fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll('{{NOM_DU_SITE}}', name.replace(/["\\<>]/g, '')));
      }
    },
  });
  audit(ctx.db, { userId: user.id, action: 'creation_site', siteId: site.id, details: { modele: template } });
  return site;
}

export function listTemplates(ctx: Ctx) {
  const labels: Record<string, { nom: string; description: string }> = {
    vitrine: { nom: 'Vitrine une page', description: 'Accueil, prestations et tarifs, horaires, questions fréquentes, contact. Contenus modifiables par formulaires.' },
    vierge: { nom: 'Site vierge', description: 'Une page simple à compléter, pour partir de zéro.' },
  };
  if (!fs.existsSync(ctx.config.templatesDir)) return [];
  return fs
    .readdirSync(ctx.config.templatesDir)
    .filter((d) => labels[d])
    .map((d) => ({ id: d, ...labels[d] }));
}

/** Export complet : historique Git (bundle), fichiers du site et données, dans une archive ZIP standard. */
export async function exportSite(ctx: Ctx, site: SiteRow): Promise<NodeJS.ReadableStream> {
  const tmp = path.join(ctx.config.dataDir, 'temporaire', `export-${site.id}-${Date.now()}.bundle`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  await ctx.sites.lock(site.id, () => ctx.sites.repo(site).bundle(tmp));
  const zip = new yazl.ZipFile();
  const add = (root: string, prefix: string) => {
    if (!fs.existsSync(root)) return;
    const walk = (d: string, rel: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === '.git' || e.isSymbolicLink()) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else if (e.isFile()) zip.addFile(path.join(d, e.name), `${prefix}/${r}`);
      }
    };
    walk(root, '');
  };
  add(ctx.sites.repoDir(site), 'site');
  add(ctx.sites.dataDir(site), 'donnees');
  zip.addFile(tmp, 'historique.bundle');
  zip.addBuffer(
    Buffer.from(
      [
        `Export PAGINITY du site « ${site.name} » — ${new Date().toISOString()}`,
        '',
        'site/               fichiers du site (brouillon actuel), utilisables sur n’importe quel hébergeur',
        'donnees/            données propres au site (hors historique)',
        'historique.bundle   tout l’historique Git ; pour le récupérer : git clone historique.bundle mon-site',
        '',
        'Les secrets (mots de passe, clés) ne sont jamais exportés.',
      ].join('\n'),
    ),
    'LISEZMOI.txt',
  );
  zip.end();
  zip.outputStream.on('end', () => fs.rmSync(tmp, { force: true }));
  return zip.outputStream;
}
