import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig } from '../config.js';
import { openDb, type Db } from '../db.js';
import { Vault } from '../lib/vault.js';
import { audit } from '../lib/audit.js';
import { checkPasswordPolicy, hashPassword } from '../auth/passwords.js';
import { UserError } from '../lib/util.js';
import { restaurer, sauvegarder } from './sauvegarde.js';
import { changerCle, enMarche } from './rotation.js';
import { ouvrirSauvegarde } from '../lib/sauvegarde-auto.js';

/**
 * paginity-admin : outil de secours, à lancer sur la machine elle-même (clavier/écran ou SSH).
 * Sert quand l'interface web n'est plus accessible : compte bloqué, téléphone perdu, mot de passe oublié…
 * Il agit directement sur les données (PAGINITY peut rester allumé). Chaque action est notée dans le journal.
 * Aucun mot de passe n'est jamais passé sur la ligne de commande : il est demandé au clavier.
 */

const AIDE = `paginity-admin — outil de secours de PAGINITY

Utilisation : paginity-admin <commande> [options]

  etat                          Résumé : version des données, comptes, sites, blocages en cours.
  verifier                      Contrôle de la base, de la clé du coffre et des dossiers des sites.
  debloquer [e-mail]            Lève les blocages après erreurs de connexion (tous, ou ceux d'un compte).
  fermer-sessions <e-mail>      Déconnecte ce compte partout.
  mot-de-passe <e-mail>         Choisit un nouveau mot de passe (demandé deux fois au clavier).
  reinitialiser-2fa <e-mail> --confirmer
                                Téléphone ET codes de secours perdus : supprime l'application de codes,
                                les passkeys et les codes de secours. La double authentification sera
                                à reconfigurer à la prochaine connexion (mot de passe exigé).
  activer <e-mail>              Réactive un compte désactivé.
  copie-base <fichier>          Copie cohérente de la base seule (même PAGINITY allumé).
  sauvegarder <dossier> [--sans-cle]
                                Sauvegarde COMPLÈTE (base, sites, historiques, versions, messages) dans
                                <dossier> : une archive .tar.gz et, à part, le fichier de la clé du coffre.
                                Rangez les deux à des endroits différents.
  restaurer <archive> --cle <fichier>
                                Restaure une sauvegarde dans PAGINITY_DATA_DIR, qui doit être vide (PAGINITY
                                arrêté). Tout est vérifié avant de finir (empreintes, clé, base).
  ouvrir-sauvegarde <fichier.paginity> <dossier>
                                Ouvre une sauvegarde AUTOMATIQUE (chiffrée) avec la phrase de sauvegarde
                                (demandée au clavier) : le dossier reçoit l'archive et le fichier de clé,
                                à donner ensuite à « restaurer ».
  changer-cle --confirmer       Change la clé du coffre (PAGINITY ARRÊTÉ) et rechiffre toutes les données
                                chiffrées. Termine aussi un changement interrompu. Faites ensuite une sauvegarde.
  aide                          Affiche cette aide.

Les données utilisées sont celles de PAGINITY_DATA_DIR (comme le serveur).`;

interface Out {
  log(s: string): void;
  err(s: string): void;
}

