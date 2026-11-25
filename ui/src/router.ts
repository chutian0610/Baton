/**
 * Minimal history-based router (v0.3 T4): the daemon serves the shell for
 * every /ui/* path (SPA fallback), so client-side routing owns the URL space.
 * Two shapes exist for v0.3: the list root and /ui/tasks/:id (task detail).
 */

export type Route = { name: 'list' } | { name: 'task'; id: number };

export function parseRoute(path: string): Route {
  const match = path.match(/^\/ui\/tasks\/(\d+)\/?$/);
  if (match !== null) {
    return { name: 'task', id: Number(match[1]) };
  }
  return { name: 'list' };
}

export function currentPath(): string {
  return window.location.pathname;
}

const listeners = new Set<(path: string) => void>();

function notify(): void {
  const path = currentPath();
  for (const listener of listeners) {
    listener(path);
  }
}

/** Navigate within the SPA (no reload); popstate (back/forward) also notifies. */
export function navigate(path: string): void {
  window.history.pushState({}, '', path);
  notify();
}

/** Subscribes to path changes; returns the unsubscribe function. */
export function onPathChange(listener: (path: string) => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', notify);
  return () => {
    listeners.delete(listener);
  };
}
