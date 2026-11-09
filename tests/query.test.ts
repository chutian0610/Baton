import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { startDaemon, type DaemonHandle } from './helpers/daemon.js';

/**
 * Process-level tests for the Query model (T6): every filter field alone and
 * combined (AND semantics), the four quick views' set semantics, the default
 * exclusions (done/dropped/future-hidden — and the explicit-status override),
 * the stable default ordering with mixed/absent values plus sort and limit
 * overrides, the whole-store fallback note, tag_list counts, and MCP <-> HTTP
 * parity (the same JSON payload for the main paths).
 *
 * Every test isolates its data in its own project and scopes the query with
 * that project's bound path as cwd (/w/<name> by default) so the shared
 * daemon's store never bleeds between tests. `all` and the fallback paths are
 * whole-store by definition and assert containment over known fixtures.
 */
let daemon: DaemonHandle;

beforeAll(async () => {
  daemon = await startDaemon();
});

afterAll(async () => {
  await daemon.stop();
});

// ---------------------------------------------------------------- helpers

async function makeProject(name: string): Promise<{ id: number; name: string }> {
  const response = await fetch(`${daemon.baseUrl}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, paths: [`/w/${name}`] }),
  });
  expect(response.status).toBe(201);
  return (await response.json()).project;
}

async function makeTask(body: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await fetch(`${daemon.baseUrl}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return (await response.json()).task;
}

async function patch(id: number, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${daemon.baseUrl}/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
}

async function list(params: Record<string, string>): Promise<{ status: number; body: any }> {
  const response = await fetch(`${daemon.baseUrl}/tasks?${new URLSearchParams(params)}`);
  return { status: response.status, body: await response.json() };
}

async function listOk(params: Record<string, string>): Promise<any> {
  const result = await list(params);
  expect(result.status).toBe(200);
  return result.body;
}

/** Runs a structured filter over the given project's cwd scope. */
async function filterWith(filterObj: Record<string, unknown>, cwd: string): Promise<any> {
  return listOk({ filter: JSON.stringify(filterObj), cwd });
}

const idsOf = (result: any): number[] => result.tasks.map((task: any) => task.id);

/** An ISO datetime `offsetDays` from today at a fixed local hour (stable within a test run). */
function dayAt(offsetDays: number, hour = 12): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}

