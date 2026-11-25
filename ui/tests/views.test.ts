import { afterAll, beforeAll, expect, test } from 'vitest';
import { startDaemon, type DaemonHandle } from '../../tests/helpers/daemon.js';
import { createHttpApi } from '../src/api.js';
import { deriveList, type Scope, type ViewName, type Visibility } from '../src/views.js';
import type { Task } from '../src/types.js';

/**
 * Client-side view derivation, asserted against a REAL daemon (v0.3 T3):
 * the daemon is seeded through the HTTP API, the view=all payload feeds
 * deriveList, and the derivation must reproduce the server's own view
 * semantics (src/query.ts is the reference) — open/today/blocked, the
 * visibility toggles, explicit scoping, and the default ordering.
 *
 * The clock is fixed so today/hidden boundaries are deterministic.
 */

const NOW = new Date(2026, 10, 25, 12, 0, 0).getTime(); // 2026-11-25 12:00 local

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

const NO_TOGGLES: Visibility = { showHidden: false, showDone: false, showDropped: false };

let daemon: DaemonHandle;
let api: ReturnType<typeof createHttpApi>;
let tasks: Task[] = [];

async function seed(title: string, extra: Record<string, unknown> = {}): Promise<Task> {
  const response = await fetch(`${daemon.baseUrl}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, project: 'spine', ...extra }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { task: Task }).task;
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
  api = createHttpApi(daemon.baseUrl);

  await fetch(`${daemon.baseUrl}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'spine', paths: ['/workspace/spine'] }),
  });

  // the ordering trio, created in id order C, B, A so the default order must
  // re-sort them by due (then priority, then id)
  const noDueHigh = await seed('ordering no-due H', { priority: 'H' });
  const dueToday = await seed('ordering due today', { due: iso(NOW - 3 * 3600_000) }); // 09:00 today
  const duePast = await seed('ordering due past', { due: iso(NOW - 2 * 24 * 3600_000), priority: 'L' });

  const openFuture = await seed('open due future', { due: iso(NOW + 3 * 24 * 3600_000) });
  const hiddenTask = await seed('hidden from the default views', { hiddenUntil: iso(NOW + 24 * 3600_000) });
  const unbound = await seed('unbound capture', { project: null });

  const doneTask = await seed('done and also hidden', { hiddenUntil: iso(NOW + 24 * 3600_000) });
  await patch(doneTask.id, { status: 'done' });
  const droppedTask = await seed('dropped junk');
  await patch(droppedTask.id, { status: 'dropped' });

  const blocker = await seed('the blocker');
  const blocked = await seed('blocked behind it', { deps: [blocker.id] });

  tasks = (await api.listTasks()).tasks;

  // sanity: the daemon actually reports what the derivation will mirror
  const byTitle = new Map(tasks.map((task) => [task.title, task]));
  expect(byTitle.get('blocked behind it')?.blocked).toBe(true);
  expect(byTitle.get('hidden from the default views')?.hiddenUntil).not.toBeNull();
  expect(noDueHigh.id).toBeLessThan(dueToday.id); // ids ascending for the tiebreak asserts below
});

afterAll(async () => {
  await daemon.stop();
});

function derive(view: ViewName, scope: Scope = 'all', visibility: Visibility = NO_TOGGLES, now = NOW): Task[] {
  return deriveList(tasks, { view, scope, visibility, now });
}

function titles(list: Task[]): string[] {
  return list.map((task) => task.title);
}

test('the open view: open tasks only, default ordering (due asc, no-due last, priority desc, id asc)', () => {
  const list = derive('open');
  // done/dropped/hidden are out
  expect(titles(list)).not.toContain('done and also hidden');
  expect(titles(list)).not.toContain('dropped junk');
  expect(titles(list)).not.toContain('hidden from the default views');

  // the ordering trio: due past first, due today next, no-due last — the
  // no-due task's H priority does NOT pull it ahead of due tasks
  const ordered = titles(list);
  expect(ordered.indexOf('ordering due past')).toBeLessThan(ordered.indexOf('ordering due today'));
  expect(ordered.indexOf('ordering due today')).toBeLessThan(ordered.indexOf('ordering no-due H'));

  // the unbound capture is in the global open view (capture-first)
  expect(titles(list)).toContain('unbound capture');
});

test('the today view: open tasks due today or overdue only', () => {
  const list = derive('today');
  expect(titles(list)).toEqual(expect.arrayContaining(['ordering due past', 'ordering due today']));
  expect(titles(list)).not.toContain('open due future'); // due beyond today
  expect(titles(list)).not.toContain('ordering no-due H'); // no due at all
  // due ascending inside the view
  expect(titles(list).indexOf('ordering due past')).toBeLessThan(titles(list).indexOf('ordering due today'));
});

test('the blocked view: open tasks whose derived blocked flag is true', () => {
  expect(titles(derive('blocked'))).toEqual(['blocked behind it']);
});

test('scoping is explicit: project narrows, unbound isolates, all is global', () => {
  const projectId = tasks.find((task) => task.projectName === 'spine')!.projectId!;
  expect(titles(derive('open', projectId))).not.toContain('unbound capture');
  expect(titles(derive('open', projectId))).toContain('ordering due past');

  expect(titles(derive('open', 'unbound'))).toEqual(['unbound capture']);
  expect(titles(derive('open', 'all'))).toContain('unbound capture');
});

test('visibility toggles add their set back, badge-independent of each other', () => {
  // showDone adds the done task — even though it is ALSO hidden, done wins
  // its own gate (the hidden toggle only affects otherwise-open tasks)
  expect(titles(derive('open', 'all', { ...NO_TOGGLES, showDone: true }))).toContain('done and also hidden');
  expect(titles(derive('open', 'all', { ...NO_TOGGLES, showHidden: true }))).not.toContain('done and also hidden');

  // showHidden adds the hidden open task; showDropped adds the dropped one
  expect(titles(derive('open', 'all', { ...NO_TOGGLES, showHidden: true }))).toContain(
    'hidden from the default views',
  );
  expect(titles(derive('open', 'all', { ...NO_TOGGLES, showDropped: true }))).toContain('dropped junk');

  // all three at once
  const everything = derive('open', 'all', { showHidden: true, showDone: true, showDropped: true });
  expect(titles(everything)).toEqual(
    expect.arrayContaining(['done and also hidden', 'dropped junk', 'hidden from the default views']),
  );
});

test('the hidden gate is time-sensitive: after hidden_until passes, the task is open again', () => {
  const afterHidden = NOW + 25 * 3600_000;
  expect(titles(derive('open', 'all', NO_TOGGLES, afterHidden))).toContain('hidden from the default views');
});
