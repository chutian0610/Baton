import type { Actor } from './actors.js';
import { listAnnotations, type AnnotationView } from './annotations.js';
import { recentChanges, recordChange, type ChangeLogView, type FieldDiff } from './changelog.js';
import type { Db } from './db.js';
import {
  deriveBlocked,
  deriveProgress,
  describeProjectBinding,
  findDependencyCyclePath,
  listDeps,
  parseDeps,
  projectName,
  sameProjectOrBothUnbound,
  validateDeps,
  writeDeps,
} from './deps.js';
import { asBody, display } from './internal.js';
import { applyStatusTransition, parseStatusTarget, taskIntervals, type IntervalView, type TaskStatus } from './lifecycle.js';

/**
 * Core Task operations — the "HTTP core" of ADR-0001, same layering as
 * src/projects.ts: the HTTP JSON API and the MCP tools are both thin adapters
 * over these functions. Domain failures throw TaskError; each surface maps
 * `code` onto its transport (HTTP status / MCP tool error) while keeping the
 * message text identical.
 *
 * Scope of this layer: creation, the single-parent tree (ADR-0004: nesting,
 * reparenting, ancestor-cycle rejection — trees may span projects, ADR-0005),
 * field updates, the project-attribute move (binding/unbinding a Task and its
 * whole subtree in one cascade, also ADR-0005), and the detail read (including
 * the recorded Intervals and total active time). Status transitions live in
 * src/lifecycle.ts — the status machine — and are applied by updateTask (the
 * PATCH / task_update status path) and the verb entry points (start/done).
 * Dependencies (the DAG of ADR-0004) and the values derived at read time from
 * them and from the tree (blocked, progress — ADR-0003) live in src/deps.ts
 * and surface on every TaskView this module assembles.
 *
 * Every mutation appends exactly one change-log row (src/changelog.ts) with
 * the field-level diff and the Actor, inside the same transaction as the
 * mutation itself; a cascade move appends one row per affected Task, still in
 * one transaction under one Actor. The Actor is a parameter threaded from the
 * calling surface — this layer never derives it on its own.
 */

/**
 * `invalid` -> HTTP 400 / `not-found` | `unbound` -> 404 /
 * `conflict` | `unsupported` -> 409.
 *
 * `unsupported` carries the rule-based refusals of this stage (status changes
 * at create): the request is well-formed, but the current version will not
 * perform it. Grouping those with `conflict` under 409 keeps 400 strictly
 * "malformed payload".
 */
export type TaskErrorCode = 'invalid' | 'not-found' | 'unbound' | 'conflict' | 'unsupported';

