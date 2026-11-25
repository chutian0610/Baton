// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { startDaemon, type DaemonHandle } from '../../tests/helpers/daemon.js';
import { createHttpApi } from '../src/api.js';
import { createStore } from '../src/store.js';
import App from '../src/App.vue';

/**
 * The list views, mounted (v0.3 T4): App against a REAL daemon via the
 * injected api base. Covers the four entry views (tabs + picker scoping),
 * the visibility toggles with their badges, single-parent indentation in the
 * tree, and navigation into the task detail route.
 */

let daemon: DaemonHandle;
let project: { id: number };
let parentId: number;

const GLOBAL = {
  provide: { apiBase: '' }, // filled per-file once the daemon port is known
};

async function seed(title: string, extra: Record<string, unknown> = {}): Promise<{ id: number }> {
  const response = await fetch(`${daemon.baseUrl}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, project: 'tree', ...extra }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { task: { id: number } }).task;
}

async function patch(id: number, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${daemon.baseUrl}/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
}

beforeAll(async () => {
  daemon = await startDaemon();
  GLOBAL.provide.apiBase = daemon.baseUrl;
  // Put the DOM window on the daemon's origin: the same-origin API transport
  // then behaves exactly as in production — and the daemon's Origin/Host
  // drive-by guard (T1) correctly rejects what would otherwise be a
  // cross-site browser request from a foreign window origin.
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(daemon.baseUrl);
  // vitest copies window members onto the global unbound; bare fetch(...) then
  // loses its window `this` and the transport misbehaves. Rebind explicitly.
  globalThis.fetch = window.fetch.bind(window);

  project = (
    (
      await (
        await fetch(`${daemon.baseUrl}/projects`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'tree', paths: ['/workspace/tree'] }),
        })
      ).json()
    ).project
  );

  const now = Date.now();
  // the child sorts before its parent (earlier due) — the indent must carry the nesting
  const parent = await seed('parent tree node', { due: new Date(now + 3 * 24 * 3600_000).toISOString() });
  parentId = parent.id;
  await seed('child due earlier', { due: new Date(now - 24 * 3600_000).toISOString(), parent: parent.id });
  const done = await seed('finished thing');
  await patch(done.id, { status: 'done' });
  const blocker = await seed('the blocker');
  await seed('blocked child', { deps: [blocker.id], parent: parent.id });
  // seeded up front: an Unbound task the picker can isolate (post-mount seeds
  // would only surface on the next poll tick)
  await seed('unbound stray', { project: null });
});

afterAll(async () => {
  await daemon.stop();
});

beforeEach(() => {
  window.localStorage.clear();
  window.history.pushState({}, '', '/ui');
});

async function mountApp() {
  // The store is injected so the first refresh can be awaited deterministically —
  // flushPromises alone does not wait out happy-dom's real network I/O, and the
  // mount-time DOM patches lag the reactive state by a scheduler tick.
  const store = createStore({ api: createHttpApi(daemon.baseUrl) });
  const wrapper = mount(App, {
    global: { provide: { apiBase: daemon.baseUrl, store } },
  });
  await store.refresh();
  await flushPromises();
  await wrapper.vm.$nextTick();
  return wrapper;
}

function visibleTitles(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('.task-link').map((node) => node.text());
}

test('the open view renders the tree: sorted rows, indented children, progress and badges', async () => {
  const wrapper = await mountApp();

  const titles = visibleTitles(wrapper);
  expect(titles).toContain('parent tree node');
  expect(titles).toContain('child due earlier'); // overdue child — in Open and ahead of its parent
  expect(titles).not.toContain('finished thing'); // default exclusions hold

  // single-parent nesting: both children are one level deep
  const childRows = wrapper.findAll('.task-row').filter((row) =>
    ['child due earlier', 'blocked child'].includes(row.find('.task-link').text()),
  );
  for (const row of childRows) {
    expect(row.classes()).toContain('depth-1');
  }

  // the parent shows its derived progress; the blocked child carries the badge
  const parentRow = wrapper.findAll('.task-row').find((row) => row.find('.task-link').text() === 'parent tree node')!;
  expect(parentRow.find('.progress').text()).toMatch(/^\d+%$/);
  const blockedRow = wrapper.findAll('.task-row').find((row) => row.find('.task-link').text() === 'blocked child')!;
  expect(blockedRow.find('.badge-blocked').exists()).toBe(true);

  await wrapper.unmount();
});

test('switching to Today narrows the rows to due-today-or-overdue open tasks', async () => {
  const wrapper = await mountApp();

  await wrapper.find('.view-tabs button:nth-child(2)').trigger('click');
  await wrapper.vm.$nextTick();

  const titles = visibleTitles(wrapper);
  expect(titles).toEqual(['child due earlier']); // overdue child only; future-due parent and no-due tasks are out

  await wrapper.unmount();
});

test('the done toggle re-adds finished work with a badge and a live count', async () => {
  const wrapper = await mountApp();

  expect(visibleTitles(wrapper)).not.toContain('finished thing');
  const doneToggle = wrapper.findAll('.visibility-toggle').find((node) => node.text().startsWith('done'))!;
  expect(doneToggle.find('.count').text()).toBe('1');

  await doneToggle.find('input').setValue(true);
  await wrapper.vm.$nextTick();

  expect(visibleTitles(wrapper)).toContain('finished thing');
  const doneRow = wrapper.findAll('.task-row').find((row) => row.find('.task-link').text() === 'finished thing')!;
  expect(doneRow.find('.badge-done').exists()).toBe(true);

  await wrapper.unmount();
});

test('the picker scopes the tree to a project; Unbound isolates', async () => {
  const wrapper = await mountApp();

  await wrapper.find('.project-picker').setValue(String(project.id));
  await wrapper.vm.$nextTick();
  expect(visibleTitles(wrapper)).not.toContain('unbound stray');

  await wrapper.find('.project-picker').setValue('unbound');
  await wrapper.vm.$nextTick();
  expect(visibleTitles(wrapper)).toEqual(['unbound stray']);

  await wrapper.unmount();
});

test('clicking a task navigates into the detail route; back returns to the list', async () => {
  const wrapper = await mountApp();

  await wrapper.findAll('.task-link').find((node) => node.text() === 'parent tree node')!.trigger('click');
  // the detail fetch rides real network I/O — wait for the h1 (T5)
  for (let i = 0; i < 100 && !wrapper.find('h1').exists(); i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  expect(window.location.pathname).toBe(`/ui/tasks/${parentId}`);
  expect(wrapper.find('h1').text()).toBe('parent tree node');

  await wrapper.find('main button.back').trigger('click'); // ← Back
  await flushPromises();
  await wrapper.vm.$nextTick();
  expect(window.location.pathname).toBe('/ui');
  expect(wrapper.findAll('.task-row').length).toBeGreaterThan(0);

  await wrapper.unmount();
});
