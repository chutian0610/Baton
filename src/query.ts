import type { Db } from './db.js';
import { TASK_STATUSES, type TaskStatus } from './lifecycle.js';
import { ProjectError, resolveCurrentProject } from './projects.js';
import { assembleTask, TaskError, type TaskView } from './tasks.js';

/**
 * The Query model (spec "Query model"; CONTEXT.md: Current Project,
 * Hidden-until, Tag, Blocked): one core read shared verbatim by GET /tasks
 * and the MCP task_list tool — a structured JSON filter (fields combine with
 * AND semantics; no free-text filter algebra anywhere) or one of the four
 * quick views, plus an optional cwd. Result items reuse the TaskView shape,
 * so blocked and progress are derived per read right here (ADR-0003: derived
 * data is never stored — filtering and sorting on `blocked` derives it too).
 *
 * Rules both surfaces share:
 * - Quick views: `current` (open tasks of the resolved Current Project),
 *   `today` (open tasks due today or overdue, i.e. due <= end of today),
 *   `blocked` (open AND blocked), `all` (everything — the whole store).
 * - Default exclusions, applied to every view and bare filter EXCEPT `all`
 *   and any filter that explicitly names statuses: exclude done, dropped,
 *   and tasks whose hidden_until is still in the future.
 * - Default ordering: due ascending (tasks without a due date last) ->
 *   priority descending (H > M > L, tasks without priority last) -> id
 *   ascending. An explicit sort/limit overrides; id ascending always stays
 *   the final tiebreaker so ordering is stable.
 * - Scope: an explicit filter `project` wins (like task_create); otherwise a
 *   resolvable cwd scopes non-`all` queries to the Current Project; an absent
 *   or unbound cwd falls back to the WHOLE store with a note in the response
 *   scope (spec: "task_list without resolvable cwd falls back to whole-store
 *   with a note"). `all` is the whole store by definition.
 *
 * Read-path scale note: candidates are assembled into full TaskViews (tags,
 * deps, blocked, progress) and filtered in memory. On a single machine's
 * board this is a few SQL point-lookups per task and keeps the semantics in
 * one obvious place instead of mirroring derived-state rules into SQL.
 */

export type QuickView = 'current' | 'today' | 'blocked' | 'all';

export const QUICK_VIEWS: readonly QuickView[] = ['current', 'today', 'blocked', 'all'];

/** The filter field names, in spec order — shared with the MCP flat-args adapter. */
export const FILTER_FIELD_KEYS = [
  'status',
  'project',
  'tags',
  'tagMode',
  'parent',
  'hasParent',
  'blocked',
  'dueBefore',
  'dueAfter',
  'priority',
  'text',
  'sort',
  'limit',
] as const;

/** The scope a list result was computed over. */
export interface QueryScope {
  /** The project the query was scoped to, or null when it ran over the whole store. */
  project: { id: number; name: string } | null;
  /** Present when the query fell back to the whole store (absent/unresolvable cwd). */
  note?: string;
}

export interface TaskQueryResult {
  tasks: TaskView[];
  scope: QueryScope;
}

/** tag_list's answer: every tag in use with the count of open tasks carrying it. */
export interface TagUsage {
  tag: string;
  count: number;
}

// --------------------------------------------------------------------------
// Input shape (validated)
// --------------------------------------------------------------------------

interface TaskFilter {
  /** Explicitly named statuses; presence turns the default exclusions off. */
  statuses?: TaskStatus[];
  /** Project name or id (resolved to a row before querying). */
  project?: string | number;
  tags?: string[];
  tagMode: 'any' | 'all';
  parentId?: number;
  hasParent?: boolean;
  blocked?: boolean;
  dueBefore?: string;
  dueAfter?: string;
  priorities?: string[];
  /** Case-insensitive title substring, pre-lowercased. */
  text?: string;
  sort?: SortSpec[];
  limit?: number;
}

const SORT_FIELDS = ['due', 'priority', 'id', 'title', 'status', 'createdAt', 'updatedAt'] as const;

type SortField = (typeof SORT_FIELDS)[number];

interface SortSpec {
  field: SortField;
  direction: 'asc' | 'desc';
}

