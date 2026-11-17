import type { Db } from './db.js';
import { display } from './internal.js';
import { TaskError } from './tasks.js';

/**
 * The Dependency DAG (CONTEXT.md: Dependency; ADR-0004: deps are directed
 * edges orthogonal to the parent/child tree; ADR-0005: the one project
 * constraint — edges connect same-project tasks, or two Unbound tasks). This
 * module owns everything about dependency edges and the two values derived
 * from structure (ADR-0003: derived data is never stored — there is no
 * blocked column and no percent field anywhere):
 *
 * - deps are a SET on the task, replaced wholesale by task_update (like tags);
 * - Blocked: true while any dependency is neither done nor dropped; advisory
 *   only — it never gates a status transition (a blocked task can start);
 * - Progress: a parent's completion ratio, done descendants ÷ non-dropped
 *   descendants over its whole subtree; tasks with no (non-dropped)
 *   descendants carry `null`, not 0 — there is nothing to measure.
 *
 * Both derived values are computed at read time from the tables; the only
 * stored dep state is the task_deps edge set. Every validation here runs
 * inside the caller's transaction, BEFORE the edges are written, so a
 * rejected request leaves the graph untouched (transaction or not, nothing
 * was written).
 */

/** A task's dependency ids, sorted (deps are a set; the order is display-only). */
export function listDeps(db: Db, taskId: number): number[] {
  const rows = db.prepare('SELECT depends_on FROM task_deps WHERE task_id = ? ORDER BY depends_on').all(taskId) as {
    depends_on: number;
  }[];
  return rows.map((row) => row.depends_on);
}

/**
 * True while any dependency is open (neither `done` nor `dropped`). A task
 * with no dependencies is never blocked. Never stored, never enforced: a
 * blocked task may still become active (spec "Status machine").
 */
