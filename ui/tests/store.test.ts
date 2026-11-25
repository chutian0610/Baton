import { afterAll, beforeAll, expect, test } from 'vitest';
import { startDaemon, type DaemonHandle } from '../../tests/helpers/daemon.js';
import { createHttpApi, type Api } from '../src/api.js';
import { createStore } from '../src/store.js';

/**
 * The polling store against a REAL daemon (v0.3 T3): refresh populates the
 * reactive state, ticks fetch only while the (injected) visibility probe
 * says visible, the project scope persists through the injected storage, and
 * a dead-transport refresh lands in state.error — never a thrown error out
 * of the polling loop.
 *
 * Deliberately no DOM environment: the store guards its document/localStorage
 * defaults, and everything here runs through injectables. The default
 * browser wiring (window.localStorage, document.visibilityState) is covered
 * by the mounted component tests from T4 on.
 */

let daemon: DaemonHandle;
let api: Api;

function countingApi(inner: Api): Api & { count: () => number } {
  let reads = 0;
  const wrapped: Api = {
    async listTasks() {
      reads += 1;
      return inner.listTasks();
    },
    async listProjects() {
      reads += 1;
      return inner.listProjects();
    },
  };
  return { ...wrapped, count: () => reads };
}

function mapStorage(): Pick<Storage, 'getItem' | 'setItem'> & { dump: () => Map<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    dump: () => map,
  };
}

beforeAll(async () => {
  daemon = await startDaemon();
  api = createHttpApi(daemon.baseUrl);
  await fetch(`${daemon.baseUrl}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'store seed' }),
  });
});

afterAll(async () => {
  await daemon.stop();
});

test('refresh populates tasks and projects; the derived list reflects the open view', async () => {
  const store = createStore({ api, storage: mapStorage() });
  await store.refresh();
  expect(store.state.tasks.length).toBeGreaterThanOrEqual(1);
  expect(store.state.projects).toEqual([]);
  expect(store.state.error).toBeNull();
  expect(store.state.lastSync).not.toBeNull();
  expect(store.list.value.map((task) => task.title)).toContain('store seed'); // Unbound, in the global open view
  store.stop();
});

test('tick fetches only while visible: hidden tabs pause polling without listeners', async () => {
  const counted = countingApi(api);
  let visible = false;
  const store = createStore({ api: counted, isVisible: () => visible, storage: mapStorage() });

  store.tick();
  expect(counted.count()).toBe(0); // hidden: the tick is a no-op

  visible = true;
  store.tick();
  await Promise.resolve(); // let the fetches land
  expect(counted.count()).toBe(2); // tasks + projects
  store.stop();
});

test('the project scope persists through the storage backend and restores into a fresh store', async () => {
  await fetch(`${daemon.baseUrl}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'persist', paths: ['/workspace/persist'] }),
  });
  const project = ((await (await fetch(`${daemon.baseUrl}/projects`)).json()) as {
    projects: { id: number; name: string }[];
  }).projects.find((entry) => entry.name === 'persist')!;

  const storage = mapStorage();
  const first = createStore({ api, storage });
  first.setScope(project.id);
  expect(first.state.scope).toBe(project.id);
  expect(storage.dump().get('baton.scope')).toContain('project');

  // a fresh store (a reload in the browser) restores the selection
  const second = createStore({ api, storage });
  expect(second.state.scope).toBe(project.id);
});

test('setView changes the derived list without refetching', async () => {
  const counted = countingApi(api);
  const store = createStore({ api: counted, storage: mapStorage() });
  await store.refresh();
  const readsAfterRefresh = counted.count();

  store.setView('blocked');
  expect(store.state.view).toBe('blocked');
  void store.list.value; // recompute is pure client-side
  expect(counted.count()).toBe(readsAfterRefresh);
  store.stop();
});

test('a dead transport lands in state.error instead of throwing out of the loop', async () => {
  const dead: Api = {
    listTasks: () => fetch('http://127.0.0.1:9/tasks?view=all').then((r) => r.json()),
    listProjects: () => fetch('http://127.0.0.1:9/projects').then((r) => r.json()),
  };
  const store = createStore({ api: dead, storage: mapStorage() });
  await store.refresh();
  expect(store.state.error).toBeTruthy();
  expect(store.state.loading).toBe(false);
  store.stop();
});
