// @vitest-environment happy-dom
import { afterAll, beforeAll, expect, test } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { request as httpRequest } from 'node:http';
import { startDaemon, type DaemonHandle } from '../../tests/helpers/daemon.js';
import App from '../src/App.vue';

/**
 * The task detail page, mounted (v0.3 T5): every stored field, the annotation
 * timeline attributed to all three actor kinds (web / http / mcp), the
 * recorded intervals, read-only dependencies, the change log's actor
 * attribution, and the deep link opening the right task. All against a REAL
 * daemon; the MCP annotation goes through a raw JSON-RPC handshake so the
 * actor kinds need no SDK client inside the DOM environment.
 */

let daemon: DaemonHandle;
let targetId: number;
let blockerId: number;
let parentId: number;

const ORIGIN = () => `http://127.0.0.1:${daemon.port}`;

async function post(path: string, body: unknown, withOrigin = false): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(withOrigin ? { origin: ORIGIN() } : {}),
    },
    body: JSON.stringify(body),
  });
}

/**
 * POST via node:http for the ORIGIN-BEARING (web-actor) calls: happy-dom's
 * fetch does not forward a manually set Origin header, and the web actor is
 * precisely what those calls must exercise.
 */
function postViaNode(path: string, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = httpRequest(
      `${daemon.baseUrl}${path}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN(),
          'content-length': Buffer.byteLength(payload),
        },
      },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          data += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, json: JSON.parse(data) }));
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}

/** Raw MCP session: initialize, then call a tool with the session id. */
async function mcpCall(tool: string, args: Record<string, unknown>): Promise<void> {
  const init = await fetch(`${daemon.baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'detail-test-client', version: '1.0.0' } },
    }),
  });
  expect(init.status).toBe(200);
  const sessionId = init.headers.get('mcp-session-id') ?? '';
  const call = await fetch(`${daemon.baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  expect(call.status).toBe(200);
}

beforeAll(async () => {
  daemon = await startDaemon();
  (globalThis as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(daemon.baseUrl);
  globalThis.fetch = window.fetch.bind(globalThis);

  await post('/projects', { name: 'detail-p', paths: ['/workspace/detail-p'] });

  const now = Date.now();
  const parent = await post('/tasks', { title: 'the parent', project: 'detail-p' });
  parentId = ((await parent.json()) as { task: { id: number } }).task.id;
  const blocker = await post('/tasks', { title: 'the blocker', project: 'detail-p' });
  blockerId = ((await blocker.json()) as { task: { id: number } }).task.id;

  // the audited task: created from the web (web actor), full field set,
  // nested under the parent, dependent on the blocker
  const target = await postViaNode('/tasks', {
    title: 'the audited one',
    project: 'detail-p',
    parent: parentId,
    deps: [blockerId],
    tags: ['audit'],
    priority: 'H',
    effort: '2h',
    due: new Date(now + 24 * 3600_000).toISOString(),
  });
  expect(target.status).toBe(201);
  targetId = target.json.task.id;

  // annotations from all three surfaces
  const webAnnotation = await postViaNode(`/tasks/${targetId}/annotations`, { body: 'noted from the dashboard' }); // web
  expect(webAnnotation.status).toBe(201);
  await post(`/tasks/${targetId}/annotations`, { body: 'noted from curl' }); // http
  await mcpCall('task_annotate', { id: targetId, body: 'noted from an agent session' }); // mcp

  // an interval: start from the web, finish from the agent session
  expect((await postViaNode(`/tasks/${targetId}/start`, {})).status).toBe(200); // web actor, interval opens
  await mcpCall('task_done', { id: targetId }); // mcp actor, interval closes
});

afterAll(async () => {
  await daemon.stop();
});

/** Bounded DOM-condition wait: happy-dom's network I/O does not settle inside flushPromises. */
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

async function mountDetail(id: number) {
  // the deep link must be in place BEFORE mount for the router to pick it up
  window.history.pushState({}, '', `/ui/tasks/${id}`);
  const wrapper = mount(App, { global: { provide: { apiBase: daemon.baseUrl } } });
  await waitFor(() => wrapper.find('h1').exists(), `task ${id} detail rendered`);
  return wrapper;
}

async function waitForSection(wrapper: ReturnType<typeof mount>, name: string) {
  await waitFor(
    () =>
      wrapper.findAll('section').some((node) => {
        const heading = node.find('h2');
        return heading.exists() && heading.text().startsWith(name);
      }),
    `section ${name} rendered`,
  );
}

function section(wrapper: ReturnType<typeof mount>, name: string) {
  return wrapper.findAll('section').find((node) => {
    const heading = node.find('h2');
    return heading.exists() && heading.text().startsWith(name);
  })!;
}

test('the deep link opens the right task with every stored field', async () => {
  const wrapper = await mountDetail(targetId);

  expect(wrapper.find('h1').text()).toBe('the audited one');
  expect(wrapper.text()).toContain('done'); // status badge
  expect(wrapper.text()).toContain('blocked'); // derived from the pending blocker
  expect(wrapper.text()).toContain('detail-p'); // project name
  expect(wrapper.find('dl').text()).toContain('H'); // priority
  expect(wrapper.find('dl').text()).toContain('2h'); // effort
  expect(wrapper.find('dl').text()).toContain('audit'); // tag badge
  expect(wrapper.find('dl').text()).toContain(`#${parentId}`); // parent, deep-linkable
  await wrapper.unmount();
});