async function connectClient(): Promise<Client> {
  const client = new Client({ name: 'baton-query-client', version: '1.0.0' });
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

// ------------------------------------------------- filter fields (each alone)

test('status filter: single value matches only that status', async () => {
  const project = await makeProject('q-status');
  const pending = await makeTask({ title: 'Stays pending', project: 'q-status' });
  const active = await makeTask({ title: 'Becomes active', project: 'q-status' });
  await patch(active.id, { status: 'active' });
  const done = await makeTask({ title: 'Gets done', project: 'q-status' });
  await patch(done.id, { status: 'done' });

  const result = await filterWith({ status: 'pending' }, '/w/q-status');
  expect(idsOf(result)).toEqual([pending.id]);
  expect(result.scope).toEqual({ project: { id: project.id, name: 'q-status' } });
});

test('status filter: array; explicitly naming statuses includes done and dropped', async () => {
  await makeProject('q-status-array');
  await makeTask({ title: 'Open one', project: 'q-status-array' });
  const done = await makeTask({ title: 'Closed one', project: 'q-status-array' });
  await patch(done.id, { status: 'done' });
  const dropped = await makeTask({ title: 'Abandoned one', project: 'q-status-array' });
  await patch(dropped.id, { status: 'dropped' });

  const result = await filterWith({ status: ['done', 'dropped'] }, '/w/q-status-array');
  expect(idsOf(result)).toEqual([done.id, dropped.id]); // default order id asc
});

test('project filter: by name and by id; unknown project answers 404', async () => {
  await makeProject('q-proj-a');
  const b = await makeProject('q-proj-b');
  const taskA = await makeTask({ title: 'In A', project: 'q-proj-a' });
  const taskB = await makeTask({ title: 'In B', project: 'q-proj-b' });

  const byName = await listOk({ filter: JSON.stringify({ project: 'q-proj-b' }) });
  expect(idsOf(byName)).toEqual([taskB.id]);
  expect(byName.scope).toEqual({ project: { id: b.id, name: 'q-proj-b' } }); // no fallback note

  const byId = await listOk({ filter: JSON.stringify({ project: b.id }) });
  expect(idsOf(byId)).toEqual([taskB.id]);
  expect(byId.tasks[0].id).not.toBe(taskA.id);

  const unknown = await list({ filter: JSON.stringify({ project: 'no-such-project' }) });
  expect(unknown.status).toBe(404);
  expect(unknown.body.error).toContain('unknown project name');
});

test('tags filter: any mode by default, all mode on request, lowercase normalization', async () => {
  await makeProject('q-tags');
  const both = await makeTask({ title: 'Carries both', project: 'q-tags', tags: ['qt-rust', 'qt-cli'] });
  const rust = await makeTask({ title: 'Carries rust', project: 'q-tags', tags: ['qt-rust'] });
  const web = await makeTask({ title: 'Carries web', project: 'q-tags', tags: ['qt-web'] });

  // "any" is the default; uppercase input matches the stored lowercase tags
  const any = await filterWith({ tags: ['QT-RUST', 'qt-web'] }, '/w/q-tags');
  expect(idsOf(any)).toEqual([both.id, rust.id, web.id]);

  const all = await filterWith({ tags: ['qt-rust', 'qt-cli'], tagMode: 'all' }, '/w/q-tags');
  expect(idsOf(all)).toEqual([both.id]);

  const allSingle = await filterWith({ tags: ['qt-rust'], tagMode: 'all' }, '/w/q-tags');
  expect(idsOf(allSingle)).toEqual([both.id, rust.id]);
});

test('parent filter: direct children of one parent; unknown parent answers 404', async () => {
  await makeProject('q-parent');
  const root = await makeTask({ title: 'Root', project: 'q-parent' });
  const child = await makeTask({ title: 'Child', project: 'q-parent', parent: root.id });
  await makeTask({ title: 'Grandchild', project: 'q-parent', parent: child.id });

  const result = await filterWith({ parent: root.id }, '/w/q-parent');
  expect(idsOf(result)).toEqual([child.id]); // direct children only

  const unknown = await list({ filter: JSON.stringify({ parent: 999999 }), cwd: '/w/q-parent' });
  expect(unknown.status).toBe(404);
  expect(unknown.body.error).toContain('unknown parent task id');
});

test('hasParent filter: false lists roots only, true lists non-roots; contradicts parent', async () => {
  await makeProject('q-hasparent');
  const rootOne = await makeTask({ title: 'Root one', project: 'q-hasparent' });
  const rootTwo = await makeTask({ title: 'Root two', project: 'q-hasparent' });
  const child = await makeTask({ title: 'Child', project: 'q-hasparent', parent: rootOne.id });
  const grandchild = await makeTask({ title: 'Grandchild', project: 'q-hasparent', parent: child.id });

  const roots = await filterWith({ hasParent: false }, '/w/q-hasparent');
  expect(idsOf(roots)).toEqual([rootOne.id, rootTwo.id]);

  const nonRoots = await filterWith({ hasParent: true }, '/w/q-hasparent');
  expect(idsOf(nonRoots)).toEqual([child.id, grandchild.id]);

  const contradictory = await list({
    filter: JSON.stringify({ parent: rootOne.id, hasParent: false }),
    cwd: '/w/q-hasparent',
  });
  expect(contradictory.status).toBe(400);
  expect(contradictory.body.error).toContain('contradict');
});

test('blocked filter: derived per read from open dependencies', async () => {
  await makeProject('q-blocked');
  const open = await makeTask({ title: 'Open dependency', project: 'q-blocked' });
  const blockedOne = await makeTask({ title: 'Blocked one', project: 'q-blocked', deps: [open.id] });
  const blockedTwo = await makeTask({ title: 'Blocked two', project: 'q-blocked', deps: [open.id] });
  const free = await makeTask({ title: 'No deps', project: 'q-blocked' });
  const closedBlocked = await makeTask({ title: 'Done but blocked', project: 'q-blocked', deps: [open.id] });
  await patch(closedBlocked.id, { status: 'done' });

  const blocked = await filterWith({ blocked: true }, '/w/q-blocked');
  expect(idsOf(blocked)).toEqual([blockedOne.id, blockedTwo.id]); // done one excluded by default

  const unblocked = await filterWith({ blocked: false }, '/w/q-blocked');
  expect(idsOf(unblocked)).toEqual([open.id, free.id]);
});

test('dueBefore filter: inclusive bound; tasks without a due date never match', async () => {
  await makeProject('q-due-before');
  const early = await makeTask({ title: 'Jan 3', project: 'q-due-before', due: '2027-01-03T08:00:00Z' });
  const mid = await makeTask({ title: 'Jan 5', project: 'q-due-before', due: '2027-01-05T09:00:00Z' });
  await makeTask({ title: 'Jan 7', project: 'q-due-before', due: '2027-01-07T09:00:00Z' });
  await makeTask({ title: 'No due', project: 'q-due-before' });

  const result = await filterWith({ dueBefore: '2027-01-05T09:00:00Z' }, '/w/q-due-before');
  expect(idsOf(result)).toEqual([early.id, mid.id]); // boundary itself is included
});

test('dueAfter filter: inclusive bound; combined with dueBefore as a range', async () => {
  await makeProject('q-due-after');
  await makeTask({ title: 'Jan 3', project: 'q-due-after', due: '2027-01-03T08:00:00Z' });
  const mid = await makeTask({ title: 'Jan 5', project: 'q-due-after', due: '2027-01-05T09:00:00Z' });
  const late = await makeTask({ title: 'Jan 7', project: 'q-due-after', due: '2027-01-07T09:00:00Z' });
  await makeTask({ title: 'No due', project: 'q-due-after' });

  const after = await filterWith({ dueAfter: '2027-01-05T09:00:00Z' }, '/w/q-due-after');
  expect(idsOf(after)).toEqual([mid.id, late.id]); // boundary itself is included

  const range = await filterWith(
    { dueAfter: '2027-01-05T09:00:00Z', dueBefore: '2027-01-06T00:00:00Z' },
    '/w/q-due-after',
  );
  expect(idsOf(range)).toEqual([mid.id]);
});

test('priority filter: single value and array; unprioritized tasks never match', async () => {
  await makeProject('q-prio');
  const high = await makeTask({ title: 'High', project: 'q-prio', priority: 'H' });
  const medium = await makeTask({ title: 'Medium', project: 'q-prio', priority: 'M' });
  const low = await makeTask({ title: 'Low', project: 'q-prio', priority: 'L' });
  await makeTask({ title: 'None', project: 'q-prio' });

  const single = await filterWith({ priority: 'H' }, '/w/q-prio');
  expect(idsOf(single)).toEqual([high.id]);

  const array = await filterWith({ priority: ['L', 'M'] }, '/w/q-prio');
  expect(idsOf(array)).toEqual([medium.id, low.id]); // default order: priority desc (H>M>L) -> id
});

test('text filter: case-insensitive title substring', async () => {
  await makeProject('q-text');
  const shipOne = await makeTask({ title: 'Ship the release', project: 'q-text' });
  const shipTwo = await makeTask({ title: 'ship it again', project: 'q-text' });
  await makeTask({ title: 'Dock the boat', project: 'q-text' });

  const upper = await filterWith({ text: 'SHIP' }, '/w/q-text');
  expect(idsOf(upper)).toEqual([shipOne.id, shipTwo.id]);

  const lower = await filterWith({ text: 'release' }, '/w/q-text');
  expect(idsOf(lower)).toEqual([shipOne.id]);
});

test('combined filter: every field ANDs together', async () => {
  await makeProject('q-combined');
  const winner = await makeTask({
    title: 'Combined winner',
    project: 'q-combined',
    tags: ['qc-a', 'qc-b'],
    priority: 'H',
    due: '2027-01-05T09:00:00Z',
  });
  await makeTask({ title: 'Wrong status', project: 'q-combined', tags: ['qc-a', 'qc-b'], priority: 'H', due: '2027-01-05T09:00:00Z' }).then(
    (task) => patch(task.id, { status: 'done' }),
  );
  await makeTask({ title: 'Wrong tags', project: 'q-combined', tags: ['qc-a'], priority: 'H', due: '2027-01-05T09:00:00Z' });
  await makeTask({ title: 'Wrong priority', project: 'q-combined', tags: ['qc-a', 'qc-b'], priority: 'L', due: '2027-01-05T09:00:00Z' });
  await makeTask({ title: 'Wrong due', project: 'q-combined', tags: ['qc-a', 'qc-b'], priority: 'H', due: '2027-01-09T09:00:00Z' });
  await makeTask({ title: 'Wrong text', project: 'q-combined', tags: ['qc-a', 'qc-b'], priority: 'H', due: '2027-01-05T09:00:00Z' });

  const result = await filterWith(
    {
      status: 'pending',
      tags: ['qc-a', 'qc-b'],
      tagMode: 'all',
      priority: 'H',
      dueBefore: '2027-01-06T00:00:00Z',
      dueAfter: '2027-01-04T00:00:00Z',
      text: 'winner',
    },
    '/w/q-combined',
  );
  expect(idsOf(result)).toEqual([winner.id]);
});

// ----------------------------------------------------------------- ordering

test('default ordering: due asc (no due last) -> priority desc (H>M>L, none last) -> id asc', async () => {
  await makeProject('q-order');
  const t3 = await makeTask({ title: 'Jan3 08 L (first)', project: 'q-order', due: '2027-01-03T08:00:00Z', priority: 'L' });
  const t8 = await makeTask({ title: 'Jan3 08 L (tie)', project: 'q-order', due: '2027-01-03T08:00:00Z', priority: 'L' });
  const t7 = await makeTask({ title: 'Jan3 09 L', project: 'q-order', due: '2027-01-03T09:00:00Z', priority: 'L' });
  const t2 = await makeTask({ title: 'Jan5 H', project: 'q-order', due: '2027-01-05T09:00:00Z', priority: 'H' });
  const t1 = await makeTask({ title: 'Jan5 L', project: 'q-order', due: '2027-01-05T09:00:00Z', priority: 'L' });
  const t4 = await makeTask({ title: 'No due H (early id)', project: 'q-order', priority: 'H' });
  const t6 = await makeTask({ title: 'No due H (late id)', project: 'q-order', priority: 'H' });
  const t5 = await makeTask({ title: 'No due no priority', project: 'q-order' });

  const result = await listOk({ cwd: '/w/q-order' }); // default view, default ordering
  expect(idsOf(result)).toEqual([t3.id, t8.id, t7.id, t2.id, t1.id, t4.id, t6.id, t5.id]);
});

test('sort override: explicit fields and directions replace the default order', async () => {
  await makeProject('q-sort');
  const banana = await makeTask({ title: 'banana', project: 'q-sort', priority: 'L' });
  const apple = await makeTask({ title: 'Apple', project: 'q-sort', priority: 'H' });
  const cherry = await makeTask({ title: 'cherry', project: 'q-sort', priority: 'M' });
  const date = await makeTask({ title: 'date', project: 'q-sort' }); // no priority

  const priorityAsc = await filterWith({ sort: [{ field: 'priority', direction: 'asc' }] }, '/w/q-sort');
  expect(idsOf(priorityAsc)).toEqual([banana.id, cherry.id, apple.id, date.id]); // L M H, none last

  const titleBare = await filterWith({ sort: 'title' }, '/w/q-sort'); // bare field name
  expect(idsOf(titleBare)).toEqual([apple.id, banana.id, cherry.id, date.id]); // case-insensitive asc
});

test('sort override with due values: desc puts latest first and keeps no-due last', async () => {
  await makeProject('q-sort-due');
  const jan3 = await makeTask({ title: 'Jan3', project: 'q-sort-due', due: '2027-01-03T08:00:00Z' });
  const jan7 = await makeTask({ title: 'Jan7', project: 'q-sort-due', due: '2027-01-07T08:00:00Z' });
  const jan5 = await makeTask({ title: 'Jan5', project: 'q-sort-due', due: '2027-01-05T08:00:00Z' });
  const noDue = await makeTask({ title: 'No due', project: 'q-sort-due' });

  const result = await filterWith({ sort: [{ field: 'due', direction: 'desc' }] }, '/w/q-sort-due');
  expect(idsOf(result)).toEqual([jan7.id, jan5.id, jan3.id, noDue.id]);
});

test('limit truncates after sorting', async () => {
  await makeProject('q-limit');
  const first = await makeTask({ title: 'Due Jan 1', project: 'q-limit', due: '2027-01-01T08:00:00Z' });
  const second = await makeTask({ title: 'Due Jan 2', project: 'q-limit', due: '2027-01-02T08:00:00Z' });
  await makeTask({ title: 'Due Jan 3', project: 'q-limit', due: '2027-01-03T08:00:00Z' });
  await makeTask({ title: 'Due Jan 4', project: 'q-limit', due: '2027-01-04T08:00:00Z' });

  const result = await filterWith({ limit: 2 }, '/w/q-limit');
  expect(idsOf(result)).toEqual([first.id, second.id]);
});

// --------------------------------------------------------------- quick views

test('view current: open, visible tasks of the resolved Current Project only', async () => {
  const project = await makeProject('q-cur');
  await makeProject('q-cur-other');
  const pending = await makeTask({ title: 'Pending here', project: 'q-cur' });
  const active = await makeTask({ title: 'Active here', project: 'q-cur' });
  await patch(active.id, { status: 'active' });
  const done = await makeTask({ title: 'Done here', project: 'q-cur' });
  await patch(done.id, { status: 'done' });
  const dropped = await makeTask({ title: 'Dropped here', project: 'q-cur' });
  await patch(dropped.id, { status: 'dropped' });
  const hidden = await makeTask({ title: 'Hidden here', project: 'q-cur', hidden_until: '2999-01-01T00:00:00Z' });
  await makeTask({ title: 'Another project entirely', project: 'q-cur-other' });

  const result = await listOk({ view: 'current', cwd: '/w/q-cur/subdir' });
  expect(idsOf(result)).toEqual([pending.id, active.id]); // open + visible, this project only
  expect(result.scope).toEqual({ project: { id: project.id, name: 'q-cur' } });
});

test('view today: open tasks due today or overdue', async () => {
  await makeProject('q-today');
  const overdue = await makeTask({ title: 'Overdue', project: 'q-today', due: dayAt(-1) });
  const today = await makeTask({ title: 'Due today', project: 'q-today', due: dayAt(0) });
  await makeTask({ title: 'Due tomorrow', project: 'q-today', due: dayAt(1) });
  await makeTask({ title: 'No due', project: 'q-today' });
  const doneOverdue = await makeTask({ title: 'Done overdue', project: 'q-today', due: dayAt(-1) });
  await patch(doneOverdue.id, { status: 'done' });
  const hiddenOverdue = await makeTask({
    title: 'Hidden overdue',
    project: 'q-today',
    due: dayAt(-1),
    hidden_until: '2999-01-01T00:00:00Z',
  });

  const result = await listOk({ view: 'today', cwd: '/w/q-today' });
  expect(idsOf(result)).toEqual([overdue.id, today.id]); // due asc; done and hidden excluded
});

test('view blocked: open and blocked', async () => {
  await makeProject('q-vblocked');
  const dependency = await makeTask({ title: 'The blocker', project: 'q-vblocked' });
  const blocked = await makeTask({ title: 'Waiting on the blocker', project: 'q-vblocked', deps: [dependency.id] });
  await makeTask({ title: 'Free agent', project: 'q-vblocked' });
  const doneBlocked = await makeTask({ title: 'Done and blocked', project: 'q-vblocked', deps: [dependency.id] });
  await patch(doneBlocked.id, { status: 'done' });

  const result = await listOk({ view: 'blocked', cwd: '/w/q-vblocked' });
  expect(idsOf(result)).toEqual([blocked.id]);
  expect(result.tasks[0].blocked).toBe(true);
});

test('view all: everything, no default exclusions, whole store even with a cwd', async () => {
  await makeProject('q-vall');
  await makeProject('q-vall-other');
  const pending = await makeTask({ title: 'Open', project: 'q-vall' });
  const done = await makeTask({ title: 'Done', project: 'q-vall' });
  await patch(done.id, { status: 'done' });
  const dropped = await makeTask({ title: 'Dropped', project: 'q-vall' });
  await patch(dropped.id, { status: 'dropped' });
  const hidden = await makeTask({ title: 'Hidden future', project: 'q-vall', hidden_until: '2999-01-01T00:00:00Z' });
  const elsewhere = await makeTask({ title: 'Other project', project: 'q-vall-other' });

  const result = await listOk({ view: 'all', cwd: '/w/q-vall' }); // cwd deliberately ignored
  const ids = idsOf(result);
  for (const expected of [pending.id, done.id, dropped.id, hidden.id, elsewhere.id]) {
    expect(ids).toContain(expected);
  }
  expect(result.scope).toEqual({ project: null }); // whole store by definition, no fallback note
});

// -------------------------------------------------- default exclusions detail

test('explicitly naming statuses turns the default exclusions off entirely', async () => {
  await makeProject('q-override');
  const plain = await makeTask({ title: 'Plain pending', project: 'q-override' });
  const hiddenPending = await makeTask({
    title: 'Hidden pending',
    project: 'q-override',
    hidden_until: '2999-01-01T00:00:00Z',
  });
  const done = await makeTask({ title: 'Done', project: 'q-override' });
  await patch(done.id, { status: 'done' });
  const dropped = await makeTask({ title: 'Dropped', project: 'q-override' });
  await patch(dropped.id, { status: 'dropped' });

  // default view: done, dropped, and future-hidden all excluded
  const defaultView = await listOk({ cwd: '/w/q-override' });
  expect(idsOf(defaultView)).toEqual([plain.id]);

  // naming statuses = taking control of visibility: done/dropped come back...
  const closed = await filterWith({ status: ['done', 'dropped'] }, '/w/q-override');
  expect(idsOf(closed)).toEqual([done.id, dropped.id]);

  // ...and the whole default-exclusion package is off, hidden included
  const pendingAll = await filterWith({ status: 'pending' }, '/w/q-override');
  expect(idsOf(pendingAll)).toEqual([plain.id, hiddenPending.id]);
});

// ------------------------------------------------------- whole-store fallback

test('unbound or absent cwd: whole store with a note in scope', async () => {
  await makeProject('q-fallback-a');
  await makeProject('q-fallback-b');
  const taskA = await makeTask({ title: 'In fallback A', project: 'q-fallback-a' });
  const taskB = await makeTask({ title: 'In fallback B', project: 'q-fallback-b' });

  const unbound = await listOk({ view: 'current', cwd: '/definitely/not/bound' });
  expect(unbound.scope.project).toBeNull();
  expect(unbound.scope.note).toContain('whole store');
  const unboundIds = idsOf(unbound);
  expect(unboundIds).toContain(taskA.id);
  expect(unboundIds).toContain(taskB.id); // whole store, not one project

  const noCwd = await listOk({ filter: JSON.stringify({ text: 'in fallback a' }) });
  expect(noCwd.scope).toEqual({ project: null, note: expect.stringContaining('no cwd') });
  expect(idsOf(noCwd)).toEqual([taskA.id]);

  const noParams = await listOk({});
  expect(noParams.scope.project).toBeNull();
  expect(noParams.scope.note).toContain('whole store');
});

// ---------------------------------------------------------------- validation

test('input validation rejects malformed queries with 400 and a naming message', async () => {
  const badView = await list({ view: 'yesterday', cwd: '/w/q-fallback-a' });
  expect(badView.status).toBe(400);
  expect(badView.body.error).toContain('view must be one of');

  const both = await list({ view: 'all', filter: '{"status":"done"}' });
  expect(both.status).toBe(400);
  expect(both.body.error).toContain('not both');

  const unknownField = await list({ filter: '{"colour":"red"}' });
  expect(unknownField.status).toBe(400);
  expect(unknownField.body.error).toContain('unknown filter field');

  const badJson = await list({ filter: 'not json' });
  expect(badJson.status).toBe(400);
  expect(badJson.body.error).toContain('URL-encoded JSON object');

  const badSort = await list({ filter: '{"sort":[{"field":"urgency"}]}' });
  expect(badSort.status).toBe(400);
  expect(badSort.body.error).toContain('sort field must be');

  const badLimit = await list({ filter: '{"limit":0}' });
  expect(badLimit.status).toBe(400);
  expect(badLimit.body.error).toContain('limit must be a positive integer');

  const badStatus = await list({ filter: '{"status":"paused"}' });
  expect(badStatus.status).toBe(400);
  expect(badStatus.body.error).toContain('status must be');

  const badDirection = await list({ filter: '{"sort":[{"field":"due","direction":"up"}]}' });
  expect(badDirection.status).toBe(400);
  expect(badDirection.body.error).toContain('sort direction must be');
});

// ----------------------------------------------------------------- tag_list

test('tag_list: counts tasks per tag across ALL statuses; closed-only tags still appear', async () => {
  const client = await connectClient();
  try {
    await makeProject('q-taglist');
    await makeTask({ title: 'Rust and cli', project: 'q-taglist', tags: ['ql-rust', 'ql-cli'] });
    await makeTask({ title: 'More rust', project: 'q-taglist', tags: ['ql-rust'] });
    const doneRust = await makeTask({ title: 'Done rust', project: 'q-taglist', tags: ['ql-rust'] });
    await patch(doneRust.id, { status: 'done' });
    const droppedGone = await makeTask({ title: 'Dropped gone', project: 'q-taglist', tags: ['ql-gone'] });
    await patch(droppedGone.id, { status: 'dropped' });

    const result = await client.callTool({ name: 'tag_list', arguments: {} });
    expect(result.isError).toBeFalsy();
    const tags = (jsonOf(result) as { tags: { tag: string; count: number }[] }).tags;

    // every task counts, whatever its status ("tags in use across the store")
    expect(tags.find((entry) => entry.tag === 'ql-rust')).toEqual({ tag: 'ql-rust', count: 3 });
    expect(tags.find((entry) => entry.tag === 'ql-cli')).toEqual({ tag: 'ql-cli', count: 1 });
    // a tag carried only by a dropped task is still in use and must appear
    expect(tags.find((entry) => entry.tag === 'ql-gone')).toEqual({ tag: 'ql-gone', count: 1 });
    const sorted = tags.map((entry) => entry.tag);
    expect([...sorted].sort()).toEqual(sorted); // stable, sorted by tag
  } finally {
    await client.close();
  }
});

// ----------------------------------------------------------- MCP <-> HTTP

test('MCP task_list mirrors GET /tasks: views, filters, sort/limit, fallback (same payload)', async () => {
  const client = await connectClient();
  try {
    await makeProject('q-parity');
    await makeProject('q-parity-other');
    const plain = await makeTask({ title: 'Parity open', project: 'q-parity', due: '2027-02-02T08:00:00Z' });
    const urgent = await makeTask({ title: 'Parity urgent', project: 'q-parity', priority: 'H' });
    const done = await makeTask({ title: 'Parity done', project: 'q-parity' });
    await patch(done.id, { status: 'done' });
    await makeTask({ title: 'Parity hidden', project: 'q-parity', hidden_until: '2999-01-01T00:00:00Z' });
    await makeTask({ title: 'Parity other project', project: 'q-parity-other' });

    // quick view over a bound cwd
    const httpCurrent = await listOk({ view: 'current', cwd: '/w/q-parity' });
    const mcpCurrent = jsonOf(
      await client.callTool({ name: 'task_list', arguments: { view: 'current', cwd: '/w/q-parity' } }),
    );
    expect(mcpCurrent).toEqual(httpCurrent);
    expect(idsOf(mcpCurrent)).toEqual([plain.id, urgent.id]); // due first, no-due after

    // structured filter (explicit statuses turn the default exclusions off)
    const httpFilter = await listOk({
      filter: JSON.stringify({ status: ['done', 'pending'], project: 'q-parity' }),
    });
    const mcpFilter = jsonOf(
      await client.callTool({
        name: 'task_list',
        arguments: { status: ['done', 'pending'], project: 'q-parity' },
      }),
    );
    expect(mcpFilter).toEqual(httpFilter);

    // sort + limit override through the flat MCP arguments
    const httpSorted = await listOk({
      filter: JSON.stringify({ sort: [{ field: 'title', direction: 'desc' }], limit: 2, project: 'q-parity' }),
    });
    const mcpSorted = jsonOf(
      await client.callTool({
        name: 'task_list',
        arguments: { sort: [{ field: 'title', direction: 'desc' }], limit: 2, project: 'q-parity' },
      }),
    );
    expect(mcpSorted).toEqual(httpSorted);
    expect(idsOf(mcpSorted)).toHaveLength(2);

    // whole-store fallback note is part of both payloads
    const httpFallback = await listOk({ view: 'blocked', cwd: '/definitely/not/bound/either' });
    const mcpFallback = jsonOf(
      await client.callTool({ name: 'task_list', arguments: { view: 'blocked', cwd: '/definitely/not/bound/either' } }),
    );
    expect(mcpFallback).toEqual(httpFallback);
    expect(mcpFallback.scope.note).toContain('whole store');
  } finally {
    await client.close();
  }
});

test('MCP task_list errors carry the identical message as the HTTP API', async () => {
  const client = await connectClient();
  try {
    const overMcp = await client.callTool({
      name: 'task_list',
      arguments: { project: 'no-such-project-for-parity' },
    });
    expect(overMcp.isError).toBe(true);
    const message = textOf(overMcp);

    const overHttp = await list({ filter: JSON.stringify({ project: 'no-such-project-for-parity' }) });
    expect(overHttp.status).toBe(404);
    expect(overHttp.body.error).toBe(message);
  } finally {
    await client.close();
  }
});