/**
 * Direction used when a sort entry names a field without one. `priority`
 * defaults to descending because its natural presentation order is H > M > L
 * (the default ordering of the spec words it exactly that way).
 */
const DEFAULT_SORT_DIRECTIONS: Record<SortField, 'asc' | 'desc'> = {
  due: 'asc',
  priority: 'desc',
  id: 'asc',
  title: 'asc',
  status: 'asc',
  createdAt: 'asc',
  updatedAt: 'asc',
};

/** The stable default ordering: due asc -> priority desc (H>M>L) -> id asc. */
const DEFAULT_SORT: SortSpec[] = [
  { field: 'due', direction: 'asc' },
  { field: 'priority', direction: 'desc' },
  { field: 'id', direction: 'asc' },
];

// --------------------------------------------------------------------------
// The core query
// --------------------------------------------------------------------------

/**
 * Runs the shared list query. `input` is `{view?, filter?, cwd?}`: either a
 * quick view name or a structured filter object (both is an error), plus an
 * optional cwd. Neither view nor filter means the default view (`current`
 * semantics: default exclusions, scoped to the cwd's Current Project with the
 * whole-store fallback). Domain failures throw TaskError (`invalid` for
 * malformed input, `not-found` for unknown project/parent references).
 */
export function queryTasks(db: Db, input: unknown): TaskQueryResult {
  const body = asBody(input);
  const view = parseView(body.view);
  const hasFilter = body.filter !== undefined && body.filter !== null;
  if (view !== undefined && hasFilter) {
    throw new TaskError('invalid', 'pass either "view" (current, today, blocked, all) or "filter", not both');
  }
  const filter = hasFilter ? parseFilter(body.filter) : undefined;
  const cwd = parseCwd(body.cwd);
  const effectiveView = view ?? 'current';
  const now = Date.now();
  const endOfToday = endOfTodayMs(now);

  const { projectId, scope } = resolveQueryScope(db, effectiveView, filter, cwd);
  if (filter?.parentId !== undefined) {
    requireTaskExists(db, filter.parentId);
  }

  const rows = (projectId === null
    ? db.prepare('SELECT id FROM tasks').all()
    : db.prepare('SELECT id FROM tasks WHERE project_id = ?').all(projectId)) as { id: number }[];

  const tasks: TaskView[] = [];
  for (const row of rows) {
    const task = assembleTask(db, row.id);
    if (task !== undefined && matches(task, effectiveView, filter, now, endOfToday)) {
      tasks.push(task);
    }
  }
  tasks.sort(comparator(filter?.sort));
  return { tasks: filter?.limit === undefined ? tasks : tasks.slice(0, filter.limit), scope };
}

/** tag_list: tags in use across the whole store, counted over open (non-done/dropped) tasks only. */
export function listTags(db: Db): { tags: TagUsage[] } {
  const tags = db
    .prepare(
      `SELECT tt.tag AS tag, COUNT(*) AS count
         FROM task_tags tt
         JOIN tasks t ON t.id = tt.task_id
        WHERE t.status NOT IN ('done', 'dropped')
        GROUP BY tt.tag
        ORDER BY tt.tag`,
    )
    .all() as TagUsage[];
  return { tags };
}

// --------------------------------------------------------------------------
// Scope resolution
// --------------------------------------------------------------------------

function resolveQueryScope(
  db: Db,
  view: QuickView,
  filter: TaskFilter | undefined,
  cwd: string | undefined,
): { projectId: number | null; scope: QueryScope } {
  if (filter?.project !== undefined) {
    const project = findProject(db, filter.project); // explicit project wins, like task_create
    return { projectId: project.id, scope: { project: { id: project.id, name: project.name } } };
  }
  if (view === 'all') {
    return { projectId: null, scope: { project: null } }; // everything, by definition
  }
  if (cwd !== undefined) {
    try {
      const current = resolveCurrentProject(db, cwd);
      return {
        projectId: current.project.id,
        scope: { project: { id: current.project.id, name: current.project.name } },
      };
    } catch (err) {
      if (err instanceof ProjectError && err.code === 'unbound') {
        return { projectId: null, scope: { project: null, note: `${err.message} Listing the whole store instead.` } };
      }
      throw err;
    }
  }
  return {
    projectId: null,
    scope: { project: null, note: 'no cwd was given, so no Current Project could be resolved; listing the whole store' },
  };
}

