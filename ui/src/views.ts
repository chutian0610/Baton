import type { Task, TaskStatus } from './types';

/**
 * Client-side view derivation (v0.3 redesign, GitHub-issues-style status
 * filtering): the UI polls GET /tasks?view=all once and derives the task
 * TREE here, mirroring the server's query semantics (src/query.ts is the
 * reference — keep the two in lockstep):
 *
 * - The list header carries STATUS TABS: Open (pending+active+waiting — the
 *   composite the glossary calls open), Done, Dropped. One active at a time;
 *   within the Open tab an optional statusFilter narrows to specific
 *   statuses. The sidebar's Today/Blocked views are fixed composites that
 *   ignore tabs.
 * - Hidden gating (hidden-until still in the future) applies on the Open
 *   tab unless showHidden is on; the archive tabs (Done/Dropped) show
 *   hidden-flagged tasks regardless — hiding is a time mask, not a state.
 * - The tree: a task whose visible parent exists nests under it when the
 *   parent is expanded; an expanded parent brings ALL its in-scope children
 *   that belong to the included set — not only those that match the view
 *   (a parent surfaced by Today shows its open children regardless of their
 *   own due dates, like every list-based task manager). Children whose own
 *   parents are not visible stay top level.
 * - Scoping is explicit (a browser has no cwd — ADR-0006): 'all', Unbound,
 *   or one project id. Children inherit their parent's visibility by
 *   nesting, not by their own project — the node set is scope-filtered first.
 * - Ordering mirrors the server default at every level: due ascending (no
 *   due last), priority descending (H > M > L, none last), id ascending.
 */

export type ViewName = 'open' | 'today' | 'blocked';

export type StatusTab = 'open' | 'done' | 'dropped';

export interface StatusFilterState {
  /** The active status tab: Open aggregates pending/active/waiting. */
  tab: StatusTab;
  /** Within the Open tab: explicit statuses, or null for all three. */
  statuses: TaskStatus[] | null;
  /** Surface hidden-until tasks on the Open tab. */
  showHidden: boolean;
}

export type Scope = 'all' | 'unbound' | number;

/** The statuses the Open tab aggregates (the glossary's open set). */
export const OPEN_STATUSES: TaskStatus[] = ['pending', 'active', 'waiting'];

const PRIORITY_RANK: Record<string, number> = { H: 0, M: 1, L: 2 };
const NO_PRIORITY_RANK = 3;
const MAX_DEPTH = 50;

export function isHiddenNow(task: Task, now: number): boolean {
  return task.hiddenUntil !== null && Date.parse(task.hiddenUntil) > now;
}

/** The open set: pending/active/waiting, not hidden-until still in the future. */
export function isOpenBase(task: Task, now: number, showHidden = false): boolean {
  return OPEN_STATUSES.includes(task.status) && (showHidden || !isHiddenNow(task, now));
}

/** End of the local day containing `now`, in epoch ms. */
function endOfLocalDay(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
}

/** The search predicate: substring over the title or any tag. */
export function queryMatches(task: Task, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return true;
  }
  return task.title.toLowerCase().includes(needle) || task.tags.some((tag) => tag.includes(needle));
}

/**
 * Tab membership: which statuses the active tab shows. The archive tabs are
 * single-status; the Open tab aggregates the composite, narrowed by the
 * optional explicit status filter, with the hidden gate applied.
 */
function matchesTab(task: Task, status: StatusFilterState, now: number): boolean {
  if (status.tab === 'done') {
    return task.status === 'done';
  }
  if (status.tab === 'dropped') {
    return task.status === 'dropped';
  }
  if (!OPEN_STATUSES.includes(task.status)) {
    return false;
  }
  if (status.statuses !== null && !status.statuses.includes(task.status)) {
    return false;
  }
  return status.showHidden || !isHiddenNow(task, now);
}

/** Sidebar view membership: Today/Blocked are fixed composites (tabs ignored). */
export function matchesView(task: Task, view: ViewName, status: StatusFilterState, now: number): boolean {
  if (view === 'today') {
    return isOpenBase(task, now, status.showHidden) && task.due !== null && Date.parse(task.due) <= endOfLocalDay(now);
  }
  if (view === 'blocked') {
    return isOpenBase(task, now, status.showHidden) && task.blocked;
  }
  return matchesTab(task, status, now);
}

/** Included as a child under an expanded parent: tab membership WITHOUT the sidebar view narrowing. */
export function includedAsChild(task: Task, status: StatusFilterState, now: number): boolean {
  return matchesTab(task, status, now);
}

export function applyScope(tasks: Task[], scope: Scope): Task[] {
  if (scope === 'all') {
    return tasks;
  }
  if (scope === 'unbound') {
    return tasks.filter((task) => task.projectId === null);
  }
  return tasks.filter((task) => task.projectId === scope);
}

