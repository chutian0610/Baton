import { computed, reactive, type Ref } from 'vue';
import { createHttpApi, type Api } from './api';
import { buildTree, countViews, type Scope, type TaskNode, type ViewCounts, type ViewName, type Visibility } from './views';
import type { Project, Task } from './types';

/**
 * The polling store (v0.3 T3): one reactive state over the read spine.
 * Polls GET /tasks?view=all + GET /projects on an interval and derives the
 * current list client-side (src/views.ts). Each tick checks visibility first
 * and skips the fetch entirely while the tab is hidden — polling pauses when
 * hidden and resumes on the next tick after focus, with no listener
 * lifecycle to manage.
 *
 * Injectables keep this testable at the real-daemon seam without fake
 * timers: the api transport, the poll interval, a visibility getter, and
 * the persistence backend all come in through options (ADR-conformant: the
 * test suite runs against a real daemon, never against mocks of the domain).
 */

const SCOPE_KEY = 'baton.scope';
const DEFAULT_POLL_MS = 5000;

interface PersistedScope {
  view: 'all' | 'unbound' | 'project';
  id?: number;
}

function serializeScope(scope: Scope): string {
  if (scope === 'all' || scope === 'unbound') {
    return JSON.stringify({ view: scope } satisfies PersistedScope);
  }
  return JSON.stringify({ view: 'project', id: scope } satisfies PersistedScope);
}

function parseScope(raw: string | null): Scope | undefined {
  if (raw === null) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as PersistedScope;
    if (parsed.view === 'all' || parsed.view === 'unbound') {
      return parsed.view;
    }
    if (parsed.view === 'project' && typeof parsed.id === 'number') {
      return parsed.id;
    }
  } catch {
    // corrupted value falls through to the default scope
  }
  return undefined;
}

export interface StoreOptions {
  /** Poll interval in ms (default 5000). */
  pollMs?: number;
  /** The API transport (default: same-origin fetch). */
  api?: Api;
  /** Persistence for the project scope (default: window.localStorage when available). */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Visibility probe each tick consults (default: document.visibilityState). */
  isVisible?: () => boolean;
  /** Clock for derivation (default: Date.now). */
  now?: () => number;
}

export interface Store {
  state: {
    tasks: Task[];
    projects: Project[];
    error: string | null;
    loading: boolean;
    lastSync: number | null;
    view: ViewName;
    scope: Scope;
    visibility: Visibility;
    /** Ids of tree nodes currently expanded (session-scoped, not persisted). */
    expanded: Set<number>;
    /** Search query: substring over title/tags, narrowing the current view. */
    query: string;
  };
  /** The derived tree for the current view/scope/visibility/expanded set. */
  tree: Ref<TaskNode[]>;
  /** Sidebar counts for the current scope. */
  counts: Ref<ViewCounts>;
  refresh(): Promise<void>;
  /** One polling step: fetch unless the tab is hidden. */
  tick(): void;
  start(): void;
  stop(): void;
  setView(view: ViewName): void;
  setScope(scope: Scope): void;
  setVisibility(visibility: Visibility): void;
  setQuery(query: string): void;
  toggleExpanded(id: number): void;
}

export function createStore(options: StoreOptions = {}): Store {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const api = options.api ?? createHttpApi();
  const isVisible =
    options.isVisible ??
    (typeof document === 'undefined' ? () => true : () => document.visibilityState === 'visible');
  const now = options.now ?? Date.now;
  const storage =
    options.storage !== undefined
      ? options.storage
      : typeof localStorage === 'undefined'
        ? null
        : localStorage;

  const state = reactive({
    tasks: [] as Task[],
    projects: [] as Project[],
    error: null as string | null,
    loading: false,
    lastSync: null as number | null,
    view: 'open' as ViewName,
    scope: 'all' as Scope,
    visibility: { showHidden: false, showDone: false, showDropped: false },
    expanded: new Set<number>(),
    query: '',
  });

  const restored = parseScope(storage?.getItem(SCOPE_KEY) ?? null);
  if (restored !== undefined) {
    state.scope = restored;
  }

  const tree = computed(() =>
    buildTree(state.tasks, {
      view: state.view,
      scope: state.scope,
      visibility: state.visibility,
      now: now(),
      expanded: state.expanded,
      query: state.query,
    }),
  );

  const counts = computed(() => countViews(state.tasks, state.scope, now()));

  async function refresh(): Promise<void> {
    state.loading = true;
    try {
      const [tasksPayload, projectsPayload] = await Promise.all([api.listTasks(), api.listProjects()]);
      state.tasks = tasksPayload.tasks;
      state.projects = projectsPayload.projects;
      state.error = null;
      state.lastSync = now();
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    } finally {
      state.loading = false;
    }
  }

  function tick(): void {
    if (isVisible()) {
      void refresh();
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined;

  return {
    state,
    tree,
    counts,
    refresh,
    tick,
    start() {
      void refresh();
      timer = setInterval(tick, pollMs);
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    setView(view: ViewName) {
      state.view = view;
    },
    setScope(scope: Scope) {
      state.scope = scope;
      storage?.setItem(SCOPE_KEY, serializeScope(scope));
    },
    setVisibility(visibility: Visibility) {
      state.visibility = visibility;
    },
    setQuery(query: string) {
      state.query = query;
    },
    toggleExpanded(id: number) {
      if (state.expanded.has(id)) {
        state.expanded.delete(id);
      } else {
        state.expanded.add(id);
      }
    },
  };
}