function findProject(db: Db, ref: string | number): { id: number; name: string } {
  const row =
    typeof ref === 'number'
      ? db.prepare('SELECT id, name FROM projects WHERE id = ?').get(ref)
      : db.prepare('SELECT id, name FROM projects WHERE name = ?').get(ref);
  if (row === undefined) {
    throw new TaskError(
      'not-found',
      typeof ref === 'number' ? `unknown project id: ${ref}` : `unknown project name: ${ref}`,
    );
  }
  return row as { id: number; name: string };
}

function requireTaskExists(db: Db, id: number): void {
  if (db.prepare('SELECT id FROM tasks WHERE id = ?').get(id) === undefined) {
    throw new TaskError('not-found', `unknown parent task id: ${id}`);
  }
}

// --------------------------------------------------------------------------
// Matching (quick-view constraints + default exclusions + filter fields, AND)
// --------------------------------------------------------------------------

function matches(
  task: TaskView,
  view: QuickView,
  filter: TaskFilter | undefined,
  now: number,
  endOfToday: number,
): boolean {
  if (view === 'today' && (task.due === null || Date.parse(task.due) > endOfToday)) {
    return false; // today: open tasks due today or overdue
  }
  if (view === 'blocked' && !task.blocked) {
    return false; // blocked: open AND derived-blocked
  }

  // Default exclusions (open + not hidden-yet) unless the view is `all` or the
  // filter explicitly names statuses — then the caller sees exactly what they
  // asked for, done/dropped/hidden included.
  if (view !== 'all' && filter?.statuses === undefined) {
    if (task.status === 'done' || task.status === 'dropped') {
      return false;
    }
    if (task.hiddenUntil !== null && Date.parse(task.hiddenUntil) > now) {
      return false;
    }
  }

  if (filter === undefined) {
    return true;
  }

  if (filter.statuses !== undefined && !filter.statuses.includes(task.status as TaskStatus)) {
    return false;
  }
  if (filter.parentId !== undefined && task.parentId !== filter.parentId) {
    return false;
  }
  if (filter.hasParent !== undefined && (task.parentId !== null) !== filter.hasParent) {
    return false;
  }
  if (filter.blocked !== undefined && task.blocked !== filter.blocked) {
    return false;
  }
  if (filter.tags !== undefined) {
    const carried = (tag: string) => task.tags.includes(tag);
    const ok = filter.tagMode === 'all' ? filter.tags.every(carried) : filter.tags.some(carried);
    if (!ok) {
      return false;
    }
  }
  // A task without a due date is not due before or after anything: it matches neither bound.
  if (filter.dueBefore !== undefined && (task.due === null || Date.parse(task.due) > Date.parse(filter.dueBefore))) {
    return false; // inclusive
  }
  if (filter.dueAfter !== undefined && (task.due === null || Date.parse(task.due) < Date.parse(filter.dueAfter))) {
    return false; // inclusive
  }
  if (filter.priorities !== undefined && (task.priority === null || !filter.priorities.includes(task.priority))) {
    return false; // a task without a priority never matches a priority filter
  }
  if (filter.text !== undefined && !task.title.toLowerCase().includes(filter.text)) {
    return false;
  }
  return true;
}

// --------------------------------------------------------------------------
// Ordering
// --------------------------------------------------------------------------

/**
 * Builds the comparator for a sort specification. Tasks without a due date or
 * priority always sort LAST, regardless of direction (they have no place in
 * an urgency ordering). `id` ascending is appended when the caller's sort does
 * not mention it, keeping every ordering stable.
 */
function comparator(sort: SortSpec[] | undefined): (a: TaskView, b: TaskView) => number {
  const specs = sort === undefined ? [...DEFAULT_SORT] : [...sort];
  if (!specs.some((spec) => spec.field === 'id')) {
    specs.push({ field: 'id', direction: 'asc' });
  }
  return (a, b) => {
    for (const spec of specs) {
      const result = compareBy(a, b, spec);
      if (result !== 0) {
        return result;
      }
    }
    return 0;
  };
}

const PRIORITY_RANK: Record<string, number> = { H: 3, M: 2, L: 1 };