export class TaskError extends Error {
  constructor(
    readonly code: TaskErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** A Task's priority: high, medium, low (the only stored values; null = none). */
export type TaskPriority = 'H' | 'M' | 'L';

/** A Task as exposed through both API surfaces (views are camelCase, like ProjectView). */
export interface TaskView {
  id: number;
  title: string;
  status: TaskStatus;
  /** null when the Task is Unbound (ADR-0005: the state every Task starts in). */
  projectId: number | null;
  /** null when the Task is Unbound. */
  projectName: string | null;
  parentId: number | null;
  /** Lowercase, deduplicated, sorted. */
  tags: string[];
  /** Dependency ids (the task's edges in the DAG), sorted. */
  deps: number[];
  /** Derived at read time (never stored): some dependency is neither done nor dropped. */
  blocked: boolean;
  /**
   * Derived at read time (never stored): done descendants ÷ non-dropped
   * descendants. `null` for tasks with nothing below them to measure (leaves;
   * everything below dropped).
   */
  progress: number | null;
  due: string | null;
  priority: TaskPriority | null;
  effort: string | null;
  hiddenUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `task_get`'s answer: the task, its direct children, recorded Intervals, annotations, and recent changes. */
export interface TaskDetail {
  task: TaskView;
  /** Direct children (id, title, status), ordered by id. */
  children: ChildSummary[];
  /** Recorded active spans, oldest first (spec: task_get shows intervals). */
  intervals: IntervalView[];
  /** Total time spent active in milliseconds; an open Interval counts up to now. */
  totalActiveMs: number;
  /** Annotations, newest first (append-only — there is no edit or delete). */
  annotations: AnnotationView[];
  /** The last 20 change-log rows for this task, newest first (creation included). */
  recentChanges: ChangeLogView[];
}

export interface ChildSummary {
  id: number;
  title: string;
  status: string;
}

interface TaskRow {
  id: number;
  title: string;
  status: string;
  project_id: number | null;
  parent_id: number | null;
  due: string | null;
  priority: string | null;
  effort: string | null;
  hidden_until: string | null;
  created_at: string;
  updated_at: string;
}

const TASK_COLUMNS =
  'id, title, status, project_id, parent_id, due, priority, effort, hidden_until, created_at, updated_at';

// --------------------------------------------------------------------------
// Creation
// --------------------------------------------------------------------------

/**
 * Creates a Task — capture-first (ADR-0005): every Task starts Unbound and
 * the caller's cwd is never consulted. An explicit `project` (name or id)
 * assigns the attribute at birth; an absent or null `project` leaves the Task
 * Unbound (`projectId: null`). An unknown project ref is a `not-found` error.
 * A `parent` must exist; parent and child may live in different projects (a
 * tree expresses decomposition, not organization). New tasks start `pending`;
 * `status` in the input is rejected (not yet supported). `deps` name tasks
 * the new task depends on: each must exist and satisfy the one surviving
 * project constraint — dependencies connect tasks of the same project, or two
 * Unbound tasks (validated against the new task's project). Creation can
 * never form a dependency cycle — no stored edge can point at a task that did
 * not exist when its dependency was written — so only the per-edge rules are
 * checked (before the insert, which also makes a guessed future id fail as
 * unknown).
 *
 * The creation is recorded on the change log (every field as `after`) with
 * the caller's Actor, in the same transaction.
 */
export function createTask(db: Db, input: unknown, actor: Actor): TaskView {
  const body = asBody(input);
  if (body.status !== undefined) {
    throw new TaskError(
      'unsupported',
      'status cannot be set when creating a task: new tasks start as pending; move it afterwards with task_update (status) or the start/done verbs',
    );
  }

  const title = parseTitle(body.title);
  const tags = parseTags(body.tags);
  const deps = parseDeps(body.deps); // absent/null both mean: no dependencies
  const due = parseDatetime(body.due, 'due');
  const priority = parsePriority(body.priority);
  const effort = parseEffort(body.effort);
  const hiddenUntil = parseDatetime(pickHiddenUntil(body), 'hidden_until');
  const parent = parseRef(body.parent, 'parent') ?? null; // absent or null both mean: root task
  const project = parseProjectRef(body.project); // absent or null both mean: Unbound (ADR-0005)

  const create = db.transaction((): TaskView => {
    const parentRow = parent === null ? undefined : requireTaskRow(db, parent, 'parent');
    const owner = project === undefined ? null : findProject(db, project).id;
    validateDeps(db, undefined, owner, deps);

    const id = Number(
      db
        .prepare('INSERT INTO tasks (title, project_id, parent_id, due, priority, effort, hidden_until) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(title, owner, parent, due, priority, effort, hiddenUntil).lastInsertRowid,
    );
    writeTags(db, id, tags);
    writeDeps(db, id, deps);

    const created = assembleTask(db, id);
    if (created === undefined) {
      throw new Error(`task ${id} missing right after insert`);
    }
    recordChange(db, 'task', id, taskCreateDiff(created), actor);
    return created;
  });
  return create();
}

// --------------------------------------------------------------------------
// Update
// --------------------------------------------------------------------------

/**
 * Updates a Task's structural and field attributes: title, tags, due,
 * priority, effort, hidden_until, parent (reparenting; null makes the task a
 * root), deps (the dependency set, replaced wholesale like tags — `null` or
 * `[]` clears it), and `project` (ADR-0005: the attribute move). Dependencies
 * must reference existing tasks of the same project as the task — or be
 * Unbound like it (the same-project-or-two-unbound rule, validated against
 * the task's project AFTER this PATCH applies) — must not include the task
 * itself, and must keep the graph a DAG: a dep set that would form a cycle is
 * rejected with the offending path in the message. A provided `status` goes
 * through the status machine (src/lifecycle.ts) inside the same transaction,
 * so field, dep, and status changes commit or roll back together; illegal
 * transitions are `conflict` errors naming the current status.
 *
 * The `project` move is a cascade: the task AND its whole subtree (every
 * descendant) are assigned in one call — `project: null` unbinds the subtree.
 * The dep-set replacement (if any) runs first so the move is validated against
 * the FINAL edge set: every dependency edge touching the moved set is checked
 * (both directions; edges wholly inside the set are fine) — a move that would
 * leave a cross-project edge is rejected as `conflict` with the offending
 * pairs listed, and the whole PATCH rolls back. Reparenting that would make a
 * task its own ancestor is rejected with the cycle path in the message. Only
 * provided keys change; null clears an optional field.
 *
 * The update is recorded on the change log with exactly the fields that
 * actually changed (absent -> value counts as a change) and the caller's
 * Actor, in the same transaction; a cascade move additionally appends one
 * `projectId` row per affected descendant. A same-value assignment keeps the
 * one-row PATCH convention (an empty diff, no descendant rows). Status
 * transitions are recorded by their own paths (see recordStatusChange).
 */
export function updateTask(db: Db, id: unknown, input: unknown, actor: Actor): TaskView {
  const taskId = requireTaskId(id);
  const body = asBody(input);
  const statusTarget = body.status === undefined ? undefined : parseStatusTarget(body.status);
  const project = parseProjectUpdate(body); // undefined = key absent (leave unchanged); null = Unbound

  const title = body.title === undefined ? undefined : parseTitle(body.title);
  const tags = body.tags === undefined ? undefined : parseTags(body.tags);
  const deps = body.deps === undefined ? undefined : parseDeps(body.deps);
  const due = body.due === undefined ? undefined : parseDatetime(body.due, 'due');
  const priority = body.priority === undefined ? undefined : parsePriority(body.priority);
  const effort = body.effort === undefined ? undefined : parseEffort(body.effort);
  const hiddenUntil =
    pickHiddenUntil(body) === undefined && body.hiddenUntil === undefined
      ? undefined
      : parseDatetime(pickHiddenUntil(body) ?? body.hiddenUntil, 'hidden_until');
  const parent = body.parent === undefined ? undefined : parseRef(body.parent, 'parent');

  const update = db.transaction((): TaskView => {
    const current = requireTaskRow(db, taskId);
    const before = assembleTask(db, taskId); // full view (incl. tags) for the change diff
    if (before === undefined) {
      throw new Error(`task ${taskId} missing right after read`);
    }

    let newParentId: number | null | undefined;
    if (parent !== undefined) {
      if (parent === null) {
        newParentId = null; // detach: make the task a root
      } else {
        const parentRow = requireTaskRow(db, parent, 'parent');
        if (parent === taskId) {
          throw new TaskError('conflict', `task ${taskId} cannot be its own parent`);
        }
        const cyclePath = findCyclePath(db, taskId, parent);
        if (cyclePath !== undefined) {
          throw new TaskError(
            'conflict',
            `reparenting task ${taskId} under task ${parent} would make task ${taskId} its own ancestor ` +
              `(cycle: ${cyclePath.join(' -> ')})`,
          );
        }
        newParentId = parent;
      }
    }

    // The task's project AFTER this PATCH: an explicit assignment wins over
    // the stored attribute. The move (if any) cascades to the whole subtree.
    const newProjectId =
      project === undefined ? current.project_id : project === null ? null : findProject(db, project).id;

    // Dep-set replacement runs first, against the post-PATCH project, so the
    // cascade validation below sees the FINAL edge set (a PATCH may bind a
    // task and set its same-project deps in one call).
    if (deps !== undefined) {
      validateDeps(db, taskId, newProjectId, deps);
      const cyclePath = findDependencyCyclePath(db, taskId, deps);
      if (cyclePath !== undefined) {
        throw new TaskError(
          'conflict',
          `task ${taskId} depending on task ${cyclePath[1]} would create a dependency cycle ` +
            `(cycle: ${cyclePath.join(' -> ')})`,
        );
      }
      writeDeps(db, taskId, deps);
    }

    // The attribute move: validate every dependency edge touching the moved
    // subtree against the FINAL edge set, then flip the attribute in one
    // UPDATE and append one change-log row per affected descendant.
    if (project !== undefined && newProjectId !== current.project_id) {
      const movedIds = collectSubtreeIds(db, taskId);
      const placeholders = placeholdersFor(movedIds);
      const beforeRows = db
        .prepare(`SELECT id, project_id FROM tasks WHERE id IN (${placeholders})`)
        .all(...movedIds) as { id: number; project_id: number | null }[];
      const beforeProjectIds = new Map(beforeRows.map((row) => [row.id, row.project_id]));
      validateProjectMove(db, taskId, movedIds, newProjectId);
      db.prepare(
        `UPDATE tasks SET project_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id IN (${placeholders})`,
      ).run(newProjectId, ...movedIds);
      for (const movedId of movedIds) {
        if (movedId === taskId) {
          continue; // the target's row comes from the generic field diff below
        }
        const beforeProjectId = beforeProjectIds.get(movedId);
        if (beforeProjectId !== undefined && beforeProjectId !== newProjectId) {
          recordChange(db, 'task', movedId, { projectId: { before: beforeProjectId, after: newProjectId } }, actor);
        }
      }
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    if (title !== undefined) {
      sets.push('title = ?');
      values.push(title);
    }
    if (newParentId !== undefined) {
      sets.push('parent_id = ?');
      values.push(newParentId);
    }
    if (due !== undefined) {
      sets.push('due = ?');
      values.push(due);
    }
    if (priority !== undefined) {
      sets.push('priority = ?');
      values.push(priority);
    }
    if (effort !== undefined) {
      sets.push('effort = ?');
      values.push(effort);
    }
    if (hiddenUntil !== undefined) {
      sets.push('hidden_until = ?');
      values.push(hiddenUntil);
    }
    sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values, taskId);

    if (tags !== undefined) {
      writeTags(db, taskId, tags);
    }

    if (statusTarget !== undefined) {
      applyStatusTransition(db, taskId, statusTarget);
    }

    const updated = assembleTask(db, taskId);
    if (updated === undefined) {
      throw new Error(`task ${taskId} missing right after update`);
    }
    recordChange(db, 'task', taskId, taskUpdateDiff(before, updated), actor);
    return updated;
  });
  return update();
}

// --------------------------------------------------------------------------
// Detail read
// --------------------------------------------------------------------------

/** Returns the task, its direct children, intervals, annotations, and recent changes; unknown ids are a 404. */
export function getTask(db: Db, id: unknown): TaskDetail {
  const taskId = requireTaskId(id);
  const task = assembleTask(db, taskId);
  if (task === undefined) {
    throw new TaskError('not-found', `unknown task id: ${taskId}`);
  }
  const children = db
    .prepare('SELECT id, title, status FROM tasks WHERE parent_id = ? ORDER BY id')
    .all(taskId) as ChildSummary[];
  const { intervals, totalActiveMs } = taskIntervals(db, taskId);
  return {
    task,
    children,
    intervals,
    totalActiveMs,
    annotations: listAnnotations(db, taskId),
    recentChanges: recentChanges(db, 'task', taskId),
  };
}

// --------------------------------------------------------------------------
// Change recording (src/changelog.ts): exactly one change-log row per
// mutation, written inside the mutation's own transaction.
// --------------------------------------------------------------------------

/**
 * Task fields tracked on the change log, named as in the TaskView the API
 * surfaces return. Timestamps (createdAt/updatedAt) are metadata, not
 * mutations, and stay off the log.
 */
const TRACKED_TASK_FIELDS = [
  'title',
  'status',
  'projectId',
  'parentId',
  'tags',
  'deps',
  'due',
  'priority',
  'effort',
  'hiddenUntil',
] as const;

/** Creation diff: every tracked field under `after` (`before: null` = absent before). */
function taskCreateDiff(task: TaskView): FieldDiff {
  const diff: FieldDiff = {};
  for (const field of TRACKED_TASK_FIELDS) {
    diff[field] = { before: null, after: task[field] };
  }
  return diff;
}

/** Update diff: only the fields whose value actually changed (absent -> value counts). */
function taskUpdateDiff(before: TaskView, after: TaskView): FieldDiff {
  const diff: FieldDiff = {};
  for (const field of TRACKED_TASK_FIELDS) {
    if (!sameValue(before[field], after[field])) {
      diff[field] = { before: before[field], after: after[field] };
    }
  }
  return diff;
}

/** JSON-value equality — every tracked field is a JSON scalar or a sorted string array. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --------------------------------------------------------------------------
// Internals
// --------------------------------------------------------------------------

/**
 * Looks up a project by name or id (the shared name-or-id ref). Unknown refs
 * are a `not-found` TaskError; shared with the query layer so every surface
 * that accepts a project ref reports it identically.
 */
export function findProject(db: Db, ref: string | number): { id: number; name: string } {
  const row =
    typeof ref === 'number'
      ? db.prepare('SELECT id, name FROM projects WHERE id = ?').get(ref)
      : db.prepare('SELECT id, name FROM projects WHERE name = ?').get(ref);
  if (row === undefined) {
    throw new TaskError(
      'not-found',
      typeof ref === 'number' ? `unknown project id: ${ref}` : `unknown project name: ${display(ref)}`,
    );
  }
  return row as { id: number; name: string };
}

/** An IN-list's `?` placeholders, one per id (callers bind the ids in order). */
function placeholdersFor(ids: number[]): string {
  return ids.map(() => '?').join(', ');
}

/**
 * Walks `rootId`'s descendants breadth-first (the task itself first): the
 * moved set of a cascade project assignment (ADR-0005 — binding a Task binds
 * its whole subtree).
 */
function collectSubtreeIds(db: Db, rootId: number): number[] {
  const ids = [rootId];
  const childrenOf = db.prepare('SELECT id FROM tasks WHERE parent_id = ?');
  for (let index = 0; index < ids.length; index++) {
    const rows = childrenOf.all(ids[index]) as { id: number }[];
    for (const row of rows) {
      ids.push(row.id);
    }
  }
  return ids;
}

/**
 * Proves a cascade project assignment keeps the one surviving project
 * constraint (ADR-0005): after the move, every dependency edge touching the
 * moved set must connect tasks of the same project — or two Unbound tasks.
 * Edges WHOLLY INSIDE the moved set always pass (both endpoints take the new
 * project together). Edge endpoints outside the moved set keep their stored
 * project; a violation is a `conflict` listing every offending pair in a
 * "task R (still in project Y) depends on task M" shape so the caller knows
 * exactly what to resolve first. Runs inside the caller's transaction, before
 * the UPDATE, so a rejection leaves everything untouched.
 */
function validateProjectMove(db: Db, taskId: number, movedIds: number[], newProjectId: number | null): void {
  const moved = new Set(movedIds);
  const placeholders = placeholdersFor(movedIds);
  const edges = db
    .prepare(
      `SELECT task_id AS dependent, depends_on AS dependency FROM task_deps
        WHERE task_id IN (${placeholders}) OR depends_on IN (${placeholders})`,
    )
    .all(...movedIds, ...movedIds) as { dependent: number; dependency: number }[];
  if (edges.length === 0) {
    return;
  }

  const outsideProjects = new Map<number, number | null>();
  const findProjectId = db.prepare('SELECT project_id FROM tasks WHERE id = ?');
  // The project an edge endpoint will have AFTER the move: moved endpoints
  // take the new project, others keep theirs.
  const projectAfterMove = (id: number): number | null => {
    if (moved.has(id)) {
      return newProjectId;
    }
    let projectId = outsideProjects.get(id);
    if (projectId === undefined) {
      const row = findProjectId.get(id) as { project_id: number | null } | undefined;
      if (row === undefined) {
        throw new Error(`dependency edge references missing task ${id}`);
      }
      projectId = row.project_id;
      outsideProjects.set(id, projectId);
    }
    return projectId;
  };
  // Outside endpoints keep their stored project, hence the shared binding
  // description's "still" wording (dep-set validation uses the 'belongs' one).
  const describeOutside = (id: number): string => describeProjectBinding(db, projectAfterMove(id), 'still');

  const violations: string[] = [];
  for (const edge of edges) {
    const dependentProject = projectAfterMove(edge.dependent);
    const dependencyProject = projectAfterMove(edge.dependency);
    if (sameProjectOrBothUnbound(dependentProject, dependencyProject)) {
      continue; // same project, or both Unbound — the one legal cross-attr pairing
    }
    violations.push(
      moved.has(edge.dependent)
        ? `task ${edge.dependent} depends on task ${edge.dependency} (${describeOutside(edge.dependency)})`
        : `task ${edge.dependent} (${describeOutside(edge.dependent)}) depends on task ${edge.dependency}`,
    );
  }
  if (violations.length > 0) {
    violations.sort(); // deterministic message text
    const target = newProjectId === null ? 'unbound' : `project ${projectName(db, newProjectId)}`;
    throw new TaskError(
      'conflict',
      `moving task ${taskId} (with its subtree) to ${target} would leave cross-project dependencies: ` +
        `${violations.join('; ')}; resolve them first`,
    );
  }
}

/**
 * Walks the ancestor chain of `newParentId`; returns the cycle path
 * (starting and ending at `taskId`) when reparenting `taskId` under
 * `newParentId` would make it its own ancestor, else undefined.
 */
function findCyclePath(db: Db, taskId: number, newParentId: number): number[] | undefined {
  const getParent = db.prepare('SELECT parent_id FROM tasks WHERE id = ?');
  const path: number[] = [taskId];
  const seen = new Set<number>();
  let cursor: number | null = newParentId;
  while (cursor !== null) {
    path.push(cursor);
    if (cursor === taskId) {
      return path;
    }
    if (seen.has(cursor)) {
      return path; // defensive: the stored tree is acyclic, so this cannot fire
    }
    seen.add(cursor);
    const row = getParent.get(cursor) as { parent_id: number | null } | undefined;
    if (row === undefined) {
      return undefined; // broken chain (cannot happen with FK enforcement)
    }
    cursor = row.parent_id;
  }
  return undefined;
}

// requireTaskId / requireTaskRow / assembleTask are shared with the status
// machine (src/lifecycle.ts) — the same core layer, split into its own module.

export function requireTaskRow(db: Db, id: number, what: 'task' | 'parent' = 'task'): TaskRow {
  const row = db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
  if (row === undefined) {
    throw new TaskError('not-found', what === 'parent' ? `unknown parent task id: ${id}` : `unknown task id: ${id}`);
  }
  return row;
}

export function assembleTask(db: Db, id: number): TaskView | undefined {
  const row = db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
  if (row === undefined) {
    return undefined;
  }
  const tagRows = db.prepare('SELECT tag FROM task_tags WHERE task_id = ? ORDER BY tag').all(id) as { tag: string }[];
  const deps = listDeps(db, id);
  return {
    id: row.id,
    title: row.title,
    status: row.status as TaskStatus,
    projectId: row.project_id,
    projectName: projectNameById(db, row.project_id),
    parentId: row.parent_id,
    tags: tagRows.map((tagRow) => tagRow.tag),
    deps,
    blocked: deriveBlocked(db, deps),
    progress: deriveProgress(db, id),
    due: row.due,
    priority: row.priority as TaskPriority | null,
    effort: row.effort,
    hiddenUntil: row.hidden_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A task's project name, or null when the task is Unbound (never a made-up placeholder). */
function projectNameById(db: Db, id: number | null): string | null {
  return id === null ? null : projectName(db, id);
}

/** Replaces a task's tags wholesale (callers normalize first). */
function writeTags(db: Db, taskId: number, tags: string[]): void {
  db.prepare('DELETE FROM task_tags WHERE task_id = ?').run(taskId);
  const insert = db.prepare('INSERT INTO task_tags (task_id, tag) VALUES (?, ?)');
  for (const tag of tags) {
    insert.run(taskId, tag);
  }
}

// --------------------------------------------------------------------------
// Input parsing (uniform "invalid" messages shared by HTTP and MCP)
// --------------------------------------------------------------------------

export function requireTaskId(raw: unknown): number {
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    return raw;
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    return Number(raw);
  }
  throw new TaskError('invalid', `task id must be an integer, got: ${display(raw)}`);
}

function parseTitle(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new TaskError('invalid', `title must be a non-empty string, got: ${display(raw)}`);
  }
  return raw.trim();
}

function parseTags(raw: unknown): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new TaskError('invalid', `tags must be an array of strings, got: ${display(raw)}`);
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new TaskError('invalid', `each tag must be a non-empty string, got: ${display(entry)}`);
    }
    const tag = entry.trim().toLowerCase();
    if (!seen.has(tag)) {
      seen.add(tag);
      normalized.push(tag);
    }
  }
  return normalized;
}

function parsePriority(raw: unknown): TaskPriority | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (raw === 'H' || raw === 'M' || raw === 'L') {
    return raw;
  }
  throw new TaskError('invalid', `priority must be one of "H", "M", "L", got: ${display(raw)}`);
}

