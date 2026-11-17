import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import type { Ctx } from '../context.js';
import { getSetting, setSetting } from '../db.js';
import { raiseAlert } from './alerts.js';
import { audit } from './audit.js';
import { UserError } from './util.js';
import { restaurer, sauvegarder } from '../cli/sauvegarde.js';
import { heureLocale, jourLocal } from './fuseau.js';

/**
 * Sauvegarde automatique, chiffrée, hors de la machine.
 *
 * Chaque nuit, PAGINITY fait une sauvegarde complète (base, sites, historiques, messages ET clé du coffre), la chiffre
 * avec une clé tirée de VOTRE phrase de sauvegarde (scrypt + AES-256-GCM) et la dépose dans un dossier de votre choix :
 * dossier synchronisé avec un service en ligne (Google Drive pour ordinateur, OneDrive…), disque USB, partage réseau.
 * Un fichier = tout ce qu'il faut pour tout reconstruire, mais illisible sans la phrase : le service en ligne ne voit rien.
 *
 * Une fois par mois, PAGINITY rouvre la dernière sauvegarde et la restaure « pour de faux » dans un dossier temporaire,
 * avec toutes les vérifications de la vraie restauration. Si quelque chose cloche : alerte critique (e-mail).
 *
 * La phrase n'est jamais enregistrée : seule la clé qui en est tirée l'est, chiffrée dans le coffre. Perdre la phrase,
 * c'est ne plus pouvoir ouvrir ces sauvegardes (les sauvegardes manuelles restent possibles).
 */

/** Commandes lancées sans bloquer le serveur. */
const lancer = promisify(execFile);
const ENTETE = 'PAGINITY-SAUVEGARDE-CHIFFREE 1';
const EXT = '.paginity';
const PREFIXE = 'paginity-auto-';
const SCRYPT = { N: 2 ** 15, r: 8, p: 1 };
const ESSAI_TOUS_LES_JOURS = 30;

export interface ReglagesSauvegarde {
  active: boolean;
  dossier: string;
  /** Heure de Paris (0 à 23), quel que soit le réglage du système. */
  heure: number;
  /** Nombre de sauvegardes gardées dans le dossier. */
  garder: number;
}
interface Etat {
  derniere: null | { le: number; fichier: string; octets: number; ok: boolean; message: string; duree: number };
  dernierEssai: null | { le: number; fichier: string; ok: boolean; message: string };
  /** Jour de la dernière sauvegarde programmée (les sauvegardes « maintenant » ne comptent pas). */
  dernierAutoJour?: string;
}
const DEFAUT: ReglagesSauvegarde = { active: false, dossier: '', heure: 3, garder: 14 };

const lire = <T>(ctx: Ctx, cle: string, defaut: T): T => {
  try {
    return { ...defaut, ...JSON.parse(getSetting(ctx.db, cle) ?? '{}') };
  } catch (e) {
    // Ne jamais laisser la sauvegarde s'arrêter en silence : on prévient.
    console.error(`[sauvegarde] réglage « ${cle} » illisible :`, (e as Error).message);
    raiseAlert(ctx, 'critique', `Les réglages de la sauvegarde automatique sont illisibles (${cle}) : vérifiez-les dans les Réglages de la plateforme.`);
    return defaut;
  }
};
const stamp = (d = new Date()) => d.toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 18);

/** Clé tirée d'une phrase (lente exprès, pour décourager les essais au hasard). */
function deriver(phrase: string, sel: Buffer, p = SCRYPT): Buffer {
  return crypto.scryptSync(phrase.normalize('NFC'), sel, 32, { ...p, maxmem: 128 * p.N * p.r * 2 });
}

/** Chiffre `entree` vers `sortie` : entête + données chiffrées + étiquette d'intégrité (16 octets). */
async function chiffrer(entree: string, sortie: string, cle: Buffer, sel: Buffer): Promise<void> {
  const iv = crypto.randomBytes(12);
  const meta = { sel: sel.toString('base64'), ...SCRYPT, iv: iv.toString('base64'), creeLe: new Date().toISOString() };
  fs.writeFileSync(sortie, `${ENTETE}\n${JSON.stringify(meta)}\n`, { mode: 0o600, flag: 'wx' });
  const c = crypto.createCipheriv('aes-256-gcm', cle, iv);
  await pipeline(fs.createReadStream(entree), c, fs.createWriteStream(sortie, { flags: 'a' }));
  fs.appendFileSync(sortie, c.getAuthTag());
}

