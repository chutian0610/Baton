// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { request as httpRequest } from 'node:http';
import { startDaemon, type DaemonHandle } from '../../tests/helpers/daemon.js';
import { createHttpApi, type Api } from '../src/api.js';
import { createStore } from '../src/store.js';
import App from '../src/App.vue';

/**
 * The human's write surface, mounted (v0.3 T6): create (Unbound by default,
 * the picker's project as the only assignment), field editing, machine-legal
 * status transitions, and annotations — every write against a REAL daemon
 * and change-logged under the web actor.
 *
 * The injected transport sends the writes' Origin header over node:http
 * because happy-dom's fetch silently strips a manually set Origin header; a
 * real browser sends the identical header automatically on POSTs, so this is
 * the same request the production path produces (the daemon-side
 * classification is covered for real headers in tests/origin.test.ts).
 */

let daemon: DaemonHandle;
let projectId: number;

/** The Api with write methods riding node:http so the Origin header arrives. */
function nodeWriteApi(base: string): Api {
  const reads = createHttpApi(base);
  function send(method: 'POST' | 'PATCH', path: string, body: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const request = httpRequest(
        `${base}${path}`,
        {
          method,
          headers: {
            'content-type': 'application/json',
            origin: base,
            'content-length': Buffer.byteLength(payload),
          },
        },
        (response) => {
          let data = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            data += chunk;
          });
          response.on('end', () => {
            if ((response.statusCode ?? 500) >= 400) {
              reject(new Error(`${method} ${path} failed with ${response.statusCode}`));
            } else {
              resolve(JSON.parse(data));
            }
          });
        },
      );
      request.on('error', reject);
      request.end(payload);
    });
  }
  return {
    listTasks: reads.listTasks,
    listProjects: reads.listProjects,
    getTask: reads.getTask,
    getChanges: reads.getChanges,
    createTask: (body) => send('POST', '/tasks', body),
    updateTask: (id, body) => send('PATCH', `/tasks/${id}`, body),
    annotate: (id, body) => send('POST', `/tasks/${id}/annotations`, { body }),
  };
}

async function waitFor(condition: () => boolean, what: string, dump?: () => string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await flushPromises();
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`condition not met in time: ${what}${dump ? `; text=${dump()}` : ''}`);
}

async function mountApp() {
  const api = nodeWriteApi(daemon.baseUrl);
  const store = createStore({ api });
  const wrapper = mount(App, {
    global: { provide: { apiBase: daemon.baseUrl, api, store } },
  });
  await store.refresh();
  await flushPromises();
  await wrapper.vm.$nextTick();
  return wrapper;
}

function visibleTitles(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('.task-link').map((node) => node.text());
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
          body: JSON.stringify({ name: 'writes', paths: ['/workspace/writes'] }),
        })
      ).json()
    ).project as { id: number }
  ).id;
});

afterAll(async () => {
  await daemon.stop();
});

beforeEach(() => {
  window.localStorage.clear();
  window.history.pushState({}, '', '/ui');
});

test('create: Unbound by default, the picker project when scoped', async () => {
  const wrapper = await mountApp();

  // Unbound: picker untouched ('all')
  await wrapper.find('input[aria-label="New task title"]').setValue('captured from the dashboard');
  await wrapper.find('form.new-task button[type="submit"]').trigger('submit');
  await waitFor(() => visibleTitles(wrapper).includes('captured from the dashboard'), 'created task in tree');
  const created = (
    (await (await fetch(`${daemon.baseUrl}/tasks?view=all`)).json()) as {
      tasks: { title: string; projectId: number | null }[];
    }
  ).tasks.find((task) => task.title === 'captured from the dashboard')!;
  expect(created.projectId).toBeNull(); // capture-first

  // picker scoped to the project: that project is the only assignment
  await wrapper.find('.project-picker').setValue(String(projectId));
  await wrapper.vm.$nextTick();
  await wrapper.find('input[aria-label="New task title"]').setValue('captured into writes');
  await wrapper.find('form.new-task button[type="submit"]').trigger('submit');
  await waitFor(() => visibleTitles(wrapper).includes('captured into writes'), 'scoped creation in tree');
  const scoped = (
    (await (await fetch(`${daemon.baseUrl}/tasks?view=all`)).json()) as {
      tasks: { title: string; projectId: number | null }[];
    }
  ).tasks.find((task) => task.title === 'captured into writes')!;
  expect(scoped.projectId).toBe(projectId);

  await wrapper.unmount();
});