export async function main(argv: string[], out: Out = { log: (s) => console.log(s), err: (s) => console.error(s) }, askLine?: (q: string) => Promise<string>): Promise<number> {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === 'aide' || cmd === '--help' || cmd === '-h') {
    out.log(AIDE);
    return cmd ? 0 : 1;
  }
  const config = loadConfig();
  if (cmd === 'restaurer') {
    // Se fait dans un dossier vide : pas de base à ouvrir avant.
    try {
      const i = args.indexOf('--cle');
      const archive = args.find((a, k) => !a.startsWith('--') && k !== i + 1);
      if (!archive || i < 0 || !args[i + 1]) throw new UserError(400, 'Utilisation : paginity-admin restaurer <archive> --cle <fichier de clé>');
      const r = await restaurer(archive, args[i + 1], config.dataDir);
      const db = openDb(config.dataDir);
      audit(db, { action: 'secours_restauration', details: { archive: path.basename(archive), sauvegardeDu: r.fiche.creeLe } });
      db.close();
      out.log(`Restauration terminée dans ${config.dataDir} : ${r.sites} site(s), ${r.fichiers} fichiers vérifiés (sauvegarde du ${r.fiche.creeLe}).`);
      out.log('Lancez « paginity-admin verifier », puis démarrez PAGINITY.');
      return 0;
    } catch (e) {
      out.err(e instanceof UserError ? e.message : `Erreur : ${(e as Error).message}`);
      return 1;
    }
  }
  if (cmd === 'ouvrir-sauvegarde') {
    try {
      const [fichier, dossier] = args;
      if (!fichier || !dossier) throw new UserError(400, 'Utilisation : paginity-admin ouvrir-sauvegarde <fichier.paginity> <dossier>');
      if (!fs.existsSync(fichier)) throw new UserError(404, `Fichier introuvable : ${fichier}`);
      if (fs.existsSync(dossier) && fs.readdirSync(dossier).length) throw new UserError(400, `Le dossier ${dossier} n’est pas vide.`);
      const phrase = await (askLine ?? ((q: string) => askHidden(q)))('Phrase de sauvegarde : ');
      const o = await ouvrirSauvegarde(fichier, phrase, dossier);
      out.log(`Sauvegarde du ${o.creeLe} ouverte.`);
      out.log(`Pour tout remettre en place (PAGINITY arrêté, dossier de données vide) :`);
      out.log(`  paginity-admin restaurer ${o.archive} --cle ${o.cle}`);
      return 0;
    } catch (e) {
      out.err(e instanceof UserError ? e.message : `Erreur : ${(e as Error).message}`);
      return 1;
    }
  }
  if (!fs.existsSync(path.join(config.dataDir, 'plateforme', 'paginity.db'))) {
    out.err(`Aucune donnée PAGINITY dans ${config.dataDir} (vérifiez PAGINITY_DATA_DIR).`);
    return 2;
  }
  const db = openDb(config.dataDir);
  const ask = askLine ?? ((q: string) => askHidden(q));
  try {
    switch (cmd) {
      case 'etat':
        return etat(db, config.dataDir, out);
      case 'verifier':
        return verifier(db, config.dataDir, out);
      case 'debloquer': {
        const email = args[0]?.trim().toLowerCase();
        const r = email ? db.prepare('DELETE FROM login_attempts WHERE key = ?').run(`email:${email}`) : db.prepare('DELETE FROM login_attempts').run();
        if (email) {
          const u = userByEmail(db, email);
          if (u) db.prepare('DELETE FROM login_attempts WHERE key = ?').run(`confirmation:${u.id}`);
        }
        audit(db, { action: 'secours_debloquer', details: { compte: email ?? 'tous' } });
        out.log(`Blocages levés : ${Number(r.changes)}.`);
        return 0;
      }
      case 'fermer-sessions': {
        const u = requireUser(db, args[0]);
        const r = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
        audit(db, { userId: u.id, action: 'secours_fermer_sessions' });
        out.log(`${Number(r.changes)} session(s) fermée(s) pour ${u.email}.`);
        return 0;
      }
      case 'mot-de-passe': {
        const u = requireUser(db, args[0]);
        const a = await ask(`Nouveau mot de passe pour ${u.email} : `);
        const b = await ask('Retapez-le : ');
        if (a !== b) throw new UserError(400, 'Les deux saisies sont différentes. Rien n’a été changé.');
        checkPasswordPolicy(a, u.email);
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(a), u.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
        db.prepare('DELETE FROM login_attempts WHERE key = ?').run(`email:${u.email}`);
        audit(db, { userId: u.id, action: 'secours_mot_de_passe' });
        out.log(`Mot de passe changé pour ${u.email}. Toutes ses sessions ont été fermées.`);
        return 0;
      }
      case 'reinitialiser-2fa': {
        const u = requireUser(db, args[0]);
        if (!args.includes('--confirmer')) {
          out.err('Action importante : ajoutez --confirmer pour la lancer vraiment.');
          return 1;
        }
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled = 0, totp_last_step = 0 WHERE id = ?').run(u.id);
          db.prepare('DELETE FROM passkeys WHERE user_id = ?').run(u.id);
          db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(u.id);
          db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
          db.prepare('DELETE FROM login_challenges WHERE user_id = ?').run(u.id);
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        audit(db, { userId: u.id, action: 'secours_reinitialiser_2fa' });
        out.log(`Double authentification supprimée pour ${u.email}. À la prochaine connexion (mot de passe), elle devra être reconfigurée.`);
        return 0;
      }
      case 'activer': {
        const u = requireUser(db, args[0]);
        db.prepare('UPDATE users SET disabled = 0 WHERE id = ?').run(u.id);
        audit(db, { userId: u.id, action: 'secours_activer' });
        out.log(`Compte ${u.email} réactivé.`);
        return 0;
      }
      case 'copie-base': {
        const dest = args[0];
        if (!dest) throw new UserError(400, 'Indiquez le fichier de destination.');
        const abs = path.resolve(dest);
        if (fs.existsSync(abs)) throw new UserError(400, 'Ce fichier existe déjà : choisissez un autre nom (rien n’est écrasé).');
        db.prepare('VACUUM INTO ?').run(abs);
        fs.chmodSync(abs, 0o600);
        out.log(`Copie de la base écrite dans ${abs} (sans la clé du coffre : les secrets y restent chiffrés).`);
        return 0;
      }
      case 'changer-cle': {
        if (!args.includes('--confirmer')) {
          out.err('Action importante : arrêtez PAGINITY, puis relancez avec --confirmer.');
          return 1;
        }
        if (await enMarche(config.adminPort)) throw new UserError(409, 'PAGINITY est en marche : arrêtez-le avant de changer la clé du coffre (il garde l’ancienne clé en mémoire).');
        const r = changerCle(config.dataDir, db);
        audit(db, { action: 'secours_changer_cle', details: { resultat: r.action, valeurs: r.valeurs } });
        if (r.action === 'changee') {
          out.log(`Clé du coffre changée : ${r.valeurs} valeur(s) rechiffrée(s).`);
          out.log('→ Faites MAINTENANT une nouvelle sauvegarde (paginity-admin sauvegarder) : les anciennes sauvegardes ne s’ouvrent qu’avec l’ancienne clé, conservée avec elles.');
          out.log('→ Les appareils reconnus devront se reconnecter une fois avec mot de passe et code (ils redeviennent « nouveaux »).');
        } else if (r.action === 'terminee') out.log(`Changement de clé interrompu : terminé (${r.valeurs} valeur(s) déjà rechiffrées).`);
        else out.log('Changement de clé interrompu avant le rechiffrement : annulé, l’ancienne clé reste en service.');
        return 0;
      }
      case 'sauvegarder': {
        const dest = args.find((a) => !a.startsWith('--'));
        if (!dest) throw new UserError(400, 'Indiquez le dossier où ranger la sauvegarde.');
        const enCours = (db.prepare("SELECT COUNT(*) AS n FROM publications WHERE status = 'en_cours'").get() as { n: number }).n;
        if (enCours) out.err('Attention : une publication est en cours ; il est préférable de sauvegarder une fois terminée.');
        const r = await sauvegarder(config.dataDir, db, dest, { sansCle: args.includes('--sans-cle') });
        audit(db, { action: 'secours_sauvegarde', details: { archive: path.basename(r.archive), fichiers: r.fichiers } });
        out.log(`Sauvegarde : ${r.archive} (${r.fichiers} fichiers, empreintes notées).`);
        if (r.cle) out.log(`Clé du coffre : ${r.cle}\n→ Rangez la clé À PART de l’archive : qui possède les deux possède tout ; sans la clé, la sauvegarde est inutilisable.`);
        return 0;
      }
      default:
        out.err(`Commande inconnue : ${cmd}\n\n${AIDE}`);
        return 1;
    }
  } catch (e) {
    out.err(e instanceof UserError ? e.message : `Erreur : ${(e as Error).message}`);
    return 1;
  } finally {
    db.close();
  }
}