/** Lit l'entête d'un fichier chiffré. */
function entete(fichier: string): { meta: { sel: string; N: number; r: number; p: number; iv: string; creeLe: string }; debut: number } {
  const fd = fs.openSync(fichier, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const txt = buf.subarray(0, n).toString('latin1');
    const l1 = txt.indexOf('\n');
    const l2 = txt.indexOf('\n', l1 + 1);
    if (l1 < 0 || l2 < 0 || txt.slice(0, l1) !== ENTETE) throw new UserError(400, 'Ce fichier n’est pas une sauvegarde chiffrée de PAGINITY.');
    return { meta: JSON.parse(txt.slice(l1 + 1, l2)), debut: l2 + 1 };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Déchiffre une sauvegarde automatique dans `dossier` : on y retrouve l'archive .tar.gz et le fichier de clé du coffre,
 * prêts pour « paginity-admin restaurer ». `cleOuPhrase` : la phrase de sauvegarde (ou la clé déjà tirée).
 */
export async function ouvrirSauvegarde(fichier: string, cleOuPhrase: string | Buffer, dossier: string): Promise<{ archive: string; cle: string; creeLe: string }> {
  const { meta, debut } = entete(fichier);
  const cle = Buffer.isBuffer(cleOuPhrase) ? cleOuPhrase : deriver(cleOuPhrase, Buffer.from(meta.sel, 'base64'), { N: meta.N, r: meta.r, p: meta.p });
  const taille = fs.statSync(fichier).size;
  if (taille < debut + 16) throw new UserError(400, 'Sauvegarde tronquée (fichier incomplet).');
  const etiquette = Buffer.alloc(16);
  const fd = fs.openSync(fichier, 'r');
  fs.readSync(fd, etiquette, 0, 16, taille - 16);
  fs.closeSync(fd);
  fs.mkdirSync(dossier, { recursive: true, mode: 0o700 });
  const tar = path.join(dossier, '.dechiffre.tar');
  const d = crypto.createDecipheriv('aes-256-gcm', cle, Buffer.from(meta.iv, 'base64'));
  d.setAuthTag(etiquette);
  try {
    if (taille - 16 > debut) await pipeline(fs.createReadStream(fichier, { start: debut, end: taille - 17 }), d, fs.createWriteStream(tar, { mode: 0o600 }));
    else {
      d.final();
      fs.writeFileSync(tar, '');
    }
  } catch {
    fs.rmSync(tar, { force: true });
    throw new UserError(400, 'Impossible d’ouvrir cette sauvegarde : phrase incorrecte, ou fichier abîmé.');
  }
  try {
    const noms = (await lancer('tar', ['-tf', tar], { encoding: 'utf8' })).stdout.split('\n').filter(Boolean);
    if (noms.length !== 2 || noms.some((n) => n.includes('/') || !/^paginity-(sauvegarde|cle-coffre)-[\d-]+\.(tar\.gz|txt)$/.test(n))) {
      throw new UserError(400, 'Contenu inattendu dans la sauvegarde.');
    }
    await lancer('tar', ['-xf', tar, '-C', dossier, '--no-same-owner']);
    return {
      archive: path.join(dossier, noms.find((n) => n.endsWith('.tar.gz'))!),
      cle: path.join(dossier, noms.find((n) => n.endsWith('.txt'))!),
      creeLe: meta.creeLe,
    };
  } finally {
    fs.rmSync(tar, { force: true });
  }
}

export class SauvegardeAuto {
  private enCours: null | 'sauvegarde' | 'essai' = null;
  private dernierJour = '';
  constructor(private ctx: Ctx) {}

  reglages(): ReglagesSauvegarde {
    return lire(this.ctx, 'sauvegarde_auto', DEFAUT);
  }
  private etat(): Etat {
    return lire<Etat>(this.ctx, 'sauvegarde_auto_etat', { derniere: null, dernierEssai: null });
  }
  private ecrireEtat(e: Partial<Etat>) {
    setSetting(this.ctx.db, 'sauvegarde_auto_etat', JSON.stringify({ ...this.etat(), ...e }));
  }
  private cle(): { cle: Buffer; sel: Buffer } | null {
    const v = getSetting(this.ctx.db, 'sauvegarde_auto_cle');
    if (!v) return null;
    const o = JSON.parse(this.ctx.vault.decrypt(v)) as { cle: string; sel: string };
    return { cle: Buffer.from(o.cle, 'base64'), sel: Buffer.from(o.sel, 'base64') };
  }

  /** Ce que voit le propriétaire (jamais la clé). */
  resume() {
    const r = this.reglages();
    let fichiers: { nom: string; octets: number; le: number }[] = [];
    try {
      if (r.dossier) fichiers = this.fichiers(r.dossier).map((f) => ({ nom: path.basename(f), octets: fs.statSync(f).size, le: fs.statSync(f).mtimeMs })).reverse();
    } catch {
      /* dossier absent : signalé par « dossierOk » */
    }
    return { reglages: r, phrase: !!getSetting(this.ctx.db, 'sauvegarde_auto_cle'), dossierOk: r.dossier ? this.dossierUtilisable(r.dossier) === null : false, enCours: this.enCours, ...this.etat(), fichiers };
  }

  private dossierUtilisable(dossier: string): string | null {
    if (!path.isAbsolute(dossier)) return 'Indiquez le chemin complet du dossier (par exemple /media/disque/sauvegardes ou D:\\Sauvegardes).';
    const d = path.resolve(dossier);
    const data = path.resolve(this.ctx.config.dataDir);
    if (d === data || d.startsWith(data + path.sep)) return 'Choisissez un dossier HORS des données de PAGINITY (sinon une panne de disque emporte tout).';
    try {
      if (!fs.statSync(d).isDirectory()) return 'Ce chemin n’est pas un dossier.';
      fs.accessSync(d, fs.constants.W_OK);
    } catch {
      return 'Dossier introuvable ou impossible d’y écrire (disque branché ? dossier synchronisé créé ?).';
    }
    return null;
  }

  modifier(input: Record<string, unknown>): ReturnType<SauvegardeAuto['resume']> {
    const r = { ...this.reglages() };
    if (input.dossier !== undefined) r.dossier = String(input.dossier ?? '').trim();
    if (input.heure !== undefined) {
      const h = Number(input.heure);
      if (!Number.isInteger(h) || h < 0 || h > 23) throw new UserError(400, 'Heure entre 0 et 23.');
      r.heure = h;
    }
    if (input.garder !== undefined) {
      const g = Number(input.garder);
      if (!Number.isInteger(g) || g < 1 || g > 90) throw new UserError(400, 'Nombre de sauvegardes gardées : entre 1 et 90.');
      r.garder = g;
    }
    if (input.active !== undefined) r.active = input.active === true;
    if (r.active) {
      const pb = this.dossierUtilisable(r.dossier);
      if (pb) throw new UserError(400, pb);
      if (!getSetting(this.ctx.db, 'sauvegarde_auto_cle')) throw new UserError(400, 'Choisissez d’abord une phrase de sauvegarde.');
    }
    setSetting(this.ctx.db, 'sauvegarde_auto', JSON.stringify(r));
    return this.resume();
  }

  /** Nouvelle phrase : les sauvegardes suivantes l'utiliseront (les anciennes gardent l'ancienne). */
  definirPhrase(phrase: unknown) {
    const p = typeof phrase === 'string' ? phrase.trim() : '';
    if (p.length < 16 || new Set(p).size < 6) throw new UserError(400, 'Phrase de sauvegarde trop courte : au moins 16 caractères variés (par exemple quatre mots sans rapport).');
    const sel = crypto.randomBytes(16);
    const cle = deriver(p, sel);
    setSetting(this.ctx.db, 'sauvegarde_auto_cle', this.ctx.vault.encrypt(JSON.stringify({ cle: cle.toString('base64'), sel: sel.toString('base64') })));
    return this.resume();
  }

  private fichiers(dossier: string): string[] {
    return fs
      .readdirSync(dossier)
      .filter((n) => n.startsWith(PREFIXE) && n.endsWith(EXT))
      .sort()
      .map((n) => path.join(dossier, n));
  }

  /** Une sauvegarde maintenant. Renvoie le fichier créé. */
  async sauvegarder(): Promise<{ fichier: string; octets: number }> {
    if (this.enCours) throw new UserError(409, 'Une sauvegarde ou un essai est déjà en cours.');
    const r = this.reglages();
    const pb = this.dossierUtilisable(r.dossier);
    if (pb) throw new UserError(400, pb);
    const k = this.cle();
    if (!k) throw new UserError(400, 'Choisissez d’abord une phrase de sauvegarde.');
    this.enCours = 'sauvegarde';
    const t0 = Date.now();
    const travail = path.join(this.ctx.config.dataDir, 'sauvegardes', `.auto-${crypto.randomBytes(4).toString('hex')}`);
    const final = path.join(r.dossier, `${PREFIXE}${stamp()}${EXT}`);
    try {
      const s = await sauvegarder(this.ctx.config.dataDir, this.ctx.db, travail);
      const tar = path.join(travail, 'tout.tar');
      await lancer('tar', ['-cf', tar, '-C', travail, path.basename(s.archive), path.basename(s.cle!)]);
      fs.rmSync(s.archive);
      fs.rmSync(s.cle!);
      // Écrit d'abord sous un autre nom : un fichier « .paginity » est toujours complet.
      const partiel = `${final}.partiel`;
      await chiffrer(tar, partiel, k.cle, k.sel);
      fs.renameSync(partiel, final);
      const octets = fs.statSync(final).size;
      // On ne garde que les N plus récentes (et seulement nos fichiers).
      const tous = this.fichiers(r.dossier);
      for (const f of tous.slice(0, Math.max(0, tous.length - r.garder))) fs.rmSync(f, { force: true });
      this.ecrireEtat({ derniere: { le: Date.now(), fichier: path.basename(final), octets, ok: true, message: 'Sauvegarde terminée.', duree: Date.now() - t0 } });
      audit(this.ctx.db, { action: 'sauvegarde_auto', details: { fichier: path.basename(final), octets } });
      return { fichier: final, octets };
    } catch (e) {
      fs.rmSync(`${final}.partiel`, { force: true });
      const message = e instanceof UserError ? e.message : `Erreur : ${(e as Error).message}`;
      this.ecrireEtat({ derniere: { le: Date.now(), fichier: '', octets: 0, ok: false, message, duree: Date.now() - t0 } });
      raiseAlert(this.ctx, 'critique', `La sauvegarde automatique a échoué : ${message}`);
      throw e;
    } finally {
      fs.rmSync(travail, { recursive: true, force: true });
      this.enCours = null;
    }
  }

  /**
   * Essai de restauration : la dernière sauvegarde est rouverte et restaurée dans un dossier temporaire, avec toutes
   * les vérifications de la vraie restauration (empreintes, clé, base, données chiffrées lisibles), puis effacée.
   */
  async essayerRestauration(): Promise<{ ok: boolean; message: string }> {
    if (this.enCours) throw new UserError(409, 'Une sauvegarde ou un essai est déjà en cours.');
    const r = this.reglages();
    const k = this.cle();
    const dernier = r.dossier && this.dossierUtilisable(r.dossier) === null ? this.fichiers(r.dossier).at(-1) : undefined;
    if (!dernier || !k) throw new UserError(400, 'Aucune sauvegarde automatique à essayer pour l’instant.');
    this.enCours = 'essai';
    const travail = path.join(this.ctx.config.dataDir, 'sauvegardes', `.essai-${crypto.randomBytes(4).toString('hex')}`);
    try {
      const o = await ouvrirSauvegarde(dernier, k.cle, path.join(travail, 'fichiers'));
      const res = await restaurer(o.archive, o.cle, path.join(travail, 'restaure'));
      const message = `Restauration d’essai réussie : ${res.sites} site(s), ${res.fichiers} fichiers vérifiés.`;
      this.ecrireEtat({ dernierEssai: { le: Date.now(), fichier: path.basename(dernier), ok: true, message } });
      audit(this.ctx.db, { action: 'sauvegarde_essai', details: { fichier: path.basename(dernier), ok: true } });
      return { ok: true, message };
    } catch (e) {
      const message = e instanceof UserError ? e.message : `Erreur : ${(e as Error).message}`;
      this.ecrireEtat({ dernierEssai: { le: Date.now(), fichier: path.basename(dernier), ok: false, message } });
      raiseAlert(this.ctx, 'critique', `L’essai de restauration de la sauvegarde ${path.basename(dernier)} a échoué : ${message}`);
      return { ok: false, message };
    } finally {
      fs.rmSync(travail, { recursive: true, force: true });
      this.enCours = null;
    }
  }

  /** Appelé régulièrement : sauvegarde à l'heure choisie, essai de restauration tous les 30 jours. */
  async tic(maintenant = new Date()): Promise<void> {
    const r = this.reglages();
    if (!r.active || this.enCours) return;
    const jour = jourLocal(maintenant);
    const e = this.etat();
    if (heureLocale(maintenant) !== r.heure || this.dernierJour === jour || e.dernierAutoJour === jour) return;
    this.dernierJour = jour;
    this.ecrireEtat({ dernierAutoJour: jour });
    try {
      await this.sauvegarder();
    } catch {
      return; // alerte déjà envoyée
    }
    if (!e.dernierEssai || maintenant.getTime() - e.dernierEssai.le > ESSAI_TOUS_LES_JOURS * 86_400_000) await this.essayerRestauration();
  }
}