export function byDefaultOrder(a: Task, b: Task): number {
  const dueA = a.due === null ? Number.POSITIVE_INFINITY : Date.parse(a.due);
  const dueB = b.due === null ? Number.POSITIVE_INFINITY : Date.parse(b.due);
  if (dueA !== dueB) {
    return dueA - dueB;
  }
  const rankA = a.priority === null ? NO_PRIORITY_RANK : PRIORITY_RANK[a.priority];
  const rankB = b.priority === null ? NO_PRIORITY_RANK : PRIORITY_RANK[b.priority];
  if (rankA !== rankB) {
    return rankA - rankB;
  }
  return a.id - b.id;
}

export interface TaskNode {
  task: Task;
  /** Nesting depth among visible, expanded ancestors (top level = 0). */
  depth: number;
  /** Rendered children: present only while this node is expanded. */
  children: TaskNode[];
  /** Direct children in the store — for the count chip, expanded or not. */
  childCount: number;
  /** Whether this node is expanded (a childless node can expand to add its first subtask). */
  expanded: boolean;
}

export interface TreeOptions {
  view: ViewName;
  scope: Scope;
  status: StatusFilterState;
  now: number;
  expanded: ReadonlySet<number>;
  /** Case-insensitive substring over title and tags; '' disables it. */
  query: string;
}

/**
 * One derivation entry point: scope -> membership (sidebar view + tabs +
 * hidden gate + query) -> tree. Placement rule (the "surface at the highest
 * rendered level" rule): a task appears nested under its parent when the
 * parent appears AND is expanded; when the parent does not appear at all
 * (broken chain), a matching task surfaces at top level; when the parent
 * appears but is collapsed, its children stay behind the chevron. Every
 * level keeps the server-default order.
 */
export function buildTree(tasks: Task[], options: TreeOptions): TaskNode[] {
  const scoped = applyScope(tasks, options.scope);
  const byId = new Map(scoped.map((task) => [task.id, task]));

  const childrenOf = new Map<number, Task[]>();
  for (const task of scoped) {
    if (task.parentId !== null && byId.has(task.parentId)) {
      const list = childrenOf.get(task.parentId) ?? [];
      list.push(task);
      childrenOf.set(task.parentId, list);
    }
  }
  for (const list of childrenOf.values()) {
    list.sort(byDefaultOrder);
  }

  const inView = (task: Task) =>
    queryMatches(task, options.query) && matchesView(task, options.view, options.status, options.now);

  // Memoized appearance: a task appears when it matches the view, or when its
  // parent appears, is expanded, and the task belongs to the included set.
  const appearsMemo = new Map<number, boolean>();
  const visiting = new Set<number>();

  function appears(task: Task): boolean {
    const memo = appearsMemo.get(task.id);
    if (memo !== undefined) {
      return memo;
    }
    if (visiting.has(task.id)) {
      return false; // cycle guard — the store guarantees a tree anyway
    }
    visiting.add(task.id);
    let result = inView(task);
    if (!result && task.parentId !== null) {
      const parent = byId.get(task.parentId);
      result =
        parent !== undefined &&
        appears(parent) &&
        options.expanded.has(parent.id) &&
        includedAsChild(task, options.status, options.now);
    }
    visiting.delete(task.id);
    appearsMemo.set(task.id, result);
    return result;
  }

  function parentRendered(task: Task): boolean {
    if (task.parentId === null) {
      return false;
    }
    const parent = byId.get(task.parentId);
    return parent !== undefined && appears(parent);
  }

  function nodeFor(task: Task, depth: number): TaskNode {
    const expanded = options.expanded.has(task.id);
    const node: TaskNode = { task, depth, children: [], childCount: childrenOf.get(task.id)?.length ?? 0, expanded };
    if (!expanded) {
      return node;
    }
    for (const child of childrenOf.get(task.id) ?? []) {
      if (!appears(child)) {
        continue;
      }
      if (depth >= MAX_DEPTH) {
        continue;
      }
      node.children.push(nodeFor(child, depth + 1));
    }
    return node;
  }

  return scoped
    .filter((task) => appears(task) && !parentRendered(task))
    .sort(byDefaultOrder)
    .map((task) => nodeFor(task, 0));
}

export interface ViewCounts {
  open: number;
  today: number;
  blocked: number;
  done: number;
  dropped: number;
  /** Open Unbound tasks across the whole store (sidebar chip). */
  unbound: number;
}

/** Sidebar + tab counts: views for the current scope, Unbound across the store. */
export function countViews(tasks: Task[], scope: Scope, now: number): ViewCounts {
  const scoped = applyScope(tasks, scope);
  const count = (predicate: (task: Task) => boolean) => scoped.filter(predicate).length;
  return {
    open: count((task) => isOpenBase(task, now)),
    today: count((task) => matchesView(task, 'today', { tab: 'open', statuses: null, showHidden: false }, now)),
    blocked: count((task) => matchesView(task, 'blocked', { tab: 'open', statuses: null, showHidden: false }, now)),
    done: count((task) => task.status === 'done'),
    dropped: count((task) => task.status === 'dropped'),
    unbound: tasks.filter((task) => task.projectId === null && isOpenBase(task, now)).length,
  };
}
