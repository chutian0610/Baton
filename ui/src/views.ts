import type { Task } from './types';

/**
 * Client-side view derivation (v0.3 redesign): the UI polls
 * GET /tasks?view=all once and derives the task TREE here, mirroring the
 * server's query semantics (src/query.ts is the reference — keep the two in
 * lockstep):
 *
 * - Membership in a view: the open set (not done, not dropped, not
 *   hidden-until still in the future), narrowed by `today` (due today or
 *   overdue, local end-of-day) or `blocked` (derived flag); the visibility
 *   toggles re-add their set.
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

export interface Visibility {
  showHidden: boolean;
  showDone: boolean;
  showDropped: boolean;
}

export type Scope = 'all' | 'unbound' | number;

const PRIORITY_RANK: Record<string, number> = { H: 0, M: 1, L: 2 };
const NO_PRIORITY_RANK = 3;

export function isHiddenNow(task: Task, now: number): boolean {
  return task.hiddenUntil !== null && Date.parse(task.hiddenUntil) > now;
}

/** The open set: not done/dropped and not hidden-until still in the future. */
export function isOpenBase(task: Task, now: number): boolean {
  return task.status !== 'done' && task.status !== 'dropped' && !isHiddenNow(task, now);
}

/** End of the local day containing `now`, in epoch ms. */
function endOfLocalDay(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
}

export function matchesView(task: Task, view: ViewName, now: number): boolean {
  if (!isOpenBase(task, now)) {
    return false;
  }
  if (view === 'today') {
    return task.due !== null && Date.parse(task.due) <= endOfLocalDay(now);
  }
  if (view === 'blocked') {
    return task.blocked;
  }
  return true;
}

/**
 * The set a visibility toggle adds back on top of a view: done and dropped
 * tasks, and hidden tasks that are otherwise open — each badgeable, never
 * erasing the default exclusions for everything else.
 */
export function toggledIn(task: Task, visibility: Visibility, now: number): boolean {
  if (task.status === 'done') {
    return visibility.showDone;
  }
  if (task.status === 'dropped') {
    return visibility.showDropped;
  }
  return visibility.showHidden && isHiddenNow(task, now);
}

/** Included as a child under an expanded parent: the included set, no view filter. */
export function includedAsChild(task: Task, visibility: Visibility, now: number): boolean {
  return isOpenBase(task, now) || toggledIn(task, visibility, now);
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
}

export interface TreeOptions {
  view: ViewName;
  scope: Scope;
  visibility: Visibility;
  now: number;
  expanded: ReadonlySet<number>;
}

const MAX_DEPTH = 50;

/**
 * One derivation entry point: scope -> membership (view + toggles) -> tree.
 * Placement rule (the "surface at the highest rendered level" rule): a task
 * appears nested under its parent when the parent appears AND is expanded;
 * when the parent does not appear at all (broken chain — e.g. the parent
 * does not match the view), a view-matching task surfaces at top level;
 * when the parent appears but is collapsed, its children stay behind the
 * chevron. Every level keeps the server-default order.
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

  const inView = (task: Task) => matchesView(task, options.view, options.now) || toggledIn(task, options.visibility, options.now);

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
        includedAsChild(task, options.visibility, options.now);
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
    const node: TaskNode = { task, depth, children: [], childCount: childrenOf.get(task.id)?.length ?? 0 };
    if (!options.expanded.has(task.id)) {
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
  /** Open Unbound tasks across the whole store (sidebar chip). */
  unbound: number;
}

/** Sidebar counts: views for the current scope, Unbound across the store. */
export function countViews(tasks: Task[], scope: Scope, now: number): ViewCounts {
  const scoped = applyScope(tasks, scope);
  return {
    open: scoped.filter((task) => matchesView(task, 'open', now)).length,
    today: scoped.filter((task) => matchesView(task, 'today', now)).length,
    blocked: scoped.filter((task) => matchesView(task, 'blocked', now)).length,
    unbound: tasks.filter((task) => task.projectId === null && matchesView(task, 'open', now)).length,
  };
}