test('edit fields: title and priority update, the change log records the web actor', async () => {
  const seeded = (
    (
      await (
        await fetch(`${daemon.baseUrl}/tasks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'to be edited' }),
        })
      ).json()
    ).task as { id: number }
  ).id;

  const wrapper = await mountApp();
  await wrapper.findAll('.task-link').find((node) => node.text() === 'to be edited')!.trigger('click');
  await waitFor(() => wrapper.find('h1').exists() && wrapper.find('h1').text() === 'to be edited', 'detail open');

  const editButton = wrapper.findAll('button').find((node) => node.text() === 'Edit fields')!;
  await editButton.trigger('click');
  await wrapper.vm.$nextTick();

  await wrapper.find('input[aria-label="Title"]').setValue('edited from the dashboard');
  await wrapper.find('select[aria-label="Priority"]').setValue('H');
  await wrapper.findAll('button').find((node) => node.text() === 'Save')!.trigger('submit');
  await waitFor(
    () => wrapper.find('h1').text() === 'edited from the dashboard',
    'title updated',
    () => wrapper.text(),
  );

  const changes = await (await fetch(`${daemon.baseUrl}/tasks/${seeded}/changes`)).json();
  // one PATCH row carries the whole field diff, under the web actor
  expect(changes.changes[0].diff.title).toEqual({ before: 'to be edited', after: 'edited from the dashboard' });
  expect(changes.changes[0].diff.priority).toEqual({ before: null, after: 'H' });
  expect(changes.changes[0].actor).toEqual({ kind: 'web' });
  expect(changes.total).toBe(2); // the create row + this PATCH

  await wrapper.unmount();
});

test('transitions: only machine-legal targets are offered; intervals open and close', async () => {
  const seeded = (
    (
      await (
        await fetch(`${daemon.baseUrl}/tasks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'transitioned by hand' }),
        })
      ).json()
    ).task as { id: number }
  ).id;

  const wrapper = await mountApp();
  await wrapper.findAll('.task-link').find((node) => node.text() === 'transitioned by hand')!.trigger('click');
  await waitFor(() => wrapper.find('h1').exists(), 'detail open');

  // pending offers exactly active/waiting/done/dropped (mirrors LEGAL_TARGETS)
  const labels = () => wrapper.findAll('button.transition').map((node) => node.text());
  expect(labels()).toEqual(['→ active', '→ waiting', '→ done', '→ dropped']);

  await wrapper.findAll('button.transition').find((node) => node.text() === '→ active')!.trigger('click');
  await waitFor(() => wrapper.text().includes('active now'), 'open interval visible');

  await wrapper.findAll('button.transition').find((node) => node.text() === '→ done')!.trigger('click');
  await waitFor(
    () => wrapper.findAll('.badge-done').some((node) => node.text() === 'done') && !wrapper.text().includes('active now'),
    'interval closed on done',
  );

  const changes = await (await fetch(`${daemon.baseUrl}/tasks/${seeded}/changes`)).json();
  expect(changes.changes[0].diff.status).toEqual({ before: 'active', after: 'done' });
  expect(changes.changes[0].actor).toEqual({ kind: 'web' });
  expect(changes.changes[1].diff.status).toEqual({ before: 'pending', after: 'active' });
  expect(changes.changes[1].actor).toEqual({ kind: 'web' });

  await wrapper.unmount();
});

test('annotate: the note lands newest-first under the web actor', async () => {
  const seeded = (
    (
      await (
        await fetch(`${daemon.baseUrl}/tasks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'annotated by hand' }),
        })
      ).json()
    ).task as { id: number }
  ).id;

  const wrapper = await mountApp();
  await wrapper.findAll('.task-link').find((node) => node.text() === 'annotated by hand')!.trigger('click');
  await waitFor(() => wrapper.find('h1').exists(), 'detail open');

  await wrapper.find('textarea[aria-label="New annotation"]').setValue('a note from the human');
  await wrapper.findAll('button').find((node) => node.text() === 'Annotate')!.trigger('submit');
  await waitFor(() => wrapper.text().includes('a note from the human'), 'annotation rendered');

  const annotations = await (await fetch(`${daemon.baseUrl}/tasks/${seeded}/annotations`)).json();
  expect(annotations.annotations[0].body).toBe('a note from the human');
  expect(annotations.annotations[0].actor).toEqual({ kind: 'web' });

  await wrapper.unmount();
});

test('structural editing is absent: no parent, dependency, or project-rebind controls', async () => {
  const seeded = (
    (
      await (
        await fetch(`${daemon.baseUrl}/tasks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'structurally untouched' }),
        })
      ).json()
    ).task as { id: number }
  ).id;

  const wrapper = await mountApp();
  await wrapper.findAll('.task-link').find((node) => node.text() === 'structurally untouched')!.trigger('click');
  await waitFor(() => wrapper.find('h1').exists(), 'detail open');

  await wrapper.findAll('button').find((node) => node.text() === 'Edit fields')!.trigger('click');
  await wrapper.vm.$nextTick();

  const text = wrapper.find('form.edit-form').text();
  expect(text).not.toContain('Parent');
  expect(text).not.toContain('Dependencies');
  expect(text).not.toContain('Project');
  expect(wrapper.find('form.edit-form input[aria-label="Parent"]').exists()).toBe(false);
  expect(wrapper.find('form.edit-form select[aria-label="Project"]').exists()).toBe(false);

  // the create form likewise has no parent input
  await wrapper.find('main button.back').trigger('click');
  await flushPromises();
  await wrapper.vm.$nextTick();
  expect(wrapper.find('form.new-task input[aria-label="Parent"]').exists()).toBe(false);

  await wrapper.unmount();
});
