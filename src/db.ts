import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/**
 * SQLite layer: one database file per data dir, WAL mode, and a linear
 * schema-version migration machinery driven by the `user_version` pragma.
 *
 * Later changes append entries to MIGRATIONS; nothing else calls migrations
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
  {
    version: 2,
    name: 'projects',
    up: (db) => {
      // Paths are stored in canonical form (absolute, no trailing slash) and
      // are unique across projects: the PRIMARY KEY enforces "a path binds to
      // at most one project" (spec: Current Project resolution).
      db.exec(`
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE TABLE project_paths (
          path TEXT PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_project_paths_project ON project_paths(project_id);
      `);
    },
  },
  {
    version: 3,
    name: 'tasks',
    up: (db) => {
      // Tasks form a strictly single-parent tree (ADR-0004): parent_id is a
      // nullable self-reference, and a subtree always lives inside one project
      // (cross-project parents are rejected in the core layer before insert).
      // Status transitions are a later change; here every task is created
      // 'pending' and the CHECK keeps the column honest for that future.
      // Dependencies (deps) are a later change too — no deps table yet.
      db.exec(`
        CREATE TABLE tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'waiting', 'done', 'dropped')),
          project_id INTEGER NOT NULL REFERENCES projects(id),
          parent_id INTEGER REFERENCES tasks(id),
          due TEXT,
          priority TEXT CHECK (priority IS NULL OR priority IN ('H', 'M', 'L')),
          effort TEXT,
          hidden_until TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE TABLE task_tags (
          task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          tag TEXT NOT NULL,
          PRIMARY KEY (task_id, tag)
        );
        CREATE INDEX idx_tasks_project ON tasks(project_id);
        CREATE INDEX idx_tasks_parent ON tasks(parent_id);
      `);
    },
  },
  {
    version: 4,
    name: 'intervals',
    up: (db) => {
      // A recorded span of a task being active (glossary: Interval). Opened by
      // entering `active`, closed by leaving it or entering done/dropped
      // (ADR-0003: Intervals are the one piece of lifecycle data that IS
      // stored). The partial unique index enforces "at most one open Interval
      // per task" at the storage layer, below the status machine.
      db.exec(`
        CREATE TABLE intervals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          ended_at TEXT
        );
        CREATE UNIQUE INDEX idx_intervals_one_open_per_task ON intervals(task_id) WHERE ended_at IS NULL;
        CREATE INDEX idx_intervals_task ON intervals(task_id, started_at);
      `);
    },
  },
  {
    version: 5,
    name: 'annotations-and-change-log',
    up: (db) => {
      // Record-keeping (spec "Record-keeping" / CONTEXT.md): Annotations are
      // timestamped append-only notes on a task; the change log is the
      // append-only record of every mutation with its Actor. Both tables are
      // INSERT/SELECT only — there is no UPDATE or DELETE code path anywhere,
      // and tasks have no hard delete, so no ON DELETE action is declared.
      // The actor is stored as a JSON value (see src/actors.ts); the diff is a
      // JSON object {field: {before, after}}.
      db.exec(`
        CREATE TABLE annotations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL REFERENCES tasks(id),
          body TEXT NOT NULL,
          actor TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE INDEX idx_annotations_task ON annotations(task_id);
        CREATE TABLE change_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entity TEXT NOT NULL CHECK (entity IN ('task', 'project')),
          entity_id INTEGER NOT NULL,
          diff TEXT NOT NULL,
          actor TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE INDEX idx_change_log_entity ON change_log(entity, entity_id);
      `);
    },
  },
  {
    version: 6,
    name: 'task-deps',
    up: (db) => {
      // The Dependency DAG (ADR-0004: ordering lives in a directed graph
      // orthogonal to the parent/child tree). One row = one edge "task depends
      // on depends_on"; the pair is the primary key, so a dependency exists at
      // most once (deps are a set). The extra index serves the reverse lookup
      // (who depends on this task) used by cycle detection and blocked
      // derivation. Tasks have no hard delete, so — like annotations and the
      // change log — no ON DELETE action is declared. Cross-project edges,
      // self-edges, and cycles are rejected in the core layer (src/deps.ts)
      // before any row is written; blocked and progress are derived at read
      // time and never stored (ADR-0003).
      db.exec(`
        CREATE TABLE task_deps (
          task_id INTEGER NOT NULL REFERENCES tasks(id),
          depends_on INTEGER NOT NULL REFERENCES tasks(id),
          PRIMARY KEY (task_id, depends_on)
        );
        CREATE INDEX idx_task_deps_depends_on ON task_deps(depends_on);
      `);
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
