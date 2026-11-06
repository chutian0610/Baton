import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/**
 * SQLite layer: one database file per data dir, WAL mode, and a linear
 * schema-version migration machinery driven by the `user_version` pragma.
 *
 * Later tickets append entries to MIGRATIONS; nothing else calls migrations
 * by hand. Opening an up-to-date database applies nothing.
 */
export type Db = Database.Database;

export interface Migration {
  /** Schema version this migration brings the database to; must be unique and increasing. */
  version: number;
  name: string;
  up: (db: Db) => void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'meta-table',
    up: (db) => {
      db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    },
  },
];

/** Opens (creating if needed) `<dataDir>/data.db` and brings its schema to the latest version. */
export function openDatabase(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'data.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const applied = schemaVersion(db);
  const pending = [...MIGRATIONS].sort((a, b) => a.version - b.version).filter((m) => m.version > applied);
  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}

export function schemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number;
}
