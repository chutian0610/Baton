import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { startDaemon, type DaemonHandle } from './helpers/daemon.js';

/**
 * Concurrency verification (T9, ADR-0002): SQLite WAL plus busy timeout must
 * make concurrent writes from parallel connections transactionally safe —
 * nothing lost, no SQLITE_BUSY, no 5xx — and parallel MCP sessions must work
 * alongside direct HTTP writes on the same store.
 *
 * Determinism comes from ownership: writer i exclusively owns the tasks it
 * creates and drives them through a fixed legal sequence, so although the
 * writers interleave freely at the daemon, the final state of every task is
 * exactly the last mutation its writer confirmed.
 */

const WRITERS = 4;
const TASKS_PER_WRITER = 5; // × 5 mutations per task = 25 mutations per writer

let daemon: DaemonHandle;

beforeAll(async () => {
  daemon = await startDaemon();
});

afterAll(async () => {
  await daemon.stop();
});

// ---------------------------------------------------------------- helpers

const JSON_HEADERS = { 'content-type': 'application/json' };

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    method,
    headers: JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * Every mutation in these tests is legal, so anything but 2xx is a failure.
 * The body is scanned for SQLite-busy-style text so a wrapped lock error
 * fails with a message naming the request that hit it.
 */
async function assertOk(response: Response, context: string): Promise<any> {
  const text = await response.text();
  const summary = `${context}: ${response.status} ${text}`;
  expect(response.status, summary).toBeGreaterThanOrEqual(200);
  expect(response.status, summary).toBeLessThan(300);
  expect(text, summary).not.toMatch(/sqlite/i);
  expect(text, summary).not.toMatch(/database is (locked|busy)/i);
  return text === '' ? null : JSON.parse(text);
}

interface ConfirmedTask {
  id: number;
  title: string;
  /** The task's owning writer — tasks are never shared between writers. */
  writer: number;
  index: number;
}

/** The per-task mutation sequence every writer drives: create → start → annotate → done → reopen. */
async function runPipeline(task: ConfirmedTask): Promise<void> {
  await assertOk(await request('POST', `/tasks/${task.id}/start`), `w${task.writer} t${task.index} start`);
  await assertOk(
    await request('POST', `/tasks/${task.id}/annotations`, { body: `note w${task.writer}-${task.index}` }),
    `w${task.writer} t${task.index} annotate`,
  );
  await assertOk(await request('POST', `/tasks/${task.id}/done`), `w${task.writer} t${task.index} done`);
  await assertOk(
    await request('PATCH', `/tasks/${task.id}`, { status: 'pending' }),
    `w${task.writer} t${task.index} reopen`,
  );
}

/** One writer's sequential loop over the tasks it exclusively owns. */
async function runWriter(writer: number, project: string): Promise<ConfirmedTask[]> {
  const owned: ConfirmedTask[] = [];
  for (let index = 0; index < TASKS_PER_WRITER; index++) {
    const title = `w${writer}-task-${index}`;
    const created = await assertOk(
      await request('POST', '/tasks', { title, project, tags: [`w${writer}`], priority: 'M' }),
      `w${writer} t${index} create`,
    );
    const task: ConfirmedTask = { id: created.task.id, title, writer, index };
    owned.push(task);
    await runPipeline(task);
  }
  return owned;
}

// ------------------------------------------------- parallel HTTP writers

test('4 parallel HTTP writers × 25 mutations each: nothing lost, final statuses exact, no 5xx or SQLITE_BUSY', async () => {
  await assertOk(await request('POST', '/projects', { name: 'load', paths: ['/workspace/load'] }), 'project');

  const ownedPerWriter = await Promise.all(
    Array.from({ length: WRITERS }, (_, writer) => runWriter(writer, 'load')),
  );
  const all = ownedPerWriter.flat();
  expect(all).toHaveLength(WRITERS * TASKS_PER_WRITER);
  expect(new Set(all.map((task) => task.id)).size).toBe(all.length); // every create landed on its own id

  for (const { id, title, writer, index } of all) {
    const detail = await assertOk(await request('GET', `/tasks/${id}`), `read ${id}`);

    // the entity and every field the writer last set
    expect(detail.task.title).toBe(title);
    expect(detail.task.status).toBe('pending'); // exactly the last status written (reopen)
    expect(detail.task.tags).toEqual([`w${writer}`]);
    expect(detail.task.priority).toBe('M');

    // the annotation mutation survived
    expect(detail.annotations).toHaveLength(1);
    expect(detail.annotations[0].body).toBe(`note w${writer}-${index}`);

    // the verb sequence left exactly one closed Interval
    expect(detail.intervals).toHaveLength(1);
    expect(detail.intervals[0].endedAt).not.toBeNull();

    // the change log kept every transition, newest first: reopen, done,
    // start, create. Consecutive exact duplicates are collapsed first — a
    // known src quirk currently logs each PATCH-status mutation twice (see
    // the skipped test below); completeness and order must hold either way.
    const statusDiffs = detail.recentChanges
      .map((change: any) => change.diff.status)
      .filter(
        (diff: any, index: number, all: any[]) =>
          index === 0 || JSON.stringify(diff) !== JSON.stringify(all[index - 1]),
      );
    expect(statusDiffs).toEqual([
      { before: 'done', after: 'pending' },
      { before: 'active', after: 'done' },
      { before: 'pending', after: 'active' },
      { before: null, after: 'pending' }, // the create row records every field as "after"
    ]);
    expect(detail.recentChanges.at(-1).diff.title).toEqual({ before: null, after: title });
  }
});

