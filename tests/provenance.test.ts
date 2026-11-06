import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { startDaemon, type DaemonHandle } from './helpers/daemon.js';

/**
 * Process-level tests for the record-keeping layer (T7): annotations
 * (append-only, actor recorded) and the change log (exactly one row per
 * mutation, field-level before/after diff, actor provenance). Provenance is
 * asserted through external behavior only: MCP tools via the official client
 * (clientInfo name "baton-test-client" is visible on the actor), the HTTP API
 * via fetch (constant actor {kind: "http"}), and both write surfaces are read
 * back through GET /tasks/:id's annotations + recentChanges.
 */

const MCP_CLIENT_NAME = 'baton-test-client';
const MCP_CLIENT_VERSION = '3.7.0';

let daemon: DaemonHandle;

beforeAll(async () => {
  daemon = await startDaemon();
});

afterAll(async () => {
  await daemon.stop();
});

// ---------------------------------------------------------------- helpers

async function connectClient(): Promise<Client> {
  const client = new Client({ name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(`${daemon.baseUrl}/mcp`));
  await client.connect(transport); // performs the initialize handshake
  return client;
}

function jsonOf(result: CallToolResult): any {
  const block = result.content[0];
  expect(block?.type).toBe('text');
  return JSON.parse((block as { text: string }).text);
}

async function httpJson(response: Promise<Response>): Promise<any> {
  const resolved = await response;
  expect(resolved.ok).toBe(true);
  return resolved.json();
}

async function makeProject(name: string): Promise<{ id: number }> {
  return (
    await httpJson(
      fetch(`${daemon.baseUrl}/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, paths: [`/workspace/${name}`] }),
      }),
    )
  ).project;
}

async function makeTask(title: string, extra: Record<string, unknown> = {}): Promise<{ id: number }> {
  return (
    await httpJson(
      fetch(`${daemon.baseUrl}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, project: 'prov', ...extra }),
      }),
    )
  ).task;
}

