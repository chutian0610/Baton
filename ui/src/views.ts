import type { Task } from './types';

/**
 * Client-side view derivation (v0.3 T3): the UI polls GET /tasks?view=all
 * once and derives every entry view here, mirroring the server's own query
 * semantics (src/query.ts is the reference — keep the two in lockstep):
 *
 * - The default view is the OPEN set: not done, not dropped, not hidden-until
 *   still in the future.
 * - `today` narrows the open set to tasks due today or overdue (due <= end of
 *   today, local time — same-machine daemon and browser share a timezone).
 * - `blocked` narrows it to tasks whose derived blocked flag is true.
 * - The visibility toggles ADD their set back on top of a view: done and
 *   dropped tasks, and hidden tasks that are otherwise open — each badgeable,
 *   and never erasing the default exclusions for everything else.
 * - Scoping is explicit (a browser has no cwd — ADR-0006): 'all', Unbound,
 *   or one project id.
 * - Ordering mirrors the server default: due ascending (no due last), then
 *   priority descending (H > M > L, none last), then id ascending.
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

/** The tasks a visibility toggle adds back on top of a view (disjoint from the open set). */
export function toggleExtras(tasks: Task[], visibility: Visibility, now: number): Task[] {
  return tasks.filter((task) => {
    if (task.status === 'done') {
      return visibility.showDone;
    }
    if (task.status === 'dropped') {
      return visibility.showDropped;
    }
    return visibility.showHidden && isHiddenNow(task, now);
  });
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

export interface DeriveOptions {
  view: ViewName;
  scope: Scope;
  visibility: Visibility;
  now: number;
}

/** One derivation entry point: scope -> view -> toggles -> server-default order. */
export function deriveList(tasks: Task[], options: DeriveOptions): Task[] {
  const scoped = applyScope(tasks, options.scope);
  const listed = scoped.filter((task) => matchesView(task, options.view, options.now));
  const extras = toggleExtras(scoped, options.visibility, options.now);
  return [...listed, ...extras].sort(byDefaultOrder);
}