export function deriveBlocked(db: Db, deps: number[]): boolean {
  if (deps.length === 0) {
    return false;
  }
  const open = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks WHERE id IN (${deps.map(() => '?').join(', ')}) AND status NOT IN ('done', 'dropped')`,
    )
    .get(...deps) as { n: number };
  return open.n > 0;
}

/**
 * A parent's Progress: done descendants ÷ non-dropped descendants, over the
 * whole subtree (children, grandchildren, ... — every task below this one in
 * the tree, not just direct children). Dropped descendants leave both the
 * numerator and the denominator. `null` when there are no non-dropped
 * descendants (leaves, or everything below was dropped): with nothing to
 * measure, the honest answer is "no value", never a made-up 0 or 1.
 */
export function deriveProgress(db: Db, taskId: number): number | null {
  const childrenOf = db.prepare('SELECT id, status FROM tasks WHERE parent_id = ?');
  let done = 0;
  let total = 0;
  const count = (parent: number): void => {
    const rows = childrenOf.all(parent) as { id: number; status: string }[];
    for (const child of rows) {
      if (child.status === 'dropped') {
        continue; // excluded from the denominator (and it is not done either)
      }
      total++;
      if (child.status === 'done') {
        done++;
      }
      count(child.id);
    }
  };
  count(taskId);
  return total === 0 ? null : done / total;
}

/**
 * The one surviving project constraint (ADR-0005) as an edge predicate: a
 * dependency edge is legal exactly when its two endpoints share a project —
 * or are both Unbound (null = Unbound). Dep-set validation (validateDeps)
 * checks it per proposed edge; a cascade project move (validateProjectMove in
 * src/tasks.ts) checks every edge touching the moved set against the
 * post-move projects. One definition, so the rule cannot drift apart.
 */
export function sameProjectOrBothUnbound(a: number | null, b: number | null): boolean {
  return a === b;
}

/**
 * A project's name by id — the one `SELECT name FROM projects WHERE id = ?`
 * behind every message or view that names a project. A missing row is a
 * broken reference (impossible with FK enforcement); it fails loudly instead
 * of rendering "undefined".
 */
export function projectName(db: Db, id: number): string {
  const row = db.prepare('SELECT name FROM projects WHERE id = ?').get(id) as { name: string } | undefined;
  if (row === undefined) {
    throw new Error(`task references missing project ${id}`);
  }
  return row.name;
}

/**
 * Renders one edge endpoint's project binding as error-message text — the
 * shared description behind both validators, with the two wordings tests
 * lock: dep-set validation says "is unbound" / "belongs to project X", while
 * a cascade project move says "still unbound" / "still in project X"
 * ("still" marks an endpoint that keeps its stored project while the moved
 * set takes the new one).
 */
export function describeProjectBinding(db: Db, projectId: number | null, wording: 'belongs' | 'still'): string {
  if (projectId === null) {
    return wording === 'still' ? 'still unbound' : 'is unbound';
  }
  return wording === 'still' ? `still in project ${projectName(db, projectId)}` : `belongs to project ${projectName(db, projectId)}`;
}

/**
 * Validates a proposed dependency set for a task being created (taskId
 * undefined — the task does not exist yet) or updated: every dependency must
 * exist, a task cannot depend on itself, and the one surviving project
 * constraint (ADR-0005) holds — dependencies connect tasks of the same
 * project, or two Unbound tasks. `projectId` is the task's project AFTER the
 * write (null = Unbound). Cycles are checked separately
 * (findDependencyCyclePath) since only updates can form them.
 */
export function validateDeps(
  db: Db,
  taskId: number | undefined,
  projectId: number | null,
  deps: number[],
): void {
  const findTask = db.prepare('SELECT id, project_id FROM tasks WHERE id = ?');
  for (const dep of deps) {
    if (taskId !== undefined && dep === taskId) {
      throw new TaskError('conflict', `task ${taskId} cannot depend on itself`);
    }
    const row = findTask.get(dep) as { id: number; project_id: number | null } | undefined;
    if (row === undefined) {
      throw new TaskError('not-found', `unknown dependency task id: ${dep}`);
    }
    if (!sameProjectOrBothUnbound(row.project_id, projectId)) {
      const who = taskId === undefined ? 'the new task' : `task ${taskId}`;
      throw new TaskError(
        'conflict',
        `dependency task ${dep} ${describeProjectBinding(db, row.project_id, 'belongs')}, but ${who} ` +
          `${describeProjectBinding(db, projectId, 'belongs')}; ` +
          'dependencies must connect tasks of the same project — or two unbound tasks',
      );
    }
  }
}

/**
 * Searches the directed graph for a cycle that the proposed dep set of
 * `taskId` would create: a depth-first walk over "depends on" edges, starting
 * at `taskId` with the PROPOSED edges (not the rows about to be replaced) and
 * continuing through the stored edges of every other task. Returns the
 * offending path in dependent -> dependency order, starting and ending at
 * `taskId` (e.g. [3, 5, 4, 3]), or undefined when the result stays a DAG.
 *
 * The stored graph is acyclic, so `taskId` can only be re-reached along the
 * current expansion — the returned path is the actual cycle. Callers invoke
 * this before writing, inside the mutation's transaction.
 */
export function findDependencyCyclePath(db: Db, taskId: number, proposedDeps: number[]): number[] | undefined {
  const storedDeps = db.prepare('SELECT depends_on FROM task_deps WHERE task_id = ? ORDER BY depends_on');
  const path: number[] = [];
  const visited = new Set<number>();

  const dfs = (node: number): number[] | undefined => {
    if (node === taskId && path.length > 0) {
      return [...path, taskId]; // came back around: node ... -> taskId
    }
    if (visited.has(node)) {
      return undefined; // fully explored earlier without reaching taskId
    }
    visited.add(node);
    path.push(node);
    const next =
      path.length === 1
        ? proposedDeps // the first expansion uses the proposed set, not the stored rows
        : (storedDeps.all(node) as { depends_on: number }[]).map((row) => row.depends_on);
    for (const dep of next) {
      const cycle = dfs(dep);
      if (cycle !== undefined) {
        return cycle;
      }
    }
    path.pop();
    return undefined;
  };

  return dfs(taskId);
}

/** Replaces a task's dependency set wholesale (callers validate first). */
export function writeDeps(db: Db, taskId: number, deps: number[]): void {
  db.prepare('DELETE FROM task_deps WHERE task_id = ?').run(taskId);
  const insert = db.prepare('INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)');
  for (const dep of deps) {
    insert.run(taskId, dep);
  }
}

// --------------------------------------------------------------------------
// Input parsing (uniform "invalid" messages shared by HTTP and MCP)
// --------------------------------------------------------------------------

/**
 * Parses a deps payload: an array of task ids, deduplicated and sorted (deps
 * are a set). `undefined`/null mean "no dependencies" — on update the caller
 * distinguishes "absent" (leave unchanged) from null/[] (clear the set).
 */
export function parseDeps(raw: unknown): number[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new TaskError('invalid', `deps must be an array of task ids, got: ${display(raw)}`);
  }
  const normalized: number[] = [];
  const seen = new Set<number>();
  for (const entry of raw) {
    if (typeof entry !== 'number' || !Number.isInteger(entry)) {
      throw new TaskError('invalid', `each dep must be a task id (integer), got: ${display(entry)}`);
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      normalized.push(entry);
    }
  }
  return normalized.sort((a, b) => a - b);
}
