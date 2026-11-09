import type { Actor } from './actors.js';
import type { Db } from './db.js';

/**
 * The Change Log (CONTEXT.md): the append-only record of every mutation to
 * every entity, with its Actor. Exactly one row per mutation, carrying a
 * field-level diff `{field: {before, after}}` — creation rows put every field
 * under `after` with `before: null`; update rows carry only the fields that
 * actually changed (absent -> value counts as a change).
 *
 * Append-only means append-only: this module INSERTs and SELECTs, and there
 * is deliberately no update, delete, or rollback path (spec: "No rollback
 * surface in v1").
 */

export type ChangeEntity = 'task' | 'project';

/** Field-level diff of one mutation: the changed fields and their values. */
export interface FieldDiff {
  [field: string]: { before: unknown; after: unknown };
}

/** A change-log row as exposed through the API surfaces. */
export interface ChangeLogView {
  id: number;
  entity: ChangeEntity;
  entityId: number;
  diff: FieldDiff;
  actor: Actor;
  createdAt: string;
}

interface ChangeLogRow {
  id: number;
  entity: ChangeEntity;
  entity_id: number;
  diff: string;
  actor: string;
  created_at: string;
}

/**
 * Appends one change-log row. Pure INSERT — the caller is responsible for
 * running it inside the same `db.transaction(...)` as the mutation itself, so
 * a change and its record commit or roll back together.
 */
export function recordChange(
  db: Db,
  entity: ChangeEntity,
  entityId: number,
  diff: FieldDiff,
  actor: Actor,
): void {
  db.prepare('INSERT INTO change_log (entity, entity_id, diff, actor) VALUES (?, ?, ?, ?)').run(
    entity,
    entityId,
    JSON.stringify(diff),
    JSON.stringify(actor),
  );
}

/**
 * Records a status transition (`before` -> `after`) on the change log.
 *
 * Wired into the task-lifecycle paths (the status machine): the lifecycle
 * change owns the mutation and calls this from inside its own transaction,
 * keeping "one mutation, one change-log row" true for transitions too.
 */
export function recordStatusChange(
  db: Db,
  taskId: number,
  before: string,
  after: string,
  actor: Actor,
): void {
  recordChange(db, 'task', taskId, { status: { before, after } }, actor);
}

/**
 * The most recent change-log rows for one entity, newest first (ids are
 * assigned monotonically, so `id DESC` is time order even within one
 * millisecond). `limit` defaults to the 20 rows `task_get` shows as
 * `recentChanges`.
 */
export function recentChanges(db: Db, entity: ChangeEntity, entityId: number, limit = 20): ChangeLogView[] {
  const rows = db
    .prepare('SELECT id, entity, entity_id, diff, actor, created_at FROM change_log WHERE entity = ? AND entity_id = ? ORDER BY id DESC LIMIT ?')
    .all(entity, entityId, limit) as ChangeLogRow[];
  return rows.map(asChangeView);
}

/** A page of one entity's full change history (user story: audit "what agents did"). */
export interface ChangeHistoryPage {
  /** The requested page of change-log rows, newest first. */
  changes: ChangeLogView[];
  /** Total change-log rows for the entity (across all pages). */
  total: number;
}

/**
 * The FULL change history for one entity, paged: newest-first rows plus the
 * total row count, so callers can page through everything (spec user story
 * 32). GET /tasks/:id/changes wraps this (default limit 100, offset 0);
 * `task_get`'s recentChanges stays the capped 20-row peek.
 */
export function listChanges(
  db: Db,
  entity: ChangeEntity,
  entityId: number,
  limit = 100,
  offset = 0,
): ChangeHistoryPage {
  const total = (
    db
      .prepare('SELECT COUNT(*) AS n FROM change_log WHERE entity = ? AND entity_id = ?')
      .get(entity, entityId) as { n: number }
  ).n;
  const rows = db
    .prepare(
      'SELECT id, entity, entity_id, diff, actor, created_at FROM change_log WHERE entity = ? AND entity_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
    )
    .all(entity, entityId, limit, offset) as ChangeLogRow[];
  return { changes: rows.map(asChangeView), total };
}

function asChangeView(row: ChangeLogRow): ChangeLogView {
  return {
    id: row.id,
    entity: row.entity,
    entityId: row.entity_id,
    diff: JSON.parse(row.diff) as FieldDiff,
    actor: JSON.parse(row.actor) as Actor,
    createdAt: row.created_at,
  };
}
