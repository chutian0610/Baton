import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { startDaemon, type DaemonHandle } from './helpers/daemon.js';

/**
 * Process-level tests for the Dependency DAG (T5): deps as a replaced set on
 * create/update, the DAG rules (self-edges, cycles with the offending path,
 * cross-project edges all rejected), and the two read-time derivations of
 * ADR-0003 — blocked (any open dependency; advisory, never gates start) and
 * progress (done descendants ÷ non-dropped descendants; null when there is
 * nothing below the task). Chain and diamond graph shapes are covered, the
 * change-log diff for deps mutations, and the MCP surface mirrors HTTP for
 * add + cycle rejection (same message text).
 */
let daemon: DaemonHandle;

beforeAll(async () => {
  daemon = await startDaemon();
});

afterAll(async () => {
  await daemon.stop();
});

// ---------------------------------------------------------------- helpers

async function post(body: unknown): Promise<Response> {
  return fetch(`${daemon.baseUrl}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patch(id: number, body: unknown): Promise<Response> {
  return fetch(`${daemon.baseUrl}/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function verb(id: number, action: 'start' | 'done'): Promise<Response> {
  return fetch(`${daemon.baseUrl}/tasks/${id}/${action}`, { method: 'POST' });
}

async function detail(id: number): Promise<any> {
  const response = await fetch(`${daemon.baseUrl}/tasks/${id}`);
  expect(response.status).toBe(200);
  return response.json();
}

async function makeProject(name: string): Promise<{ id: number }> {
  const response = await fetch(`${daemon.baseUrl}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, paths: [`/workspace/${name}`] }),
  });
  expect(response.status).toBe(201);
  return (await response.json()).project;
}

async function makeTask(body: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await post(body);
  expect(response.status).toBe(201);
  return (await response.json()).task;
}

async function errorOf(response: Response): Promise<string> {
  expect(response.ok).toBe(false);
  return ((await response.json()) as { error: string }).error;
}

async function connectClient(): Promise<Client> {
  const client = new Client({ name: 'baton-deps-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${daemon.baseUrl}/mcp`));
  await client.connect(transport);
  return client;
}

function textOf(result: CallToolResult): string {
  const block = result.content[0];
  expect(block?.type).toBe('text');
  return (block as { text: string }).text;
}

function jsonOf(result: CallToolResult): any {
  return JSON.parse(textOf(result));
}

// ---------------------------------------------------- the dep set: add/replace

test('deps attach at create and read back sorted; blocked derives, leaves have no progress', async () => {
  await makeProject('set');
  const first = await makeTask({ title: 'First', project: 'set' });
  const second = await makeTask({ title: 'Second', project: 'set' });

  const dependent = await makeTask({ title: 'Depends on both', project: 'set', deps: [second.id, first.id] });
  expect(dependent.deps).toEqual([first.id, second.id]); // sorted, deduplicated
  expect(dependent.blocked).toBe(true); // both dependencies open
  expect(dependent.progress).toBeNull(); // leaf: nothing below it to measure

  expect((await detail(first.id)).task).toMatchObject({ deps: [], blocked: false, progress: null });
});

test('task_update replaces the dep set wholesale; [] and null clear it', async () => {
  await makeProject('replace');
  const a = await makeTask({ title: 'A', project: 'replace' });
  const b = await makeTask({ title: 'B', project: 'replace' });
  const c = await makeTask({ title: 'C', project: 'replace' });

  const added = await patch(c.id, { deps: [a.id] });
  expect(added.status).toBe(200);
  expect((await added.json()).task.deps).toEqual([a.id]);

  const replaced = await patch(c.id, { deps: [b.id, a.id] }); // replacement, not union
  expect(replaced.status).toBe(200);
  expect((await replaced.json()).task.deps).toEqual([a.id, b.id]);

  const emptied = await patch(c.id, { deps: [] });
  expect(emptied.status).toBe(200);
  expect((await emptied.json()).task.deps).toEqual([]);

  const refilled = await patch(c.id, { deps: [a.id] });
  expect((await refilled.json()).task.deps).toEqual([a.id]);

  const cleared = await patch(c.id, { deps: null });
  expect(cleared.status).toBe(200);
  expect((await cleared.json()).task.deps).toEqual([]);
});

test('unknown dependency ids answer 404 at create and on update', async () => {
  await makeProject('ghost-dep');

  const atCreate = await post({ title: 'Ghost dep', project: 'ghost-dep', deps: [999999] });
  expect(atCreate.status).toBe(404);
  expect(await errorOf(atCreate)).toContain('unknown dependency task id: 999999');

  const task = await makeTask({ title: 'Ghost dep update', project: 'ghost-dep' });
  const onUpdate = await patch(task.id, { deps: [999999] });
  expect(onUpdate.status).toBe(404);
  expect(await errorOf(onUpdate)).toContain('unknown dependency task id: 999999');
});

// ------------------------------------------------------------- DAG rules

test('a task cannot depend on itself', async () => {
  await makeProject('self-dep');
  const task = await makeTask({ title: 'Self dep', project: 'self-dep' });

  const response = await patch(task.id, { deps: [task.id] });
  expect(response.status).toBe(409);
  expect(await errorOf(response)).toContain(`task ${task.id} cannot depend on itself`);
});

test('a direct cycle is rejected with the two-node path', async () => {
  await makeProject('direct-cycle');
  const a = await makeTask({ title: 'Direct A', project: 'direct-cycle' });
  const b = await makeTask({ title: 'Direct B', project: 'direct-cycle', deps: [a.id] });

  const response = await patch(a.id, { deps: [b.id] });
  expect(response.status).toBe(409);
  const message = await errorOf(response);
  expect(message).toContain('cycle');
  expect(message).toContain(`${a.id} -> ${b.id} -> ${a.id}`);

  // rejected means rejected: the graph is unchanged
  expect((await detail(a.id)).task.deps).toEqual([]);
});

test('a transitive cycle is rejected with the full path', async () => {
  await makeProject('transitive-cycle');
  const three = await makeTask({ title: 'Three', project: 'transitive-cycle' });
  const four = await makeTask({ title: 'Four', project: 'transitive-cycle', deps: [three.id] });
  const five = await makeTask({ title: 'Five', project: 'transitive-cycle', deps: [four.id] });

  const response = await patch(three.id, { deps: [five.id] });
  expect(response.status).toBe(409);
  const message = await errorOf(response);
  expect(message).toContain('cycle');
  expect(message).toContain(`${three.id} -> ${five.id} -> ${four.id} -> ${three.id}`);
});

test('cross-project dependencies are rejected at create and on update', async () => {
  await makeProject('board-a');
  await makeProject('board-b');
  const here = await makeTask({ title: 'Here', project: 'board-a' });
  const there = await makeTask({ title: 'There', project: 'board-b' });

  const atCreate = await post({ title: 'Cross at create', project: 'board-a', deps: [there.id] });
  expect(atCreate.status).toBe(409);
  expect(await errorOf(atCreate)).toContain('one project');

  const onUpdate = await patch(here.id, { deps: [there.id] });
  expect(onUpdate.status).toBe(409);
  expect(await errorOf(onUpdate)).toContain('one project');
});

test('chains and diamonds stay legal; a cycle through the diamond reports its path', async () => {
  await makeProject('shapes');
  // chain: c3 -> c2 -> c1
  const c1 = await makeTask({ title: 'Chain 1', project: 'shapes' });
  const c2 = await makeTask({ title: 'Chain 2', project: 'shapes', deps: [c1.id] });
  const c3 = await makeTask({ title: 'Chain 3', project: 'shapes', deps: [c2.id] });
  expect((await detail(c3.id)).task.deps).toEqual([c2.id]);

  // diamond: d depends on b and c; b and c both depend on a
  const a = await makeTask({ title: 'Diamond top', project: 'shapes' });
  const b = await makeTask({ title: 'Diamond left', project: 'shapes', deps: [a.id] });
  const c = await makeTask({ title: 'Diamond right', project: 'shapes', deps: [a.id] });
  const d = await makeTask({ title: 'Diamond bottom', project: 'shapes', deps: [b.id, c.id] });
  expect((await detail(d.id)).task).toMatchObject({ deps: [b.id, c.id], blocked: true });
  expect((await detail(b.id)).task.blocked).toBe(true);
  expect((await detail(a.id)).task.blocked).toBe(false);

  // closing the diamond into a loop is rejected, with the path through it
  const response = await patch(a.id, { deps: [d.id] });
  expect(response.status).toBe(409);
  const message = await errorOf(response);
  expect(message).toContain(`${a.id} -> ${d.id} -> ${b.id} -> ${a.id}`); // b < c: the first branch found
});

// ------------------------------------------------------ blocked (derived)

test('blocked flips as dependencies reach done, reopen, and drop', async () => {
  await makeProject('flips');
  const first = await makeTask({ title: 'Flip dep one', project: 'flips' });
  const second = await makeTask({ title: 'Flip dep two', project: 'flips' });
  const dependent = await makeTask({ title: 'Flips along', project: 'flips', deps: [first.id, second.id] });

  expect((await detail(dependent.id)).task.blocked).toBe(true);

  // one dependency closing is not enough while the other stays open
  await verb(second.id, 'done');
  expect((await detail(dependent.id)).task.blocked).toBe(true);

  // all dependencies closed: unblocked
  await verb(first.id, 'done');
  expect((await detail(dependent.id)).task.blocked).toBe(false);

  // a reopened dependency blocks again
  const reopened = await patch(first.id, { status: 'pending' });
  expect(reopened.status).toBe(200);
  expect((await detail(dependent.id)).task.blocked).toBe(true);

  // a dropped dependency does not block (dropped counts as resolved)
  const dropped = await patch(first.id, { status: 'dropped' });
  expect(dropped.status).toBe(200);
  expect((await detail(dependent.id)).task.blocked).toBe(false);
});

test('a blocked task can still start (blocked is advisory, never a gate)', async () => {
  await makeProject('advisory');
  const blocker = await makeTask({ title: 'Still open', project: 'advisory' });
  const blocked = await makeTask({ title: 'Blocked but startable', project: 'advisory', deps: [blocker.id] });
  expect((await detail(blocked.id)).task.blocked).toBe(true);

  const response = await verb(blocked.id, 'start');
  expect(response.status).toBe(200);
  expect((await response.json()).task).toMatchObject({ status: 'active', blocked: true });
});

// ---------------------------------------------------- progress (derived)

test('progress is done descendants over non-dropped descendants on a two-level tree', async () => {
  await makeProject('ratio');
  const parent = await makeTask({ title: 'Ratio parent', project: 'ratio' });
  const doneChild = await makeTask({ title: 'Done child', project: 'ratio', parent: parent.id });
  const droppedChild = await makeTask({ title: 'Dropped child', project: 'ratio', parent: parent.id });
  const openChild = await makeTask({ title: 'Open child', project: 'ratio', parent: parent.id });
  const grandchild = await makeTask({ title: 'Done grandchild', project: 'ratio', parent: openChild.id });

  expect((await detail(parent.id)).task.progress).toBe(0); // 0 of 4 descendants done

  await verb(doneChild.id, 'done');
  expect((await detail(parent.id)).task.progress).toBe(0.25); // 1 of 4

  await verb(grandchild.id, 'done');
  expect((await detail(parent.id)).task.progress).toBe(0.5); // 2 of 4 — grandchildren count
  // the mid-tier parent derives over its own subtree: 1 of 1 below it
  expect((await detail(openChild.id)).task.progress).toBe(1);
  // a done leaf has nothing below it
  expect((await detail(doneChild.id)).task.progress).toBeNull();

  // dropping a descendant removes it from the denominator: 2 of 3, not 2 of 4
  const drop = await patch(droppedChild.id, { status: 'dropped' });
  expect(drop.status).toBe(200);
  expect((await detail(parent.id)).task.progress).toBeCloseTo(2 / 3);
});

test('a parent whose descendants were all dropped carries no progress value', async () => {
  await makeProject('all-dropped');
  const parent = await makeTask({ title: 'All dropped parent', project: 'all-dropped' });
  const child = await makeTask({ title: 'Dropped kid', project: 'all-dropped', parent: parent.id });
  await patch(child.id, { status: 'dropped' });

  // no non-dropped descendants -> nothing to measure -> null (not 0, not 1)
  expect((await detail(parent.id)).task.progress).toBeNull();
});

// --------------------------------------------------------- change log

test('deps mutations are change-logged with before/after id arrays and the actor', async () => {
  await makeProject('logged');
  const a = await makeTask({ title: 'Logged A', project: 'logged' });
  const b = await makeTask({ title: 'Logged B', project: 'logged' });
  const task = await makeTask({ title: 'Logged deps', project: 'logged' });

  await patch(task.id, { deps: [a.id] });
  let changes = (await detail(task.id)).recentChanges;
  expect(changes[0].diff).toEqual({ deps: { before: [], after: [a.id] } });
  expect(changes[0].actor).toEqual({ kind: 'http' });

  await patch(task.id, { deps: [a.id, b.id] });
  changes = (await detail(task.id)).recentChanges;
  expect(changes[0].diff).toEqual({ deps: { before: [a.id], after: [a.id, b.id] } });

  await patch(task.id, { deps: null });
  changes = (await detail(task.id)).recentChanges;
  expect(changes[0].diff).toEqual({ deps: { before: [a.id, b.id], after: [] } });
  expect(changes[1].diff.deps).toEqual({ before: [a.id], after: [a.id, b.id] }); // one row per mutation
});

// ------------------------------------------------- MCP surface parity

test('task_create with deps and task_get mirror HTTP: deps ids, blocked, progress', async () => {
  const client = await connectClient();
  try {
    await client.callTool({ name: 'project_create', arguments: { name: 'mcp-deps', paths: ['/workspace/mcp-deps'] } });
    const first = jsonOf(
      await client.callTool({ name: 'task_create', arguments: { title: 'MCP dep one', project: 'mcp-deps' } }),
    ).task;
    const second = jsonOf(
      await client.callTool({ name: 'task_create', arguments: { title: 'MCP dep two', project: 'mcp-deps' } }),
    ).task;

    const created = await client.callTool({
      name: 'task_create',
      arguments: { title: 'MCP dependent', project: 'mcp-deps', deps: [second.id, first.id] },
    });
    expect(created.isError).toBeFalsy();
    expect(jsonOf(created).task).toMatchObject({
      deps: [first.id, second.id],
      blocked: true,
      progress: null,
    });

    // same values over the HTTP read surface
    expect((await detail(jsonOf(created).task.id)).task).toMatchObject({
      deps: [first.id, second.id],
      blocked: true,
      progress: null,
    });

    const got = await client.callTool({ name: 'task_get', arguments: { id: jsonOf(created).task.id } });
    expect(got.isError).toBeFalsy();
    expect(jsonOf(got).task).toMatchObject({ deps: [first.id, second.id], blocked: true });
  } finally {
    await client.close();
  }
});

test('MCP cycle rejection carries the identical message the HTTP API returns', async () => {
  const client = await connectClient();
  try {
    const x = jsonOf(
      await client.callTool({ name: 'task_create', arguments: { title: 'Parity X', project: 'mcp-deps' } }),
    ).task;
    const y = jsonOf(
      await client.callTool({
        name: 'task_create',
        arguments: { title: 'Parity Y', project: 'mcp-deps', deps: [x.id] },
      }),
    ).task;

    const viaMcp = await client.callTool({ name: 'task_update', arguments: { id: x.id, deps: [y.id] } });
    expect(viaMcp.isError).toBe(true);
    const message = textOf(viaMcp);
    expect(message).toContain('cycle');
    expect(message).toContain(`${x.id} -> ${y.id} -> ${x.id}`);

    // the same request over HTTP fails with exactly the same words
    const viaHttp = await patch(x.id, { deps: [y.id] });
    expect(viaHttp.status).toBe(409);
    expect(await errorOf(viaHttp)).toBe(message);
  } finally {
    await client.close();
  }
});