// ------------------------------------- parallel MCP sessions + HTTP writes

const MCP_SESSIONS = 3;

async function connectClient(name: string): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${daemon.baseUrl}/mcp`));
  await client.connect(transport); // performs the initialize handshake
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>, context: string): Promise<any> {
  const result: CallToolResult = await client.callTool({ name, arguments: args });
  const block = result.content[0];
  expect(result.isError, context).toBeFalsy();
  expect(block?.type, context).toBe('text');
  return JSON.parse((block as { text: string }).text);
}

/** One MCP session's interleaved tool calls over its own task. */
async function runMcpSession(client: Client, session: number): Promise<{ id: number; title: string }> {
  const title = `mcp-${session}-task`;
  const created = await callTool(
    client,
    'task_create',
    { title, project: 'mixed', tags: [`mcp${session}`] },
    `mcp ${session} create`,
  );
  const id = created.task.id;

  await callTool(client, 'task_start', { id }, `mcp ${session} start`);
  await callTool(client, 'task_annotate', { id, body: `note mcp-${session}` }, `mcp ${session} annotate`);
  const mid = await callTool(client, 'task_get', { id }, `mcp ${session} get`);
  expect(mid.task.status, `mcp ${session}`).toBe('active');
  expect(mid.intervals, `mcp ${session}`).toHaveLength(1);
  await callTool(client, 'task_update', { id, effort: '2h' }, `mcp ${session} update`);
  await callTool(client, 'task_done', { id }, `mcp ${session} done`);
  await callTool(client, 'task_update', { id, status: 'pending' }, `mcp ${session} reopen`);
  const end = await callTool(client, 'task_get', { id }, `mcp ${session} final get`);
  expect(end.task.status, `mcp ${session}`).toBe('pending');
  return { id, title };
}

test('parallel MCP sessions interleave with HTTP writes; every call on both surfaces succeeds', async () => {
  await assertOk(await request('POST', '/projects', { name: 'mixed', paths: ['/workspace/mixed'] }), 'project');

  const clients = await Promise.all(
    Array.from({ length: MCP_SESSIONS }, (_, session) => connectClient(`concurrent-client-${session}`)),
  );
  try {
    // 3 official MCP sessions and one plain HTTP writer hammer the same store at once
    const [httpOwned, ...mcpOwned] = await Promise.all([
      runWriter(0, 'mixed'),
      ...clients.map((client, session) => runMcpSession(client, session)),
    ]);

    const everyone = [...httpOwned, ...mcpOwned.flat()];
    expect(everyone).toHaveLength(TASKS_PER_WRITER + MCP_SESSIONS);
    expect(new Set(everyone.map((task) => task.id)).size).toBe(everyone.length);

    for (const { id, title } of everyone) {
      const detail = await assertOk(await request('GET', `/tasks/${id}`), `read ${id}`);
      expect(detail.task.title).toBe(title);
      expect(detail.task.status).toBe('pending'); // the last status written per task
      expect(detail.annotations).toHaveLength(1);
    }

    // Each session's writes are attributed to its own MCP actor: right client
    // name, and distinct session ids prove these were parallel sessions.
    const sessionIds: string[] = [];
    for (const [session, { id }] of mcpOwned.flat().entries()) {
      const detail = await assertOk(await request('GET', `/tasks/${id}`), `actor read ${id}`);
      const createRow = detail.recentChanges.at(-1); // oldest row is the create
      expect(createRow.actor).toMatchObject({ kind: 'mcp', clientName: `concurrent-client-${session}` });
      sessionIds.push(createRow.actor.sessionId);
    }
    expect(new Set(sessionIds).size).toBe(MCP_SESSIONS);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
});

// --------------------------------------------------------------- src finding

test('a PATCH-status mutation is change-logged exactly once (both surfaces agree)', async () => {
  // Found by the concurrency/durability tests as a skipped repro (against
  // 40f5c85): PATCH {status} used to append TWO rows (one from
  // applyStatusTransition's recordStatusChange, one from updateTask's generic
  // field diff) while the verbs logged one. Fixed by keeping
  // applyStatusTransition recording-free: the PATCH path's row comes from the
  // field diff, the verb paths record via transitionTaskStatus. One mutation,
  // one row, on both surfaces.
  await assertOk(await request('POST', '/projects', { name: 'dup-row', paths: ['/workspace/dup-row'] }), 'project');
  const created = await assertOk(
    await request('POST', '/tasks', { title: 'Doubly logged', project: 'dup-row' }),
    'create',
  );
  await assertOk(await request('PATCH', `/tasks/${created.task.id}`, { status: 'active' }), 'patch');

  const detail = await assertOk(await request('GET', `/tasks/${created.task.id}`), 'read');
  const transitionRows = detail.recentChanges.filter(
    (change: any) => change.diff.status !== undefined && change.diff.status.before !== null,
  );
  expect(transitionRows).toHaveLength(1); // currently 2: the same transition, logged twice
});
