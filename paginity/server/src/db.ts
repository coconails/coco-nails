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