test('dependencies render read-only with title, status and blocked state', async () => {
  const wrapper = await mountDetail(targetId);
  await waitForSection(wrapper, 'Dependencies');

  const deps = section(wrapper, 'Dependencies');
  expect(deps.text()).toContain('the blocker');
  expect(deps.text()).toContain('pending');
  expect(deps.text()).not.toContain('blocked\n'); // the blocker itself is not blocked (its own badge absent)
  await wrapper.unmount();
});

test('annotations render newest-first, attributed to web, http and mcp actors', async () => {
  const wrapper = await mountDetail(targetId);

  const annotations = section(wrapper, 'Annotations');
  const text = annotations.text();
  const order = ['noted from an agent session', 'noted from curl', 'noted from the dashboard'];
  let last = -1;
  for (const marker of order) {
    const at = text.indexOf(marker);
    expect(at).toBeGreaterThan(last);
    last = at;
  }
  // actor chips: web and http kinds by name, mcp by its client name
  expect(text).toContain('detail-test-client');
  expect(text).toContain('web');
  expect(text).toContain('http');
  await wrapper.unmount();
});

test('intervals render with their span and the total active time', async () => {
  const wrapper = await mountDetail(targetId);

  const intervals = section(wrapper, 'Intervals');
  expect(intervals.text()).not.toContain('active now'); // the interval was closed by task_done
  expect(intervals.findAll('li').length).toBe(1);
  expect(intervals.text()).toMatch(/total active: /); // humanized: '<1s' for sub-second spans
  await wrapper.unmount();
});

test('the history timeline is newest-first with structured diffs and actor attribution', async () => {
  const wrapper = await mountDetail(targetId);
  await waitForSection(wrapper, 'History');

  const history = section(wrapper, 'History');
  const rows = history.findAll('.change-row');
  expect(rows.length).toBeGreaterThanOrEqual(3);

  // newest first: done (mcp), then active (web), …, then the create row (web)
  expect(rows[0]!.find('.actor-chip').text()).toBe('detail-test-client');
  const doneEntry = rows[0]!.findAll('.diff-entry').find((entry) => entry.find('.diff-field').text() === 'status')!;
  expect(doneEntry.find('.diff-before').text()).toBe('active');
  expect(doneEntry.find('.diff-after').text()).toBe('done');

  // the start transition came from the dashboard: a web-actor row with pending → active
  const webRows = rows.filter((row) => row.find('.actor-chip').text() === 'web');
  expect(webRows.length).toBeGreaterThanOrEqual(2);
  expect(
    webRows.some((row) =>
      row
        .findAll('.diff-entry')
        .some((entry) => entry.find('.diff-field').text() === 'status' && entry.find('.diff-after').text() === 'active'),
    ),
  ).toBe(true);

  // the create row is summarized (Created + chips), and its title entry renders
  const createRow = rows.at(-1)!;
  expect(createRow.find('.change-created').text()).toContain('Created');
  const titleEntry = createRow
    .findAll('.diff-entry')
    .find((entry) => entry.find('.diff-field').text() === 'title')!;
  expect(titleEntry.find('.diff-after').text()).toBe('the audited one');

  // no-op fields (null → null) are cut from every row
  for (const row of rows) {
    for (const entry of row.findAll('.diff-entry')) {
      expect(entry.find('.diff-before').text()).not.toBe(entry.find('.diff-after').text());
    }
  }
  await wrapper.unmount();
});

test('navigation between tasks works from parent/child/dep links', async () => {
  const wrapper = await mountDetail(targetId);
  await waitForSection(wrapper, 'Dependencies');

  const deps = section(wrapper, 'Dependencies');
  await deps.find('button.link').trigger('click');
  await waitFor(
    () => wrapper.find('h1').exists() && wrapper.find('h1').text() === 'the blocker',
    'blocker detail rendered',
  );
  expect(window.location.pathname).toBe(`/ui/tasks/${blockerId}`);
  await wrapper.unmount();
});

test('the detail window follows external mutations (polling refresh)', async () => {
  // a 50ms detail poll so the test sees the refresh promptly
  const wrapper = mount(App, {
    global: { provide: { apiBase: daemon.baseUrl, detailPollMs: 50 } },
  });
  window.history.pushState({}, '', `/ui/tasks/${targetId}`);
  window.dispatchEvent(new Event('popstate'));
  await waitFor(() => wrapper.find('h1').exists(), 'detail rendered');
  await waitForSection(wrapper, 'History');

  // an agent mutates the task behind the human's back
  const patch = await fetch(`${daemon.baseUrl}/tasks/${targetId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'renamed by an agent mid-audit' }),
  });
  expect(patch.status).toBe(200);

  // the window re-polls (50ms interval) and shows the new title unprompted
  await waitFor(() => wrapper.find('h1').text() === 'renamed by an agent mid-audit', 'external rename visible');
  await wrapper.unmount();
});
