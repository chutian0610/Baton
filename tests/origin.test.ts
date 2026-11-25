import { afterAll, beforeAll, expect, test } from 'vitest';
import { startDaemon, type DaemonHandle } from './helpers/daemon.js';

/**
 * Process-level tests for the Web UI surface's server-side core (v0.3 T1,
 * ADR-0006): the Origin/Host check and the `web` Actor.
 *
 * The Origin check is the drive-by/CSRF guard a browser surface introduces:
 * any request bearing an Origin header whose authority differs from the
 * request's Host is rejected with 403, uniformly across every route (API,
 * /mcp, /healthz). Requests without Origin — curl, MCP clients — behave
 * byte-identically to v0.2.
 *
 * Actor classification: a request arriving with a (passing) Origin header
 * records {kind: "web"} on every change and annotation it causes; without
 * one, classification is exactly v0.2's ({kind: "http"} for the JSON API).
 * Both are asserted through external behavior only — the change log and
 * annotations read back through GET /tasks/:id.
 */

let daemon: DaemonHandle;

beforeAll(async () => {
  daemon = await startDaemon();
});

afterAll(async () => {
  await daemon.stop();
});

// ---------------------------------------------------------------- helpers

const EVIL_ORIGIN = 'https://evil.example.com';

function post(url: string, origin?: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin !== undefined ? { origin } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
}

async function createTask(origin?: string, title = 'Origin probe'): Promise<Response> {
  return post(`${daemon.baseUrl}/tasks`, origin, { title });
}

// ---------------------------------------------------------- the Origin check

test('a mismatched Origin is 403-rejected on reads and writes, across every route', async () => {
  // read on the API
  const read = await fetch(`${daemon.baseUrl}/tasks`, { headers: { origin: EVIL_ORIGIN } });
  expect(read.status).toBe(403);

  // write on the API
  const write = await createTask(EVIL_ORIGIN);
  expect(write.status).toBe(403);
  expect(((await write.json()) as { error: string }).error).toMatch(/origin/i);

  // the health endpoint is not exempt (the check is uniform)
  const health = await fetch(`${daemon.baseUrl}/healthz`, { headers: { origin: EVIL_ORIGIN } });
  expect(health.status).toBe(403);

  // /mcp is not exempt — a hostile page cannot drive the MCP endpoint either
  const mcp = await fetch(`${daemon.baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      origin: EVIL_ORIGIN,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'drive-by', version: '0' } },
    }),
  });
  expect(mcp.status).toBe(403);
});

test('the literal Origin "null" is rejected (fail closed)', async () => {
  const response = await createTask('null');
  expect(response.status).toBe(403);
});

test('a matching Origin passes on every route (the browser same-origin case)', async () => {
  // Origin exactly matching the request's host:port — what a browser sends
  // for same-origin POSTs against http://127.0.0.1:<port>
  const sameHost = await createTask(`http://127.0.0.1:${daemon.port}`);
  expect(sameHost.status).toBe(201);

  // the localhost spelling of the same daemon: Origin must match the Host
  // header, which the browser derives from the URL actually visited
  const viaLocalhost = await fetch(`http://localhost:${daemon.port}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://localhost:${daemon.port}` },
    body: JSON.stringify({ title: 'Origin probe (localhost)' }),
  });
  expect(viaLocalhost.status).toBe(201);

  // same-origin reads and MCP passes too (e.g. a browser-based MCP client)
  const read = await fetch(`${daemon.baseUrl}/tasks`, {
    headers: { origin: `http://127.0.0.1:${daemon.port}` },
  });
  expect(read.status).toBe(200);
  const mcp = await fetch(`${daemon.baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      origin: `http://127.0.0.1:${daemon.port}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'web-mcp', version: '0' } },
    }),
  });
  expect(mcp.status).toBe(200); // past the origin gate; MCP session handling takes over
});