function parseEffort(raw: unknown): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new TaskError('invalid', `effort must be a non-empty string, got: ${display(raw)}`);
  }
  return raw.trim();
}

/**
 * Accepts date or datetime strings in ISO-8601 shape (YYYY-MM-DD[...]).
 * Shared with the query layer (dueBefore/dueAfter filters), so task fields
 * and filter bounds validate identically.
 */
export function parseDatetime(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string' || raw.trim() === '' || !/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(raw.trim()) || Number.isNaN(Date.parse(raw))) {
    throw new TaskError('invalid', `${field} must be an ISO-8601 date or datetime string, got: ${display(raw)}`);
  }
  return raw.trim();
}

/**
 * hidden_until comes in under the spec's field name; the camelCase spelling
 * (as returned by reads) is accepted as an alias. Passing both is an error
 * unless they are identical.
 */
function pickHiddenUntil(body: Record<string, unknown>): unknown {
  const snake = body.hidden_until;
  const camel = body.hiddenUntil;
  if (snake !== undefined && camel !== undefined && snake !== camel) {
    throw new TaskError('invalid', 'pass either hidden_until or hiddenUntil, not both');
  }
  return snake !== undefined ? snake : camel;
}

/**
 * Parses an id-valued reference (task parent). `undefined` means "key absent"
 * (the caller decides what that implies); explicit null means "no reference"
 * (absent/null at create means a root task; null on update detaches to root).
 */