async function annotateHttp(id: number, body: string): Promise<any> {
  return (
    await httpJson(
      fetch(`${daemon.baseUrl}/tasks/${id}/annotations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      }),
    )
  ).annotation;
}

async function detail(id: number): Promise<any> {
  return httpJson(fetch(`${daemon.baseUrl}/tasks/${id}`));
}

// ------------------------------------------------------------ annotations

test('task_annotate via MCP records the client actor; task_get shows the annotation', async () => {
  const project = await makeProject('prov');
  expect(project.id).toBeGreaterThan(0);
  const task = await makeTask('Annotated via MCP');

  const client = await connectClient();
  try {
    const result = await client.callTool({
      name: 'task_annotate',
      arguments: { id: task.id, body: 'Found the flaky test: it depends on wall-clock time.' },
    });
    expect(result.isError).toBeFalsy();
    const annotation = jsonOf(result).annotation;
    expect(annotation.body).toBe('Found the flaky test: it depends on wall-clock time.');
    expect(annotation.taskId).toBe(task.id);
    expect(annotation.actor).toEqual({
      kind: 'mcp',
      clientName: MCP_CLIENT_NAME,
      clientVersion: MCP_CLIENT_VERSION,
      sessionId: expect.any(String),
    });
    expect(typeof annotation.createdAt).toBe('string');

    // The same annotation is visible through the HTTP read surface.
    const viaHttp = await detail(task.id);
    expect(viaHttp.annotations).toHaveLength(1);
    expect(viaHttp.annotations[0].actor).toEqual(annotation.actor);
  } finally {
    await client.close();
  }
});

test('annotating via HTTP records the constant actor {kind: "http"}', async () => {
  const task = await makeTask('Annotated via HTTP');

  const annotation = await annotateHttp(task.id, 'Cross-checked with the HTTP API directly.');
  expect(annotation.actor).toEqual({ kind: 'http' });
  expect(annotation.body).toBe('Cross-checked with the HTTP API directly.');
});

test('annotations are listed newest-first and appending never rewrites earlier ones', async () => {
  const task = await makeTask('Annotated repeatedly');

  const first = await annotateHttp(task.id, 'first note');
  await annotateHttp(task.id, 'second note');
  const third = await annotateHttp(task.id, 'third note');

  const viaHttp = await detail(task.id);
  expect(viaHttp.annotations.map((annotation: any) => annotation.body)).toEqual([
    'third note',
    'second note',
    'first note',
  ]);
  // The first annotation kept its id, body, and timestamp — append-only.
  expect(viaHttp.annotations.at(-1)).toMatchObject({ id: first.id, body: 'first note', createdAt: first.createdAt });
  expect(third.id).toBeGreaterThan(first.id);
});

test('annotations are append-only: no edit or delete route exists', async () => {
  const task = await makeTask('Immutable annotations');
  await annotateHttp(task.id, 'stays forever');

  // The collection route answers 405 for anything but GET/POST...
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const response = await fetch(`${daemon.baseUrl}/tasks/${task.id}/annotations`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'rewrite' }),
    });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, POST');
  }

  // ...and per-annotation routes do not exist at all.
  const perItem = await fetch(`${daemon.baseUrl}/tasks/${task.id}/annotations/1`, { method: 'DELETE' });
  expect(perItem.status).toBe(404);

  const stillThere = await detail(task.id);
  expect(stillThere.annotations).toHaveLength(1);
});

test('task_annotate rejects an unknown task id and an empty body with tool errors', async () => {
  const client = await connectClient();
  try {
    const unknown = await client.callTool({ name: 'task_annotate', arguments: { id: 999999, body: 'x' } });
    expect(unknown.isError).toBe(true);
    expect((unknown.content[0] as { text: string }).text).toContain('unknown task id');

    const empty = await client.callTool({ name: 'task_annotate', arguments: { id: 1, body: '   ' } });
    expect(empty.isError).toBe(true);
    expect((empty.content[0] as { text: string }).text).toContain('annotation body must be a non-empty string');
  } finally {
    await client.close();
  }
});

// ------------------------------------------------------------ change log

test('task creation writes exactly one change-log row with every field as "after" and the http actor', async () => {
  const task = await makeTask('Created with fields', {
    tags: ['Audit', 'audit'],
    priority: 'H',
    due: '2026-12-24T00:00:00Z',
    effort: '3h',
  });

  const viaHttp = await detail(task.id);
  expect(viaHttp.recentChanges).toHaveLength(1);
  const change = viaHttp.recentChanges[0];
  expect(change.entity).toBe('task');
  expect(change.entityId).toBe(task.id);
  expect(change.actor).toEqual({ kind: 'http' });
  expect(typeof change.createdAt).toBe('string');
  expect(change.diff).toEqual({
    title: { before: null, after: 'Created with fields' },
    status: { before: null, after: 'pending' },
    projectId: { before: null, after: expect.any(Number) },
    parentId: { before: null, after: null },
    tags: { before: null, after: ['audit'] },
    due: { before: null, after: '2026-12-24T00:00:00Z' },
    priority: { before: null, after: 'H' },
    effort: { before: null, after: '3h' },
    hiddenUntil: { before: null, after: null },
  });
});

test('a field update diffs exactly the changed fields; absent -> value counts as a change', async () => {
  const task = await makeTask('Diffed on update');

  await httpJson(
    fetch(`${daemon.baseUrl}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Diffed on update (renamed)', priority: 'H' }),
    }),
  );

  let viaHttp = await detail(task.id);
  expect(viaHttp.recentChanges[0].diff).toEqual({
    title: { before: 'Diffed on update', after: 'Diffed on update (renamed)' },
    priority: { before: null, after: 'H' }, // absent -> value
  });

  // Setting the same values again records a row whose diff is empty (values
  // did not change), and clearing a field shows value -> null.
  await httpJson(
    fetch(`${daemon.baseUrl}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Diffed on update (renamed)', priority: 'H' }),
    }),
  );
  await httpJson(
    fetch(`${daemon.baseUrl}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ priority: null }),
    }),
  );

  viaHttp = await detail(task.id);
  expect(viaHttp.recentChanges[0].diff).toEqual({ priority: { before: 'H', after: null } });
  expect(viaHttp.recentChanges[1].diff).toEqual({});
});

