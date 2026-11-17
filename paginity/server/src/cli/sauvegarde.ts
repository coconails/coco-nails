import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { Vault } from '../lib/vault.js';
import { UserError } from '../lib/util.js';

/**
 * Sauvegarde complète de PAGINITY et restauration vérifiée.
 *
 * Une sauvegarde = deux fichiers, à ranger SÉPARÉMENT :
 *  - paginity-sauvegarde-<date>.tar.gz : la base (copie cohérente), les sites (historiques Git, versions publiées,
 *    données) et une fiche « sauvegarde.json » avec l'empreinte SHA-256 de chaque fichier ;
 *  - paginity-cle-coffre-<date>.txt : la clé du coffre. Sans elle, les secrets, les codes à 6 chiffres et les
 *    messages des formulaires ne peuvent pas être relus. Qui possède les deux fichiers possède tout.
 * Ne sont pas sauvegardés : fichiers temporaires, cache des dépendances, sockets (tout se recrée).
 *
 * La restauration ne se fait que dans un dossier vide (rien n'est jamais écrasé) et vérifie tout avant de finir :
 * contenu de l'archive, empreintes, correspondance de la clé, intégrité de la base, données chiffrées lisibles.
 */

const FORMAT = 'paginity-sauvegarde';
const EXCLUS = new Set(['temporaire', 'cache', 'x', 'coffre', 'sauvegardes']);

interface Fiche {
  format: string;
  version: 1;
  creeLe: string;
  dossierOrigine: string;
  versionDonnees: number;
  empreinteCle: string;
  fichiers: Record<string, string>;
}

const sha256 = (buf: Buffer | string) => crypto.createHash('sha256').update(buf).digest('hex');
/** Empreinte d'un fichier lue par morceaux : le serveur continue de répondre pendant le calcul. */
function sha256File(f: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(f)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}
/** Commande lancée sans bloquer le serveur (les sites restent accessibles pendant une sauvegarde). */
const lancer = promisify(execFile);
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** Fichiers ordinaires (pas les liens) sous un dossier, en chemins relatifs à « base ». */
function walk(base: string, rel: string, out: string[] = []): string[] {
  const abs = path.join(base, rel);
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(base, r, out);
    else if (e.isFile()) out.push(r);
  }
  return out;
}

export async function sauvegarder(dataDir: string, db: DatabaseSync, destDir: string, opts: { sansCle?: boolean } = {}): Promise<{ archive: string; cle: string | null; fichiers: number }> {
  if (fs.existsSync(path.join(dataDir, 'coffre', 'cle-maitre.nouvelle'))) {
    throw new UserError(409, 'Un changement de la clé du coffre est inachevé : lancez d’abord « paginity-admin changer-cle --confirmer ».');
  }
  const dest = path.resolve(destDir);
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  if (dest === path.resolve(dataDir) || dest.startsWith(path.resolve(dataDir) + path.sep)) {
    if (!dest.startsWith(path.join(path.resolve(dataDir), 'sauvegardes'))) throw new UserError(400, 'Choisissez un dossier de destination hors des données de PAGINITY (ou leur sous-dossier « sauvegardes »).');
  }
  const nom = `paginity-sauvegarde-${stamp()}`;
  const archive = path.join(dest, `${nom}.tar.gz`);
  const cleOut = path.join(dest, `paginity-cle-coffre-${stamp()}.txt`);
  if (fs.existsSync(archive) || (!opts.sansCle && fs.existsSync(cleOut))) throw new UserError(400, 'Une sauvegarde porte déjà ce nom : réessayez dans une seconde (rien n’est écrasé).');

  const travail = fs.mkdtempSync(path.join(dest, '.preparation-'));
  try {
    // 1. Base : copie cohérente, même PAGINITY allumé.
    db.prepare('VACUUM INTO ?').run(path.join(travail, 'base.db'));
    const versionDonnees = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    // 2. Fichiers à emporter (hors base, clé et éléments recréables).
    const racines = fs.readdirSync(dataDir).filter((n) => !EXCLUS.has(n) && fs.statSync(path.join(dataDir, n)).isDirectory());
    const fichiers: Record<string, string> = { 'base.db': await sha256File(path.join(travail, 'base.db')) };
    for (const r of racines) {
      for (const f of walk(dataDir, r)) {
        if (/^plateforme\/paginity\.db(-wal|-shm)?$/.test(f)) continue;
        fichiers[f] = await sha256File(path.join(dataDir, f));
      }
    }
    const cle = fs.readFileSync(path.join(dataDir, 'coffre', 'cle-maitre'), 'utf8').trim();
    const fiche: Fiche = { format: FORMAT, version: 1, creeLe: new Date().toISOString(), dossierOrigine: path.resolve(dataDir), versionDonnees, empreinteCle: sha256(cle), fichiers };
    fs.writeFileSync(path.join(travail, 'sauvegarde.json'), JSON.stringify(fiche));
    // 3. Archive : fiche + base, puis les dossiers de données (liens « en ligne » compris).
    const exclusions = ['--exclude=plateforme/paginity.db', '--exclude=plateforme/paginity.db-wal', '--exclude=plateforme/paginity.db-shm'];
    const partiel = `${archive}.partiel`;
    await lancer('tar', ['-czf', partiel, '-C', travail, 'sauvegarde.json', 'base.db', ...exclusions, '-C', dataDir, ...racines], { maxBuffer: 16 * 1024 * 1024 });
    fs.chmodSync(partiel, 0o600);
    fs.renameSync(partiel, archive);
    let cleEcrite: string | null = null;
    if (!opts.sansCle) {
      fs.writeFileSync(cleOut, `${cle}\n`, { mode: 0o600, flag: 'wx' });
      cleEcrite = cleOut;
    }
    return { archive, cle: cleEcrite, fichiers: Object.keys(fichiers).length };
  } finally {
    fs.rmSync(travail, { recursive: true, force: true });
  }
}