function compareBy(a: TaskView, b: TaskView, spec: SortSpec): number {
  const av = sortValue(a, spec.field);
  const bv = sortValue(b, spec.field);
  if (av === null && bv === null) return 0;
  if (av === null) return 1; // nulls last, before the direction flip
  if (bv === null) return -1;
  let result: number;
  if (typeof av === 'number' && typeof bv === 'number') {
    result = av - bv;
  } else {
    const as = String(av);
    const bs = String(bv);
    result = as < bs ? -1 : as > bs ? 1 : 0;
  }
  return spec.direction === 'desc' ? -result : result;
}

function sortValue(task: TaskView, field: SortField): number | string | null {
  switch (field) {
    case 'due':
      return task.due === null ? null : Date.parse(task.due);
    case 'priority':
      return task.priority === null ? null : PRIORITY_RANK[task.priority];
    case 'id':
      return task.id;
    case 'title':
      return task.title.toLowerCase();
    case 'status':
      return task.status;
    case 'createdAt':
      return Date.parse(task.createdAt);
    case 'updatedAt':
      return Date.parse(task.updatedAt);
  }
}

/** End of the current local day (23:59:59.999): the inclusive upper bound of the `today` view. */
function endOfTodayMs(now: number): number {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return end.getTime();
}

// --------------------------------------------------------------------------
// Input parsing (uniform "invalid" messages shared by HTTP and MCP)
// --------------------------------------------------------------------------

function asBody(input: unknown): Record<string, unknown> {
  return (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
}

function parseView(raw: unknown): QuickView | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === 'string' && (QUICK_VIEWS as readonly string[]).includes(raw)) {
    return raw as QuickView;
  }
  throw new TaskError('invalid', `view must be one of "current", "today", "blocked", "all", got: ${display(raw)}`);
}

function parseCwd(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw new TaskError('invalid', `cwd must be a non-empty absolute path, got: ${display(raw)}`);
  }
  return raw;
}

function parseFilter(raw: unknown): TaskFilter {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TaskError('invalid', `filter must be a JSON object of filter fields, got: ${display(raw)}`);
  }
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!(FILTER_FIELD_KEYS as readonly string[]).includes(key)) {
      throw new TaskError(
        'invalid',
        `unknown filter field "${key}" (allowed: ${FILTER_FIELD_KEYS.join(', ')})`,
      );
    }
  }

  const statuses = parseStatuses(body.status);
  const project = parseProjectRef(body.project);
  const tags = parseFilterTags(body.tags);
  const tagMode = parseTagMode(body.tagMode);
  const parentId = parseParent(body.parent);
  const hasParent = parseBoolean(body.hasParent, 'hasParent');
  const blocked = parseBoolean(body.blocked, 'blocked');
  const dueBefore = parseDatetime(body.dueBefore, 'dueBefore');
  const dueAfter = parseDatetime(body.dueAfter, 'dueAfter');
  const priorities = parsePriorities(body.priority);
  const text = parseText(body.text);
  const sort = parseSort(body.sort);
  const limit = parseLimit(body.limit);

  if (parentId !== undefined && hasParent === false) {
    throw new TaskError('invalid', 'parent and hasParent: false contradict each other; pass parent to list one parent\'s children or hasParent: false to list roots');
  }

  return {
    ...(statuses !== undefined ? { statuses } : {}),
    ...(project !== undefined ? { project } : {}),
    ...(tags !== undefined ? { tags } : {}),
    tagMode,
    ...(parentId !== undefined ? { parentId } : {}),
    ...(hasParent !== undefined ? { hasParent } : {}),
    ...(blocked !== undefined ? { blocked } : {}),
    ...(dueBefore !== undefined ? { dueBefore } : {}),
    ...(dueAfter !== undefined ? { dueAfter } : {}),
    ...(priorities !== undefined ? { priorities } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(sort !== undefined ? { sort } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function parseStatuses(raw: unknown): TaskStatus[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) {
    throw new TaskError('invalid', 'status must not be an empty array');
  }
  const statuses: TaskStatus[] = [];
  for (const entry of list) {
    if (typeof entry !== 'string' || !(TASK_STATUSES as readonly string[]).includes(entry)) {
      throw new TaskError(
        'invalid',
        `status must be one of "pending", "active", "waiting", "done", "dropped" (or an array of them), got: ${display(entry)}`,
      );
    }
    if (!statuses.includes(entry as TaskStatus)) {
      statuses.push(entry as TaskStatus);
    }
  }
  return statuses;
}

function parseProjectRef(raw: unknown): string | number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    return raw.trim();
  }
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    return raw;
  }
  throw new TaskError('invalid', `project must be a project name (string) or project id (integer), got: ${display(raw)}`);
}