function userByEmail(db: Db, email: string): { id: string; email: string } | undefined {
  return db.prepare('SELECT id, email FROM users WHERE email = ?').get(email.trim().toLowerCase()) as { id: string; email: string } | undefined;
}

function requireUser(db: Db, email: string | undefined): { id: string; email: string } {
  if (!email) throw new UserError(400, 'Indiquez l’adresse e-mail du compte.');
  const u = userByEmail(db, email);
  if (!u) throw new UserError(404, `Aucun compte avec l’adresse ${email}.`);
  return u;
}

function etat(db: Db, dataDir: string, out: Out): number {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
  out.log(`Données          : ${dataDir}`);
  out.log(`Version des données : ${version}`);
  out.log(`Comptes          : ${n('SELECT COUNT(*) AS n FROM users')} (dont ${n('SELECT COUNT(*) AS n FROM users WHERE disabled = 1')} désactivé(s))`);
  out.log(`Sites            : ${n('SELECT COUNT(*) AS n FROM sites')}`);
  out.log(`Sessions ouvertes: ${n('SELECT COUNT(*) AS n FROM sessions')}`);
  const bloques = db.prepare('SELECT key, locked_until FROM login_attempts WHERE locked_until > ?').all(Date.now()) as { key: string; locked_until: number }[];
  out.log(`Blocages en cours: ${bloques.length}`);
  for (const b of bloques) out.log(`  - ${b.key} jusqu’à ${new Date(b.locked_until).toLocaleString('fr-FR')}`);
  out.log(`Publication en cours : ${n("SELECT COUNT(*) AS n FROM publications WHERE status = 'en_cours'")}`);
  return 0;
}