/** Liste et contrôle le contenu d'une archive AVANT de l'extraire. */
async function controlerArchive(archive: string): Promise<void> {
  let liste: string;
  try {
    liste = (await lancer('tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })).stdout;
  } catch {
    throw new UserError(400, 'Archive illisible ou incomplète (fichier tronqué ou abîmé).');
  }
  for (const ligne of liste.split('\n').filter(Boolean)) {
    const type = ligne[0];
    const m = /^\S+\s+\S+\s+\d+\s+\S+\s+\S+\s+(.*)$/.exec(ligne);
    let nom = m ? m[1] : '';
    if (type === 'l') nom = nom.split(' -> ')[0];
    const parties = nom.replace(/\/$/, '').split('/');
    if (!nom || nom.startsWith('/') || parties.includes('..')) throw new UserError(400, `Archive refusée : chemin dangereux (${nom}).`);
    if (!['-', 'd', 'l'].includes(type)) throw new UserError(400, `Archive refusée : élément d'un type inattendu (${nom}).`);
    if (!['sauvegarde.json', 'base.db', 'plateforme', 'espaces'].includes(parties[0])) throw new UserError(400, `Archive refusée : élément inattendu (${nom}).`);
    // Seuls liens permis : « en-ligne » et « apercu » d'un site (espaces/<espace>/sites/<site>/en-ligne).
    if (type === 'l' && !(parties.length === 5 && parties[0] === 'espaces' && parties[2] === 'sites' && ['en-ligne', 'apercu'].includes(parties[4]))) {
      throw new UserError(400, `Archive refusée : lien inattendu (${nom}).`);
    }
  }
}

export async function restaurer(archiveIn: string, cleFichier: string, dataDir: string): Promise<{ sites: number; fichiers: number; fiche: Omit<Fiche, 'fichiers'> }> {
  const archive = path.resolve(archiveIn);
  const cible = path.resolve(dataDir);
  if (!fs.existsSync(archive)) throw new UserError(404, `Archive introuvable : ${archive}`);
  if (!fs.existsSync(cleFichier)) throw new UserError(404, `Fichier de clé introuvable : ${cleFichier}`);
  if (fs.existsSync(cible) && fs.readdirSync(cible).length) {
    throw new UserError(400, `Le dossier ${cible} n’est pas vide : la restauration ne se fait que dans un dossier vide (rien n’est jamais écrasé).`);
  }
  const cle = fs.readFileSync(cleFichier, 'utf8').trim();
  if (Buffer.from(cle, 'base64').length !== 32) throw new UserError(400, 'Ce fichier ne contient pas une clé du coffre valide.');

  await controlerArchive(archive);
  fs.mkdirSync(path.dirname(cible), { recursive: true });
  const travail = fs.mkdtempSync(`${cible}.restauration-`);
  try {
    await lancer('tar', ['-xzf', archive, '-C', travail, '--no-same-owner']);
    const fiche = JSON.parse(fs.readFileSync(path.join(travail, 'sauvegarde.json'), 'utf8')) as Fiche;
    if (fiche.format !== FORMAT || fiche.version !== 1) throw new UserError(400, 'Ce fichier n’est pas une sauvegarde PAGINITY reconnue.');
    if (sha256(cle) !== fiche.empreinteCle) throw new UserError(400, 'Cette clé ne correspond pas à cette sauvegarde : prenez le fichier de clé enregistré avec elle.');
    // Empreintes : chaque fichier doit être présent et identique ; aucun fichier en plus.
    const presents = new Set(walk(travail, '').filter((f) => f !== 'sauvegarde.json'));
    for (const [f, h] of Object.entries(fiche.fichiers)) {
      if (!presents.has(f)) throw new UserError(400, `Sauvegarde incomplète : ${f} manque.`);
      if ((await sha256File(path.join(travail, f))) !== h) throw new UserError(400, `Sauvegarde abîmée : ${f} a été modifié.`);
      presents.delete(f);
    }
    if (presents.size) throw new UserError(400, `Sauvegarde refusée : fichiers non prévus (${[...presents].slice(0, 3).join(', ')}).`);

    // Base et clé à leur place.
    fs.mkdirSync(path.join(travail, 'plateforme'), { recursive: true, mode: 0o700 });
    fs.renameSync(path.join(travail, 'base.db'), path.join(travail, 'plateforme', 'paginity.db'));
    fs.rmSync(path.join(travail, 'sauvegarde.json'));
    fs.mkdirSync(path.join(travail, 'coffre'), { mode: 0o700 });
    fs.writeFileSync(path.join(travail, 'coffre', 'cle-maitre'), cle, { mode: 0o600 });

    // Contrôles : base intacte, données chiffrées lisibles avec cette clé.
    const db = new DatabaseSync(path.join(travail, 'plateforme', 'paginity.db'));
    let nbSites = 0;
    try {
      const integ = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
      if (integ.length !== 1 || integ[0].integrity_check !== 'ok') throw new UserError(400, 'La base de la sauvegarde est abîmée.');
      const vault = new Vault(travail);
      const chiffres = [
        ...(db.prepare('SELECT value_enc AS v FROM site_secrets').all() as { v: string }[]),
        ...(db.prepare('SELECT totp_secret_enc AS v FROM users WHERE totp_secret_enc IS NOT NULL').all() as { v: string }[]),
        ...(db.prepare('SELECT data_enc AS v FROM form_submissions').all() as { v: string }[]),
      ];
      for (const r of chiffres) {
        try {
          vault.decrypt(r.v);
        } catch {
          throw new UserError(400, 'Des données chiffrées ne s’ouvrent pas avec cette clé.');
        }
      }
      nbSites = (db.prepare('SELECT COUNT(*) AS n FROM sites').get() as { n: number }).n;
    } finally {
      db.close();
    }

    // Liens « en ligne » / « aperçu » : ils pointaient vers l'ancien emplacement des données.
    const espaces = path.join(travail, 'espaces');
    if (fs.existsSync(espaces)) {
      for (const esp of fs.readdirSync(espaces)) {
        const sitesDir = path.join(espaces, esp, 'sites');
        if (!fs.existsSync(sitesDir)) continue;
        for (const s of fs.readdirSync(sitesDir)) {
          for (const nom of ['en-ligne', 'apercu']) {
            const lien = path.join(sitesDir, s, nom);
            let ancien: string;
            try {
              ancien = fs.readlinkSync(lien);
            } catch {
              continue;
            }
            const rel = path.relative(path.join(fiche.dossierOrigine, 'espaces', esp, 'sites', s), path.resolve(path.dirname(path.join(fiche.dossierOrigine, 'espaces', esp, 'sites', s, nom)), ancien));
            fs.rmSync(lien);
            if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
              const nouveau = path.join(cible, 'espaces', esp, 'sites', s, rel);
              if (fs.existsSync(path.join(sitesDir, s, rel))) fs.symlinkSync(nouveau, lien);
            }
          }
        }
      }
    }

    fs.chmodSync(travail, 0o700);
    if (fs.existsSync(cible)) fs.rmdirSync(cible);
    fs.renameSync(travail, cible);
    const { fichiers, ...reste } = fiche;
    return { sites: nbSites, fichiers: Object.keys(fichiers).length, fiche: reste };
  } catch (e) {
    fs.rmSync(travail, { recursive: true, force: true });
    throw e;
  }
}