test('no-Origin requests behave byte-identically to v0.2', async () => {
  const created = await createTask(); // curl's shape: no Origin header at all
  expect(created.status).toBe(201);
  const task = (await created.json()) as { task: { id: number } };

  const read = await fetch(`${daemon.baseUrl}/tasks/${task.task.id}`);
  expect(read.status).toBe(200);
});

// -------------------------------------------------------- the `web` Actor

test('an Origin-bearing create records the web actor in the change log', async () => {
  const created = await createTask(`http://127.0.0.1:${daemon.port}`, 'Created from the web');
  expect(created.status).toBe(201);
  const task = ((await created.json()) as { task: { id: number } }).task;

  const detail = (await (await fetch(`${daemon.baseUrl}/tasks/${task.id}`)).json()) as {
    recentChanges: { actor: unknown }[];
  };
  expect(detail.recentChanges).toHaveLength(1);
  expect(detail.recentChanges[0].actor).toEqual({ kind: 'web' });
});

test('an Origin-bearing annotation records the web actor', async () => {
  const created = await createTask(`http://127.0.0.1:${daemon.port}`, 'Web-annotated');
  const task = ((await created.json()) as { task: { id: number } }).task;

  const annotation = (await (
    await post(`${daemon.baseUrl}/tasks/${task.id}/annotations`, `http://127.0.0.1:${daemon.port}`, {
      body: 'Noted from the dashboard.',
    })
  ).json()) as { annotation: { actor: unknown } };
  expect(annotation.annotation.actor).toEqual({ kind: 'web' });

  // the same annotation read back without an Origin shows the stored actor
  const detail = (await (await fetch(`${daemon.baseUrl}/tasks/${task.id}`)).json()) as {
    annotations: { actor: unknown }[];
  };
  expect(detail.annotations[0].actor).toEqual({ kind: 'web' });
});

test('an Origin-bearing update and status verb record the web actor', async () => {
  const created = await createTask(`http://127.0.0.1:${daemon.port}`, 'Web-updated');
  const task = ((await created.json()) as { task: { id: number } }).task;
  const origin = `http://127.0.0.1:${daemon.port}`;

  const patched = await fetch(`${daemon.baseUrl}/tasks/${task.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ priority: 'H' }),
  });
  expect(patched.status).toBe(200);

  const done = await fetch(`${daemon.baseUrl}/tasks/${task.id}/done`, {
    method: 'POST',
    headers: { origin },
  });
  expect(done.status).toBe(200);

  const detail = (await (await fetch(`${daemon.baseUrl}/tasks/${task.id}`)).json()) as {
    recentChanges: { diff: Record<string, { after: unknown }>; actor: unknown }[];
  };
  expect(detail.recentChanges[0]).toMatchObject({ actor: { kind: 'web' }, diff: { status: { after: 'done' } } });
  expect(detail.recentChanges[1]).toMatchObject({ actor: { kind: 'web' }, diff: { priority: { after: 'H' } } });
});

test('the origin-less create right next to web creates still records {kind: "http"}', async () => {
  const fromWeb = await createTask(`http://127.0.0.1:${daemon.port}`, 'Web side');
  const fromCurl = await createTask(undefined, 'Curl side');
  expect(fromCurl.status).toBe(201);

  const webTask = ((await fromWeb.json()) as { task: { id: number } }).task;
  const curlTask = ((await fromCurl.json()) as { task: { id: number } }).task;

  const webDetail = (await (await fetch(`${daemon.baseUrl}/tasks/${webTask.id}`)).json()) as {
    recentChanges: { actor: unknown }[];
  };
  const curlDetail = (await (await fetch(`${daemon.baseUrl}/tasks/${curlTask.id}`)).json()) as {
    recentChanges: { actor: unknown }[];
  };
  expect(webDetail.recentChanges[0].actor).toEqual({ kind: 'web' });
  expect(curlDetail.recentChanges[0].actor).toEqual({ kind: 'http' });
});
