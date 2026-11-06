import type { Db } from './db.js';
import { assembleTask, requireTaskId, requireTaskRow, TaskError, type TaskView } from './tasks.js';

/**
 * The Status machine (spec: "Status machine"; ADR-0003: statuses are stored,
 * transitions validated — Intervals are the one piece of lifecycle data that
 * IS stored). Legal transitions only; every illegal move is rejected with a
 * message naming the current status and the legal targets from it.
 *
 * Entering `active` opens an Interval; leaving `active` closes it; entering
 * done/dropped auto-closes any open Interval; at most one Interval is open per
 * task (also enforced by the partial unique index from migration v4).
 *
 * Layering: this module holds the transition rules; updateTask (the PATCH /
 * task_update status path) and the verb entry points (task_start/task_done,
 * POST /tasks/:id/start|done) all funnel through applyStatusTransition, so
 * every surface validates and errors identically.
 */

export type TaskStatus = 'pending' | 'active' | 'waiting' | 'done' | 'dropped';

export const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'active', 'waiting', 'done', 'dropped'];

/**
 * Legal targets keyed by current status. Everything not listed is illegal —
 * including same-status moves: the spec words `done` as "any non-done -> done"
 * and `drop` as "any non-dropped -> dropped", so same-status transitions are
 * outside the machine for every status and are rejected uniformly rather than
 * treated as no-ops (consistent, and callers learn their move changed nothing).
 */
const LEGAL_TARGETS: Record<TaskStatus, TaskStatus[]> = {
  pending: ['active', 'waiting', 'done', 'dropped'],
  active: ['waiting', 'done', 'dropped'],
  waiting: ['active', 'done', 'dropped'],
  done: ['pending'], // reopen
  dropped: ['pending'], // reopen
};

/** A recorded Interval as exposed through both API surfaces. */
export interface IntervalView {
  id: number;
  startedAt: string;
  /** null while the Interval is open (the task is active). */
  endedAt: string | null;
}

/** The interval read side of a task detail. */
export interface IntervalSummary {
  /** Recorded spans, oldest first. */
  intervals: IntervalView[];
  /** Total time spent active in milliseconds; an open Interval counts up to now. */
  totalActiveMs: number;
}

interface IntervalRow {
  id: number;
  started_at: string;
  ended_at: string | null;
}

// --------------------------------------------------------------------------
// Transitions
// --------------------------------------------------------------------------

/**
 * Validates and applies one status transition: the id and target are parsed,
 * then the machine runs inside a transaction. Verb entry points call this with
 * a fixed target ('active' for start, 'done' for done).
 */
export function transitionTaskStatus(db: Db, id: unknown, target: unknown): TaskView {
  const taskId = requireTaskId(id);
  const statusTarget = parseStatusTarget(target);
  const run = db.transaction((): TaskView => {
    applyStatusTransition(db, taskId, statusTarget);
    const view = assembleTask(db, taskId);
    if (view === undefined) {
      throw new Error(`task ${taskId} missing right after status transition`);
    }
    return view;
  });
  return run();
}

/**
 * Applies one already-parsed transition. The caller owns the transaction —
 * updateTask nests this inside its own so status and field changes commit
 * (or roll back) together. Throws TaskError `conflict` for any illegal move.
 */
export function applyStatusTransition(db: Db, taskId: number, target: TaskStatus): void {
  const current = requireTaskRow(db, taskId).status as TaskStatus;
  if (current === target) {
    throw new TaskError(
      'conflict',
      `task ${taskId} is already ${current}: same-status transitions are rejected, not treated as no-ops`,
    );
  }
  const legal = LEGAL_TARGETS[current] ?? [];
  if (!legal.includes(target)) {
    throw new TaskError(
      'conflict',
      `task ${taskId} cannot move from ${current} to ${target}: legal targets from ${current} are ${legal.join(', ')}`,
    );
  }

  if (target === 'active') {
    openInterval(db, taskId); // entering active opens an Interval
  } else if (current === 'active') {
    closeOpenInterval(db, taskId); // leaving active (to waiting/done/dropped) closes it
  }
  db.prepare("UPDATE tasks SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(
    target,
    taskId,
  );
}

/** Parses a target status; anything outside the five statuses is `invalid`. */
export function parseStatusTarget(raw: unknown): TaskStatus {
  if (typeof raw === 'string' && (TASK_STATUSES as readonly string[]).includes(raw)) {
    return raw as TaskStatus;
  }
  throw new TaskError(
    'invalid',
    `status must be one of ${TASK_STATUSES.map((status) => `"${status}"`).join(', ')}, got: ${display(raw)}`,
  );
}

// --------------------------------------------------------------------------
// Interval reads
// --------------------------------------------------------------------------

/** The task's recorded Intervals and total active time (detail read payload). */
export function taskIntervals(db: Db, taskId: number): IntervalSummary {
  const rows = db
    .prepare('SELECT id, started_at, ended_at FROM intervals WHERE task_id = ? ORDER BY started_at, id')
    .all(taskId) as IntervalRow[];
  const now = Date.now();
  let totalActiveMs = 0;
  const intervals = rows.map((row) => {
    const endedAtMs = row.ended_at === null ? now : Date.parse(row.ended_at);
    totalActiveMs += Math.max(0, endedAtMs - Date.parse(row.started_at));
    return { id: row.id, startedAt: row.started_at, endedAt: row.ended_at };
  });
  return { intervals, totalActiveMs };
}

// --------------------------------------------------------------------------
// Internals
// --------------------------------------------------------------------------

function openInterval(db: Db, taskId: number): void {
  db.prepare(
    "INSERT INTO intervals (task_id, started_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
  ).run(taskId);
}

function closeOpenInterval(db: Db, taskId: number): void {
  db.prepare(
    "UPDATE intervals SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE task_id = ? AND ended_at IS NULL",
  ).run(taskId);
}

function display(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}
