// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { startDaemon, type DaemonHandle } from '../../tests/helpers/daemon.js';
import { createHttpApi } from '../src/api.js';
import { createStore } from '../src/store.js';
import App from '../src/App.vue';

/**
 * The redesigned shell, mounted (v0.3 redesign): sidebar views + project
 * scoping, the expandable task tree, inline subtask creation, the completion
 * circle, the quick-add bar, and the detail panel — all against a REAL
 * daemon via the injected api base.
 */

let daemon: DaemonHandle;
let projectId!: number;
let parentId!: number;

const ORIGIN = () => `http://127.0.0.1:${daemon.port}`;

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
  (globalThis as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(daemon.baseUrl);
  globalThis.fetch = window.fetch.bind(globalThis);

  projectId = (
    (
      await (
        await fetch(`${daemon.baseUrl}/projects`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'tree', paths: ['/workspace/tree'] }),
        })
      ).json()
    ).project as { id: number }
  ).id;

  const now = Date.now();
  const parent = await seed('parent tree node', { due: new Date(now + 3 * 24 * 3600_000).toISOString() });
  parentId = parent.id;
  await seed('child due earlier', { due: new Date(now - 24 * 3600_000).toISOString(), parent: parent.id });
  const done = await seed('finished thing');
  await patch(done.id, { status: 'done' });
  const blocker = await seed('the blocker');
  await seed('blocked child', { deps: [blocker.id], parent: parent.id });
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
  const store = createStore({ api: createHttpApi(daemon.baseUrl) });
  const wrapper = mount(App, {
    global: { provide: { apiBase: daemon.baseUrl, store } },
  });
  await store.refresh();
  await flushPromises();
  await wrapper.vm.$nextTick();
  return wrapper;
}

function rowTitles(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('.task-row .title').map((node) => node.text());
}

function sidebarItem(wrapper: ReturnType<typeof mount>, label: string) {
  return wrapper.findAll('.nav-item').find((node) => node.text().startsWith(label))!;
}

test('the sidebar shows views with counts and switches the active view', async () => {
  const wrapper = await mountApp();

  expect(rowTitles(wrapper)).toContain('parent tree node');
  expect(rowTitles(wrapper)).not.toContain('finished thing');

  // the status dropdown: archive statuses are disabled (their tabs own them),
  // and the button carries no active badge while no explicit filter is set
  expect(wrapper.find('.filter-badge').exists()).toBe(false);
  await wrapper.find('.filter-button').trigger('click');
  await wrapper.vm.$nextTick();
  const doneOption = wrapper.findAll('.filter-option').find((node) => node.text().startsWith('Done'))!;
  expect(doneOption.find('input').attributes('disabled')).toBeDefined();
  await wrapper.find('.filter-button').trigger('click'); // close again
  await wrapper.vm.$nextTick();

  await sidebarItem(wrapper, 'Today').trigger('click');
  await wrapper.vm.$nextTick();
  // the overdue child matches Today; its parent does not — the child renders
  // top-level because no visible ancestor exists
  expect(rowTitles(wrapper)).toEqual(['child due earlier']);
  expect(sidebarItem(wrapper, 'Today').classes()).toContain('active');

  await sidebarItem(wrapper, 'Open').trigger('click');
  await wrapper.vm.$nextTick();
  expect(rowTitles(wrapper)).toContain('parent tree node');

  await wrapper.unmount();
});

test('project scoping lives in the sidebar; Unbound isolates', async () => {
  const wrapper = await mountApp();

  await sidebarItem(wrapper, 'tree').trigger('click');
  await wrapper.vm.$nextTick();
  expect(rowTitles(wrapper)).not.toContain('unbound stray');

  await sidebarItem(wrapper, 'Unbound').trigger('click');
  await wrapper.vm.$nextTick();
  expect(rowTitles(wrapper)).toEqual(['unbound stray']);

  await sidebarItem(wrapper, 'All projects').trigger('click');
  await wrapper.vm.$nextTick();
  expect(rowTitles(wrapper)).toContain('unbound stray');

  await wrapper.unmount();
});

test('the tree expands and collapses; the count chip counts children either way', async () => {
  const wrapper = await mountApp();

  const row = () => wrapper.findAll('.task-row').find((node) => node.find('.title').text() === 'parent tree node')!;
  expect(row().find('.chevron').exists()).toBe(true);
  expect(row().find('.subtask-count').text()).toBe('2'); // child due earlier + blocked child
  expect(wrapper.findAll('.task-row').filter((node) => node.find('.title').text() === 'child due earlier').length).toBe(0);

  await row().find('.chevron').trigger('click');
  await wrapper.vm.$nextTick();
  expect(rowTitles(wrapper)).toContain('child due earlier');
  expect(rowTitles(wrapper)).toContain('blocked child');
  const childRow = wrapper
    .findAll('.task-row')
    .find((node) => node.find('.title').text() === 'child due earlier')!;
  expect(childRow.classes()).toContain('status-pending');

  await row().find('.chevron').trigger('click');
  await wrapper.vm.$nextTick();
  expect(rowTitles(wrapper)).not.toContain('child due earlier');

  await wrapper.unmount();
});

test('inline add-subtask creates a child under the parent, inheriting its project', async () => {
  const wrapper = await mountApp();

  await wrapper.findAll('.task-row').find((node) => node.find('.title').text() === 'parent tree node')!.find('.chevron').trigger('click');
  await wrapper.vm.$nextTick();

  const addForm = wrapper.find('form.add-subtask');
  await addForm.find('input').setValue('added inline from the tree');
  await addForm.find('button').trigger('submit');
  await waitFor(() => rowTitles(wrapper).includes('added inline from the tree'), 'new subtask rendered');

  const all = (await (await fetch(`${daemon.baseUrl}/tasks?view=all`)).json()).tasks as {
    title: string;
    parentId: number | null;
    projectId: number | null;
  }[];
  const created = all.find((task) => task.title === 'added inline from the tree')!;
  expect(created.parentId).toBe(parentId);
  expect(created.projectId).toBe(projectId); // inherited from the parent at create

  await wrapper.unmount();
});

