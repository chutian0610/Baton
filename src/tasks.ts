import type { Db } from './db.js';
import { applyStatusTransition, parseStatusTarget, taskIntervals, type IntervalView } from './lifecycle.js';
import { ProjectError, resolveCurrentProject } from './projects.js';

/**
 * Core Task operations — the "HTTP core" of ADR-0001, same layering as
 * src/projects.ts: the HTTP JSON API and the MCP tools are both thin adapters
 * over these functions. Domain failures throw TaskError; each surface maps
 * `code` onto its transport (HTTP status / MCP tool error) while keeping the
 * message text identical.
 *
 * Scope of this layer: creation, the single-parent tree (ADR-0004: nesting,
 * reparenting, cycle rejection, one project per tree), field updates, and the
 * detail read (including the recorded Intervals and total active time). Status
 * transitions live in src/lifecycle.ts — the status machine — and are applied
 * by updateTask (the PATCH / task_update status path) and the verb entry
 * points (start/done). Dependencies ship with a later change and are rejected
 * when passed.
 */

/**
 * `invalid` -> HTTP 400 / `not-found` | `unbound` -> 404 /
 * `conflict` | `unsupported` -> 409.
 *
 * `unsupported` carries the rule-based refusals of this stage (status
 * changes, project moves, deps): the request is well-formed, but the current
 * version will not perform it. Grouping those with `conflict` under 409 keeps
 * 400 strictly "malformed payload".
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

/** A Task as exposed through both API surfaces (views are camelCase, like ProjectView). */
export interface TaskView {
  id: number;
  title: string;
  status: string;
  projectId: number;
  projectName: string;
  parentId: number | null;
  /** Lowercase, deduplicated, sorted. */
  tags: string[];
  due: string | null;
  priority: string | null;
  effort: string | null;
  hiddenUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `task_get`'s answer: the task, its direct children, and its recorded Intervals. */
export interface TaskDetail {
  task: TaskView;
  /** Direct children (id, title, status), ordered by id. */
  children: ChildSummary[];
  /** Recorded active spans, oldest first (spec: task_get shows intervals). */
  intervals: IntervalView[];
  /** Total time spent active in milliseconds; an open Interval counts up to now. */
  totalActiveMs: number;
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
  project_id: number;
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
 * Creates a Task. Project assignment: an explicit `project` (name or id)
 * wins; otherwise `cwd` is resolved to the Current Project via the projects
 * resolver; neither being usable is a domain error naming the fix. A `parent`
 * must exist and belong to the same project — a tree lives inside one
 * project (ADR-0004). New tasks start `pending`; `status` and `deps` in the
 * input are rejected (not yet supported).
 */
export function createTask(db: Db, input: unknown): TaskView {
  const body = asBody(input);
  if (body.status !== undefined) {
    throw new TaskError(
      'unsupported',
      'status cannot be set when creating a task: new tasks start as pending; move it afterwards with task_update (status) or the start/done verbs',
    );
  }
  if (body.deps !== undefined) {
    throw new TaskError(
      'unsupported',
      'dependencies are not supported yet (deps ship with a later change); omit "deps" for now',
    );
  }

  const title = parseTitle(body.title);
  const tags = parseTags(body.tags);
  const due = parseDatetime(body.due, 'due');
  const priority = parsePriority(body.priority);
  const effort = parseEffort(body.effort);
  const hiddenUntil = parseDatetime(pickHiddenUntil(body), 'hidden_until');
  const parent = parseRef(body.parent, 'parent', true) ?? null; // absent or null both mean: root task
  const project = parseProjectRef(body.project);

  const create = db.transaction((): TaskView => {
    const parentRow = parent === null ? undefined : requireTaskRow(db, parent, 'parent');
    const owner = resolveOwningProject(db, project, body.cwd);
    if (parentRow !== undefined && parentRow.project_id !== owner.id) {
      const parentProject = projectNameById(db, parentRow.project_id);
      throw new TaskError(
        'conflict',
        `parent task ${parent} belongs to project ${parentProject}, but the new task would belong to project ${owner.name}; ` +
          'a task tree must live inside one project',
      );
    }

    const id = Number(
      db
        .prepare('INSERT INTO tasks (title, project_id, parent_id, due, priority, effort, hidden_until) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(title, owner.id, parent, due, priority, effort, hiddenUntil).lastInsertRowid,
    );
    writeTags(db, id, tags);

    const created = assembleTask(db, id);
    if (created === undefined) {
      throw new Error(`task ${id} missing right after insert`);
    }
    return created;
  });
  return create();
}

// --------------------------------------------------------------------------
// Update
// --------------------------------------------------------------------------

/**
 * Updates a Task's structural and field attributes: title, tags, due,
 * priority, effort, hidden_until, and parent (reparenting; null makes the
 * task a root). A provided `status` goes through the status machine
 * (src/lifecycle.ts) inside the same transaction, so field and status changes
 * commit or roll back together; illegal transitions are `conflict` errors
 * naming the current status. Rejected with `unsupported`:
 * `project`/`project_id` (a tree cannot move between projects in v1) and
 * `deps`. Reparenting that would make a task its own ancestor is rejected
 * with the cycle path in the message. Only provided keys change; null clears
 * an optional field.
 */
export function updateTask(db: Db, id: unknown, input: unknown): TaskView {
  const taskId = requireTaskId(id);
  const body = asBody(input);
  const statusTarget = body.status === undefined ? undefined : parseStatusTarget(body.status);
  if (body.deps !== undefined) {
    throw new TaskError(
      'unsupported',
      'dependencies are not supported yet (deps ship with a later change); omit "deps" for now',
    );
  }
  if (body.project !== undefined || body.project_id !== undefined || body.projectId !== undefined) {
    throw new TaskError(
      'unsupported',
      'moving a task between projects is not supported; create the task in the target project instead',
    );
  }

  const title = body.title === undefined ? undefined : parseTitle(body.title);
  const tags = body.tags === undefined ? undefined : parseTags(body.tags);
  const due = body.due === undefined ? undefined : parseDatetime(body.due, 'due');
  const priority = body.priority === undefined ? undefined : parsePriority(body.priority);
  const effort = body.effort === undefined ? undefined : parseEffort(body.effort);
  const hiddenUntil =
    pickHiddenUntil(body) === undefined && body.hiddenUntil === undefined
      ? undefined
      : parseDatetime(pickHiddenUntil(body) ?? body.hiddenUntil, 'hidden_until');
  const parent = body.parent === undefined ? undefined : parseRef(body.parent, 'parent', true);

  const update = db.transaction((): TaskView => {
    const current = requireTaskRow(db, taskId);

    let newParentId: number | null | undefined;
    if (parent !== undefined) {
      if (parent === null) {
        newParentId = null; // detach: make the task a root
      } else {
        const parentRow = requireTaskRow(db, parent, 'parent');
        if (parentRow.project_id !== current.project_id) {
          const parentProject = projectNameById(db, parentRow.project_id);
          const taskProject = projectNameById(db, current.project_id);
          throw new TaskError(
            'conflict',
            `parent task ${parent} belongs to project ${parentProject}, but task ${taskId} belongs to project ${taskProject}; ` +
              'a task tree must live inside one project',
          );
        }
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
    return updated;
  });
  return update();
}

// --------------------------------------------------------------------------
// Detail read
// --------------------------------------------------------------------------

/** Returns the task, its direct children, and its intervals; unknown ids are a 404. */
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
  return { task, children, intervals, totalActiveMs };
}

// --------------------------------------------------------------------------
// Internals
// --------------------------------------------------------------------------

/**
 * Determines the owning project: explicit ref wins (even over a cwd);
 * otherwise the cwd resolves to the Current Project; otherwise an `unbound`
 * error naming the fix.
 */
function resolveOwningProject(
  db: Db,
  project: string | number | undefined,
  cwd: unknown,
): { id: number; name: string } {
  if (project !== undefined) {
    const row =
      typeof project === 'number'
        ? db.prepare('SELECT id, name FROM projects WHERE id = ?').get(project)
        : db.prepare('SELECT id, name FROM projects WHERE name = ?').get(project);
    if (row === undefined) {
      throw new TaskError(
        'not-found',
        typeof project === 'number' ? `unknown project id: ${project}` : `unknown project name: ${display(project)}`,
      );
    }
    return row as { id: number; name: string };
  }
  if (cwd !== undefined && cwd !== null) {
    try {
      const current = resolveCurrentProject(db, cwd);
      return { id: current.project.id, name: current.project.name };
    } catch (err) {
      if (err instanceof ProjectError && (err.code === 'unbound' || err.code === 'invalid')) {
        throw new TaskError(err.code, err.message);
      }
      throw err;
    }
  }
  throw new TaskError(
    'unbound',
    'cannot determine the project for this task: pass "project" (name or id) or a "cwd" that resolves to one ' +
      '(bind the directory with project_create first)',
  );
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
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    projectId: row.project_id,
    projectName: projectNameById(db, row.project_id),
    parentId: row.parent_id,
    tags: tagRows.map((tagRow) => tagRow.tag),
    due: row.due,
    priority: row.priority,
    effort: row.effort,
    hiddenUntil: row.hidden_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectNameById(db: Db, id: number): string {
  const row = db.prepare('SELECT name FROM projects WHERE id = ?').get(id) as { name: string } | undefined;
  if (row === undefined) {
    throw new Error(`task references missing project ${id}`);
  }
  return row.name;
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

function asBody(input: unknown): Record<string, unknown> {
  return (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
}

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

function parsePriority(raw: unknown): string | null {
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

/** Accepts date or datetime strings in ISO-8601 shape (YYYY-MM-DD[...]). */
function parseDatetime(raw: unknown, field: string): string | null {
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
 * and is only accepted when `allowNull` (reparent-to-root sends parent: null).
 */
function parseRef(raw: unknown, field: string, allowNull: boolean): number | null | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === null) {
    if (allowNull) {
      return null;
    }
    throw new TaskError('invalid', `${field} must be a task id (integer), got: ${display(raw)}`);
  }
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    return raw;
  }
  throw new TaskError('invalid', `${field} must be a task id (integer), got: ${display(raw)}`);
}

function parseProjectRef(raw: unknown): string | number | undefined {
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

function display(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}
