import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Vault } from '../lib/vault.js';
import { UserError } from '../lib/util.js';

/**
 * Changement de la clé du coffre (rotation), PAGINITY arrêté.
 * Toutes les valeurs chiffrées de la base (codes à 6 chiffres, secrets des sites, messages des formulaires,
 * mot de passe de messagerie…) sont rechiffrées avec une nouvelle clé, en une seule transaction.
 * Toute colonne contenant une valeur au format du coffre est traitée : un futur champ chiffré ne sera pas oublié.
 *
 * Sûr en cas de coupure : la nouvelle clé est d'abord écrite à côté (cle-maitre.nouvelle), puis la base est
 * rechiffrée, puis la nouvelle clé prend la place de l'ancienne. Si cela s'arrête au milieu, PAGINITY refuse de
 * démarrer et « paginity-admin changer-cle --confirmer » termine ou annule proprement selon l'état réel de la base.
 */

const FORMAT = /^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]*$/;

function lireCle(f: string): Buffer {
  const k = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'base64');
  if (k.length !== 32) throw new UserError(400, `Clé invalide dans ${f}.`);
  return k;
}

/** Toutes les valeurs au format du coffre : [table, colonne, rowid, valeur]. */
function valeursChiffrees(db: DatabaseSync): { table: string; col: string; rowid: number; v: string }[] {
  const out: { table: string; col: string; rowid: number; v: string }[] = [];
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  for (const { name } of tables) {
    const cols = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string; type: string }[];
    for (const c of cols.filter((x) => /TEXT/i.test(x.type))) {
      const rows = db.prepare(`SELECT rowid AS r, "${c.name}" AS v FROM "${name}" WHERE "${c.name}" LIKE 'v1.%'`).all() as { r: number; v: string }[];
      for (const row of rows) if (FORMAT.test(row.v)) out.push({ table: name, col: c.name, rowid: row.r, v: row.v });
    }
  }
  return out;
}

function ouvre(vault: Vault, v: string): boolean {
  try {
    vault.decrypt(v);
    return true;
  } catch {
    return false;
  }
}

/** PAGINITY répond-il sur son port d'administration ? (rotation interdite pendant qu'il tourne) */
export function enMarche(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.setTimeout(800);
    s.on('connect', () => (s.destroy(), resolve(true)));
    s.on('timeout', () => (s.destroy(), resolve(false)));
    s.on('error', () => resolve(false));
  });
}

export function changerCle(dataDir: string, db: DatabaseSync): { action: 'changee' | 'terminee' | 'annulee'; valeurs: number } {
  const dir = path.join(dataDir, 'coffre');
  const actuelleF = path.join(dir, 'cle-maitre');
  const nouvelleF = path.join(dir, 'cle-maitre.nouvelle');

  // Reprise d'un changement interrompu : on regarde quelle clé ouvre réellement la base.
  if (fs.existsSync(nouvelleF)) {
    const vals = valeursChiffrees(db);
    const nouvelle = Vault.fromKey(lireCle(nouvelleF));
    const ancienne = Vault.fromKey(lireCle(actuelleF));
    if (vals.length && vals.every((x) => ouvre(nouvelle, x.v))) {
      fs.renameSync(nouvelleF, actuelleF);
      return { action: 'terminee', valeurs: vals.length };
    }
    if (!vals.length || vals.every((x) => ouvre(ancienne, x.v))) {
      fs.rmSync(nouvelleF);
      return { action: 'annulee', valeurs: vals.length };
    }
    throw new UserError(500, 'État incohérent : certaines valeurs ne s’ouvrent ni avec l’ancienne ni avec la nouvelle clé. Ne supprimez aucun fichier du dossier « coffre » et restaurez la dernière sauvegarde si besoin.');
  }

  const ancienne = Vault.fromKey(lireCle(actuelleF));
  const cle = crypto.randomBytes(32);
  const nouvelle = Vault.fromKey(cle);
  const vals = valeursChiffrees(db);
  const illisibles = vals.filter((x) => !ouvre(ancienne, x.v));
  if (illisibles.length) throw new UserError(500, `${illisibles.length} valeur(s) ne s’ouvrent pas avec la clé actuelle : rotation annulée, rien n’a changé.`);

  fs.writeFileSync(nouvelleF, cle.toString('base64'), { mode: 0o600, flag: 'wx' });
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const x of vals) {
      db.prepare(`UPDATE "${x.table}" SET "${x.col}" = ? WHERE rowid = ?`).run(nouvelle.encrypt(ancienne.decrypt(x.v)), x.rowid);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    fs.rmSync(nouvelleF, { force: true });
    throw e;
  }
  fs.renameSync(nouvelleF, actuelleF);
  return { action: 'changee', valeurs: vals.length };
}