test('a childless task offers the subtask entry too: first subtask creation', async () => {
  const wrapper = await mountApp();

  // 'unbound stray' has no children — its chevron is the dim placeholder style,
  // but expanding must still reveal the inline add-subtask input
  const row = () => wrapper.findAll('.task-row').find((node) => node.find('.title').text() === 'unbound stray')!;
  expect(row().find('.chevron').classes()).toContain('empty');

  await row().find('.chevron').trigger('click');
  await wrapper.vm.$nextTick();
  const addForm = () => wrapper.findAll('form.add-subtask').find((node) => node.find('input').attributes('aria-label') === 'New subtask title under unbound stray');
  expect(addForm()).toBeTruthy();

  await addForm()!.find('input').setValue('the very first subtask');
  await addForm()!.find('button').trigger('submit');
  await waitFor(() => rowTitles(wrapper).includes('the very first subtask'), 'first subtask rendered under its parent');

  const all = (await (await fetch(`${daemon.baseUrl}/tasks?view=all`)).json()).tasks as {
    id: number;
    title: string;
    parentId: number | null;
  }[];
  expect(all.find((task) => task.title === 'the very first subtask')!.parentId).toBe(
    all.find((task) => task.title === 'unbound stray')!.id,
  );

  await wrapper.unmount();
});

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await flushPromises();
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`condition not met in time: ${what}`);
}

test('the completion circle closes a task, and reopens it via the showDone toggle', async () => {
  const wrapper = await mountApp();

  // complete: the row leaves the Open view (default exclusions hold)
  const row = () => wrapper.findAll('.task-row').find((node) => node.find('.title').text() === 'unbound stray')!;
  await row().find('.check').trigger('click');
  await waitFor(() => rowTitles(wrapper).includes('unbound stray') === false, 'completed task left the open view');
  const all = (await (await fetch(`${daemon.baseUrl}/tasks?view=all`)).json()).tasks as {
    title: string;
    status: string;
  }[];
  expect(all.find((task) => task.title === 'unbound stray')!.status).toBe('done');

  // the Done status tab surfaces it again — with the filled circle
  await wrapper.findAll('.status-tab').find((node) => node.text().startsWith('Done'))!.trigger('click');
  await wrapper.vm.$nextTick();
  const doneRow = () => wrapper.findAll('.task-row').find((node) => node.find('.title').text() === 'unbound stray')!;
  await waitFor(() => doneRow().find('.check').classes().includes('done'), 'done row visible on the Done tab');

  // the same circle reopens it: pending again — which moves it off the Done
  // tab; back on Open it is visible with an open circle
  await doneRow().find('.check').trigger('click');
  await wrapper.findAll('.status-tab').find((node) => node.text().startsWith('Open'))!.trigger('click');
  await waitFor(() => {
    const reopened = wrapper.findAll('.task-row').find((node) => node.find('.title').text() === 'unbound stray');
    return reopened !== undefined && !reopened.find('.check').classes().includes('done');
  }, 'task reopened on the Open tab');
  const after = (await (await fetch(`${daemon.baseUrl}/tasks?view=all`)).json()).tasks as {
    title: string;
    status: string;
  }[];
  expect(after.find((task) => task.title === 'unbound stray')!.status).toBe('pending');

  await wrapper.unmount();
});

test('the quick-add bar captures into the current scope; optional fields fold away', async () => {
  const wrapper = await mountApp();

  await wrapper.find('input[aria-label="New task title"]').setValue('quick captured');
  await wrapper.find('form.quick-add').trigger('submit');
  await waitFor(() => rowTitles(wrapper).includes('quick captured'), 'quick-add result in tree');

  const all = (await (await fetch(`${daemon.baseUrl}/tasks?view=all`)).json()).tasks as {
    title: string;
    projectId: number | null;
  }[];
  expect(all.find((task) => task.title === 'quick captured')!.projectId).toBeNull(); // scope = all → Unbound

  await sidebarItem(wrapper, 'tree').trigger('click');
  await wrapper.vm.$nextTick();
  await wrapper.find('input[aria-label="New task title"]').setValue('scoped capture');
  await wrapper.find('form.quick-add').trigger('submit');
  await waitFor(() => rowTitles(wrapper).includes('scoped capture'), 'scoped quick-add result in tree');

  const scoped = (await (await fetch(`${daemon.baseUrl}/tasks?view=all`)).json()).tasks as {
    title: string;
    projectId: number | null;
  }[];
  expect(scoped.find((task) => task.title === 'scoped capture')!.projectId).toBe(projectId);

  await wrapper.unmount();
});

test('clicking a title opens the detail panel; ✕ returns to the list', async () => {
  const wrapper = await mountApp();

  await wrapper.findAll('.task-row .title').find((node) => node.text() === 'parent tree node')!.trigger('click');
  await waitFor(() => wrapper.find('.detail-panel h1').exists() && wrapper.find('.detail-panel h1').text() === 'parent tree node', 'panel opened');
  expect(window.location.pathname).toBe(`/ui/tasks/${parentId}`);

  await wrapper.find('.panel-close').trigger('click');
  await waitFor(() => !wrapper.find('.detail-panel').exists(), 'panel closed');
  expect(window.location.pathname).toBe('/ui');
  expect(wrapper.findAll('.task-row').length).toBeGreaterThan(0);

  await wrapper.unmount();
});