test('tag and parent changes are diffed like any other field', async () => {
  const root = await makeTask('Diff root');
  const child = await makeTask('Diff child');

  await httpJson(
    fetch(`${daemon.baseUrl}/tasks/${child.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags: ['one', 'two'], parent: root.id }),
    }),
  );

  const viaHttp = await detail(child.id);
  expect(viaHttp.recentChanges[0].diff).toEqual({
    tags: { before: [], after: ['one', 'two'] },
    parentId: { before: null, after: root.id },
  });
});

test('recentChanges lists the task\u2019s rows newest-first, capped at 20', async () => {
  const task = await makeTask('Many small changes');
  // create row + 24 update rows = 25 rows; only the newest 20 come back.
  for (let i = 1; i <= 24; i++) {
    await httpJson(
      fetch(`${daemon.baseUrl}/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effort: `${i}h` }),
      }),
    );
  }

  const viaHttp = await detail(task.id);
  expect(viaHttp.recentChanges).toHaveLength(20);
  const efforts = viaHttp.recentChanges.map((change: any) => change.diff.effort?.after);
  expect(efforts).toEqual([
    '24h', '23h', '22h', '21h', '20h', '19h', '18h', '17h', '16h', '15h',
    '14h', '13h', '12h', '11h', '10h', '9h', '8h', '7h', '6h', '5h',
  ]);
  // The create row (no effort diff) has fallen off the 20-row window.
  expect(viaHttp.recentChanges.some((change: any) => change.diff.title !== undefined)).toBe(false);
});

test('an MCP-sourced mutation records the MCP client as the actor; ordering mixes surfaces correctly', async () => {
  const task = await makeTask('Touched from both surfaces'); // http actor

  const client = await connectClient();
  try {
    const result = await client.callTool({
      name: 'task_update',
      arguments: { id: task.id, effort: '1h' },
    });
    expect(result.isError).toBeFalsy();
  } finally {
    await client.close();
  }

  const viaHttp = await detail(task.id);
  expect(viaHttp.recentChanges).toHaveLength(2);
  expect(viaHttp.recentChanges[0].diff).toEqual({ effort: { before: null, after: '1h' } });
  expect(viaHttp.recentChanges[0].actor).toEqual({
    kind: 'mcp',
    clientName: MCP_CLIENT_NAME,
    clientVersion: MCP_CLIENT_VERSION,
    sessionId: expect.any(String),
  });
  expect(viaHttp.recentChanges[1].diff.title.after).toBe('Touched from both surfaces'); // the create row
  expect(viaHttp.recentChanges[1].actor).toEqual({ kind: 'http' });
});

test('annotating does not write a change-log row (an annotation is its own record)', async () => {
  const task = await makeTask('Annotated, not logged');
  const before = (await detail(task.id)).recentChanges.length;
  await annotateHttp(task.id, 'progress note');
  const after = await detail(task.id);
  expect(after.recentChanges).toHaveLength(before); // unchanged
  expect(after.annotations).toHaveLength(1);
});

// ------------------------------------------- status transitions (T4+T7 wiring)

test('status transitions via MCP verbs are change-logged with the MCP actor', async () => {
  const task = await makeTask('Lifecycle is recorded');
  const client = await connectClient();
  try {
    await client.callTool({ name: 'task_start', arguments: { id: task.id } });
  } finally {
    await client.close();
  }
  const changes = (await detail(task.id)).recentChanges;
  expect(changes[0].diff).toEqual({ status: { before: 'pending', after: 'active' } });
  expect(changes[0].actor).toEqual({
    kind: 'mcp',
    clientName: MCP_CLIENT_NAME,
    clientVersion: MCP_CLIENT_VERSION,
    sessionId: expect.any(String),
  });
  expect(changes[1].diff.title.after).toBe('Lifecycle is recorded'); // the create row below it
});

test('status transitions via HTTP verbs are change-logged with the http actor', async () => {
  const task = await makeTask('HTTP verb provenance');
  await httpJson(fetch(`${daemon.baseUrl}/tasks/${task.id}/done`, { method: 'POST' }));
  const changes = (await detail(task.id)).recentChanges;
  expect(changes[0].diff).toEqual({ status: { before: 'pending', after: 'done' } });
  expect(changes[0].actor).toEqual({ kind: 'http' });
});