function parseFilterTags(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new TaskError('invalid', `tags must be a non-empty array of strings, got: ${display(raw)}`);
  }
  const tags: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new TaskError('invalid', `each tag must be a non-empty string, got: ${display(entry)}`);
    }
    const tag = entry.trim().toLowerCase(); // tags are free-form lowercase strings (CONTEXT.md)
    if (!tags.includes(tag)) {
      tags.push(tag);
    }
  }
  return tags;
}

function parseTagMode(raw: unknown): 'any' | 'all' {
  if (raw === undefined || raw === null) {
    return 'any';
  }
  if (raw === 'any' || raw === 'all') {
    return raw;
  }
  throw new TaskError('invalid', `tagMode must be "any" or "all", got: ${display(raw)}`);
}

function parseParent(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    return raw;
  }
  throw new TaskError(
    'invalid',
    `parent must be a task id (integer), got: ${display(raw)}; to list root tasks pass hasParent: false`,
  );
}

function parseBoolean(raw: unknown, field: string): boolean | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === 'boolean') {
    return raw;
  }
  throw new TaskError('invalid', `${field} must be a boolean, got: ${display(raw)}`);
}

function parsePriorities(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) {
    throw new TaskError('invalid', 'priority must not be an empty array');
  }
  const priorities: string[] = [];
  for (const entry of list) {
    if (entry !== 'H' && entry !== 'M' && entry !== 'L') {
      throw new TaskError('invalid', `priority must be one of "H", "M", "L" (or an array of them), got: ${display(entry)}`);
    }
    if (!priorities.includes(entry)) {
      priorities.push(entry);
    }
  }
  return priorities;
}

function parseText(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new TaskError('invalid', `text must be a non-empty string (title substring), got: ${display(raw)}`);
  }
  return raw.trim().toLowerCase();
}

/** Accepts date or datetime strings in ISO-8601 shape (same convention as Task fields). */
function parseDatetime(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (
    typeof raw !== 'string' ||
    raw.trim() === '' ||
    !/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(raw.trim()) ||
    Number.isNaN(Date.parse(raw))
  ) {
    throw new TaskError('invalid', `${field} must be an ISO-8601 date or datetime string, got: ${display(raw)}`);
  }
  return raw.trim();
}

/** A sort entry is a field name ("due") or {field, direction}; a bare sort value may be one entry or an array. */
function parseSort(raw: unknown): SortSpec[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) {
    throw new TaskError('invalid', 'sort must not be an empty array');
  }
  return list.map(parseSortEntry);
}

function parseSortEntry(raw: unknown): SortSpec {
  let field: unknown;
  let direction: unknown;
  if (typeof raw === 'string') {
    field = raw;
  } else if (typeof raw === 'object' && raw !== null) {
    const entry = raw as Record<string, unknown>;
    field = entry.field;
    direction = entry.direction;
  } else {
    throw new TaskError('invalid', `each sort entry must be a field name or {field, direction}, got: ${display(raw)}`);
  }
  if (typeof field !== 'string' || !(SORT_FIELDS as readonly string[]).includes(field)) {
    throw new TaskError(
      'invalid',
      `sort field must be one of ${SORT_FIELDS.map((name) => `"${name}"`).join(', ')}, got: ${display(field)}`,
    );
  }
  if (direction === undefined) {
    direction = DEFAULT_SORT_DIRECTIONS[field as SortField];
  }
  if (direction !== 'asc' && direction !== 'desc') {
    throw new TaskError('invalid', `sort direction must be "asc" or "desc", got: ${display(direction)}`);
  }
  return { field: field as SortField, direction };
}

function parseLimit(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new TaskError('invalid', `limit must be a positive integer, got: ${display(raw)}`);
  }
  return raw;
}

function display(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}
