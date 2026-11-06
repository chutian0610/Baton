import type { Actor } from './actors.js';
import type { Db } from './db.js';
import { TaskError } from './tasks.js';

/**
 * Annotations (CONTEXT.md): timestamped, append-only notes attached to a
 * task; the channel through which agents report interim findings and
 * progress. Append-only means there is no edit and no delete — this module
 * exposes INSERT and SELECT only, and neither surface offers mutation or
 * removal routes.
 *
 * An annotation is its own record: appending one does NOT write a change-log
 * row (the change log records mutations; an annotation is not a mutation of
 * the task's fields).
 */

/** An Annotation as exposed through both API surfaces. */
export interface AnnotationView {
  id: number;
  taskId: number;
  body: string;
  actor: Actor;
  createdAt: string;
}

interface AnnotationRow {
  id: number;
  task_id: number;
  body: string;
  actor: string;
  created_at: string;
}

/**
 * Appends an Annotation to a task, carrying the Actor of the caller. The task
 * must exist (unknown ids are the same `not-found` error the task routes
 * use). The insert runs in its own transaction — an annotation is a single
 * row, so there is nothing else to keep atomic with it.
 */
export function appendAnnotation(db: Db, id: unknown, body: unknown, actor: Actor): AnnotationView {
  const taskId = requireTaskId(id);
  const text = parseBody(body);

  const append = db.transaction((): AnnotationView => {
    const exists = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId);
    if (exists === undefined) {
      throw new TaskError('not-found', `unknown task id: ${taskId}`);
    }
    const info = db
      .prepare('INSERT INTO annotations (task_id, body, actor) VALUES (?, ?, ?)')
      .run(taskId, text, JSON.stringify(actor));
    const created = annotationById(db, Number(info.lastInsertRowid));
    if (created === undefined) {
      throw new Error(`annotation ${info.lastInsertRowid} missing right after insert`);
    }
    return created;
  });
  return append();
}

/** A task's annotations, newest first (ids are monotonic, so id order is time order). */
export function listAnnotations(db: Db, taskId: number): AnnotationView[] {
  const rows = db
    .prepare('SELECT id, task_id, body, actor, created_at FROM annotations WHERE task_id = ? ORDER BY id DESC')
    .all(taskId) as AnnotationRow[];
  return rows.map(asView);
}

// --------------------------------------------------------------------------
// Internals
// --------------------------------------------------------------------------

function annotationById(db: Db, id: number): AnnotationView | undefined {
  const row = db
    .prepare('SELECT id, task_id, body, actor, created_at FROM annotations WHERE id = ?')
    .get(id) as AnnotationRow | undefined;
  return row === undefined ? undefined : asView(row);
}

function asView(row: AnnotationRow): AnnotationView {
  return {
    id: row.id,
    taskId: row.task_id,
    body: row.body,
    actor: JSON.parse(row.actor) as Actor,
    createdAt: row.created_at,
  };
}

/** Mirrors the task layer's id and text validation so both surfaces agree. */
function requireTaskId(raw: unknown): number {
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    return raw;
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    return Number(raw);
  }
  throw new TaskError('invalid', `task id must be an integer, got: ${JSON.stringify(raw) ?? String(raw)}`);
}

function parseBody(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new TaskError('invalid', `annotation body must be a non-empty string, got: ${JSON.stringify(raw) ?? String(raw)}`);
  }
  return raw.trim();
}
