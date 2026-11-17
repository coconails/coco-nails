import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Base interne de PAGINITY (un simple fichier SQLite).
 * Contient : utilisateurs, sessions, espaces, sites, rôles, publications, activités, journal d'audit.
 * Les sites eux-mêmes (code, contenus, médias) sont dans des dépôts Git, pas ici.
 */
export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_owner INTEGER NOT NULL DEFAULT 0,
    totp_secret_enc TEXT,
    totp_pending_enc TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    totp_last_step INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE recovery_codes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE passkeys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    mfa_ok INTEGER NOT NULL DEFAULT 0,
    sudo_until INTEGER NOT NULL DEFAULT 0,
    ip TEXT,
    user_agent TEXT,
    webauthn_challenge TEXT
  );
  CREATE TABLE login_challenges (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    webauthn_challenge TEXT
  );
  CREATE TABLE login_attempts (
    key TEXT PRIMARY KEY,
    failures INTEGER NOT NULL,
    first_at INTEGER NOT NULL,
    locked_until INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE invitations (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    roles TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sites (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces(id),
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    domains TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    live_publication INTEGER,
    last_publication_status TEXT
  );
  CREATE TABLE site_members (
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    PRIMARY KEY (site_id, user_id)
  );
  CREATE TABLE publications (
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    commit_hash TEXT,
    message TEXT,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    duration_ms INTEGER,
    warnings TEXT NOT NULL DEFAULT '[]',
    job_id TEXT,
    PRIMARY KEY (site_id, number)
  );
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    label TEXT NOT NULL,
    site_id TEXT,
    user_id TEXT,
    status TEXT NOT NULL,
    steps TEXT NOT NULL DEFAULT '[]',
    payload TEXT NOT NULL DEFAULT '{}',
    result TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
  );
  CREATE INDEX jobs_created ON jobs(created_at);
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    user_id TEXT,
    ip TEXT,
    action TEXT NOT NULL,
    site_id TEXT,
    details TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX audit_at ON audit(at);
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE preview_links (
    label TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE sites ADD COLUMN schedules_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sites ADD COLUMN notify_email TEXT;
  CREATE TABLE site_secrets (
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    env TEXT NOT NULL,
    name TEXT NOT NULL,
    value_enc TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT,
    PRIMARY KEY (site_id, env, name)
  );
  CREATE TABLE function_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    fn TEXT NOT NULL,
    kind TEXT NOT NULL,
    status INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    message TEXT
  );
  CREATE INDEX function_log_site ON function_log(site_id, at);
  CREATE TABLE schedule_settings (
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    fn TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    catch_up INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (site_id, fn)
  );
  CREATE TABLE schedule_runs (
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    fn TEXT NOT NULL,
    slot INTEGER NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    message TEXT,
    PRIMARY KEY (site_id, fn, slot)
  );
  CREATE TABLE form_submissions (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    form TEXT NOT NULL,
    at INTEGER NOT NULL,
    data_enc TEXT NOT NULL,
    read_at INTEGER
  );
  CREATE INDEX form_submissions_site ON form_submissions(site_id, at);
  CREATE TABLE alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    site_id TEXT,
    emailed_at INTEGER,
    read_at INTEGER
  );
  `,
  // 4 — PAGINITY AI : propositions de l'assistant et dépenses (ajout de tables seulement).
  `
  CREATE TABLE ia_propositions (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    demande TEXT NOT NULL,
    statut TEXT NOT NULL,
    cerveau TEXT,
    explication TEXT,
    raison TEXT,
    changements TEXT,
    empreinte TEXT,
    cout_centimes INTEGER NOT NULL DEFAULT 0,
    journal TEXT NOT NULL DEFAULT '[]',
    cree_le INTEGER NOT NULL,
    decide_le INTEGER
  );
  CREATE INDEX ia_propositions_site ON ia_propositions(site_id, cree_le);
  CREATE TABLE ia_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mois TEXT NOT NULL,
    at INTEGER NOT NULL,
    proposition_id TEXT,
    centimes INTEGER NOT NULL
  );
  CREATE INDEX ia_usage_mois ON ia_usage(mois);
  `,
  // 5 — PAGINITY AI : dépense par service extérieur (ajout de colonne seulement).
  `
  ALTER TABLE ia_usage ADD COLUMN fournisseur TEXT;
  `,
  // 6 — PAGINITY AI : domaine et déroulement de la réunion d'IA (ajout de colonne seulement).
  `
  ALTER TABLE ia_propositions ADD COLUMN reunion TEXT;
  `,
  // 7 — PAGINITY AI : versions écrites à l'acceptation (pour pouvoir annuler sans écraser autre chose).
  `
  ALTER TABLE ia_propositions ADD COLUMN versions_apres TEXT;
  `,
  // 8 — Aperçu d'une proposition de l'assistant : lien vers un dossier d'aperçu particulier.
  `
  ALTER TABLE preview_links ADD COLUMN racine TEXT;
  `,
  // 9 — Compteur de visites sans cookies : pages vues par jour, sans aucune donnée personnelle.
  `
  CREATE TABLE visites (
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    jour TEXT NOT NULL,
    chemin TEXT NOT NULL,
    vues INTEGER NOT NULL,
    PRIMARY KEY (site_id, jour, chemin)
  );
  `,
  // 10 — Notifications sur le téléphone (Web Push) : appareils abonnés.
  `
  CREATE TABLE push_abonnements (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    cree_le INTEGER NOT NULL
  );
  `,
  // 11 — Référencement (M1) : résultats des audits locaux, en lecture seule.
  `
  CREATE TABLE seo_audits (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    le INTEGER NOT NULL,
    cible TEXT NOT NULL,
    par TEXT,
    resultat TEXT NOT NULL
  );
  CREATE INDEX seo_audits_site ON seo_audits(site_id, le);
  `,
];

export function openDb(dataDir: string): Db {
  const dir = path.join(dataDir, 'plateforme');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dir, 'paginity.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      version += 1;
      db.prepare('UPDATE schema_version SET version = ?').run(version);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getSetting(db: Db, key: string): string | undefined {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