function verifier(db: Db, dataDir: string, out: Out): number {
  let problemes = 0;
  const ok = (cond: boolean, texte: string) => {
    out.log(`${cond ? 'OK      ' : 'PROBLÈME'} ${texte}`);
    if (!cond) problemes++;
  };
  const integ = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
  ok(integ.length === 1 && integ[0].integrity_check === 'ok', `Base de données intacte${integ[0]?.integrity_check === 'ok' ? '' : ` (${integ.map((r) => r.integrity_check).join('; ')})`}`);
  let vault: Vault | null = null;
  try {
    vault = new Vault(dataDir);
    ok(true, 'Clé du coffre lisible');
  } catch (e) {
    ok(false, `Clé du coffre illisible : ${(e as Error).message}`);
  }
  if (vault) {
    const row =
      (db.prepare('SELECT value_enc AS v FROM site_secrets LIMIT 1').get() as { v: string } | undefined) ??
      (db.prepare('SELECT totp_secret_enc AS v FROM users WHERE totp_secret_enc IS NOT NULL LIMIT 1').get() as { v: string } | undefined);
    if (row) {
      let dechiffre = true;
      try {
        vault.decrypt(row.v);
      } catch {
        dechiffre = false;
      }
      ok(dechiffre, dechiffre ? 'Les données chiffrées s’ouvrent avec cette clé' : 'Les données chiffrées NE s’ouvrent PAS avec cette clé (mauvaise clé du coffre ?)');
    }
  }
  const sites = db.prepare('SELECT id, space_id, slug, live_publication FROM sites').all() as { id: string; space_id: string; slug: string; live_publication: number | null }[];
  for (const s of sites) {
    const dir = path.join(dataDir, 'espaces', s.space_id, 'sites', s.id);
    ok(fs.existsSync(path.join(dir, 'source', '.git')), `Site « ${s.slug} » : historique présent`);
    if (s.live_publication) {
      let enLigne = false;
      try {
        enLigne = fs.existsSync(path.join(fs.realpathSync(path.join(dir, 'en-ligne')), 'index.html'));
      } catch {
        enLigne = false;
      }
      ok(enLigne, `Site « ${s.slug} » : version en ligne présente`);
    }
  }
  out.log(problemes ? `${problemes} problème(s) trouvé(s).` : 'Tout est en ordre.');
  return problemes ? 3 : 0;
}

/** Saisie sans affichage (mot de passe). */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    const anyRl = rl as unknown as { _writeToOutput?: (s: string) => void; output: NodeJS.WritableStream };
    if (process.stdin.isTTY) {
      anyRl._writeToOutput = (s: string) => {
        if (s.includes(question)) anyRl.output.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (process.stdin.isTTY) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