function parseRef(raw: unknown, field: string): number | null | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === null) {
    return null;
  }
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    return raw;
  }
  throw new TaskError('invalid', `${field} must be a task id (integer), got: ${display(raw)}`);
}

/**
 * Parses a project reference: a project name (string) or a project id
 * (integer). Shared with the query layer (the filter's `project` field), so
 * every surface that names a project accepts the same shape.
 */
export function parseProjectRef(raw: unknown): string | number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === 'string') {
    if (raw.trim() === '') {
      throw new TaskError('invalid', `project must be a project name (string) or project id (integer), got: ${display(raw)}`);
    }
    return raw.trim();
  }
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    return raw;
  }
  throw new TaskError('invalid', `project must be a project name (string) or project id (integer), got: ${display(raw)}`);
}

/**
 * Parses the update-side project assignment: a project name (string), a
 * project id (integer), or null (unbind — the whole subtree goes Unbound,
 * ADR-0005). `undefined` means "key absent": the project is left unchanged.
 * The read-side spellings project_id/projectId are accepted as aliases (like
 * hidden_until/hiddenUntil); passing several spellings is an error unless
 * they are identical.
 */
function parseProjectUpdate(body: Record<string, unknown>): string | number | null | undefined {
  const spellings: Array<[string, unknown]> = [];
  if (body.project !== undefined) {
    spellings.push(['project', body.project]);
  }
  if (body.project_id !== undefined) {
    spellings.push(['project_id', body.project_id]);
  }
  if (body.projectId !== undefined) {
    spellings.push(['projectId', body.projectId]);
  }
  if (spellings.length === 0) {
    return undefined;
  }
  const [firstKey, firstValue] = spellings[0];
  for (const [key, value] of spellings.slice(1)) {
    if (JSON.stringify(value) !== JSON.stringify(firstValue)) {
      throw new TaskError(
        'invalid',
        `pass only one of project, project_id, projectId (they must agree when repeated), got conflicting values for ${firstKey} and ${key}`,
      );
    }
  }
  if (firstValue === null) {
    return null; // explicit unbind, distinct from "key absent"
  }
  return parseProjectRef(firstValue); // string | number; anything else is invalid
}
