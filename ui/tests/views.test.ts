import { afterAll, beforeAll, expect, test } from 'vitest';
import { startDaemon, type DaemonHandle } from '../../tests/helpers/daemon.js';
import {
  buildTree,
  countViews,
  type Scope,
  type StatusFilterState,
  type ViewName,
} from '../src/views.js';
import type { Task } from '../src/types.js';

/**
 * Client-side tree derivation, asserted against a REAL daemon (v0.3
 * redesign, GitHub-style status tabs): the daemon is seeded through the HTTP
 * API, the view=all payload feeds buildTree, and the derivation must
 * reproduce the server's view semantics (src/query.ts is the reference)
 * plus the status-tab rules — Open aggregates pending/active/waiting with
 * the hidden gate and optional explicit statuses; Done/Dropped are
 * single-status archive tabs; Today/Blocked are fixed composites that ignore
 * tabs; and the tree placement rule surfaces view-matching tasks whose
 * parent chain is not visible.
 */

const NOW = new Date(2026, 10, 25, 12, 0, 0).getTime(); // 2026-11-25 12:00 local

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

const ALL: StatusFilterState = { tab: 'open', statuses: null, showHidden: false };

let daemon: DaemonHandle;
let tasks: Task[] = [];
let projectId!: number;
let parentId!: number;
let childBId!: number;

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

  projectId = (
    (
      await (
        await fetch(`${daemon.baseUrl}/projects`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'spine', paths: ['/workspace/spine'] }),
        })
      ).json()
    ).project as { id: number }
  ).id;

  const parent = await seed('the parent', { due: iso(NOW + 3 * 24 * 3600_000) }); // open, NOT today
  parentId = parent.id;
  const childA = await seed('child a', { parent: parent.id });
  const childB = await seed('child b', { parent: parent.id, priority: 'H' });
  childBId = childB.id;
  await seed('grandchild under b', { parent: childB.id });
  const doneChild = await seed('done child', { parent: parent.id });
  await patch(doneChild.id, { status: 'done' });
  await seed('hidden task', { hiddenUntil: iso(NOW + 24 * 3600_000) });
  await seed('standalone overdue', { due: iso(NOW - 24 * 3600_000) });
  await seed('unbound capture', { project: null });
  const dropped = await seed('dropped junk');
  await patch(dropped.id, { status: 'dropped' });
  const blocker = await seed('the blocker');
  await seed('blocked behind it', { deps: [blocker.id] });

  tasks = (await (await fetch(`${daemon.baseUrl}/tasks?view=all`)).json()).tasks as Task[];
});

afterAll(async () => {
  await daemon.stop();
});

function derive(view: ViewName, scope: Scope = 'all', status: Partial<StatusFilterState> = {}, expanded: Set<number> = new Set()) {
  return buildTree(tasks, {
    view,
    scope,
    status: { tab: 'open', statuses: null, showHidden: false, ...status },
    now: NOW,
    expanded,
    query: '',
  });
}

function titles(nodes: ReturnType<typeof derive>): string[] {
  return nodes.map((node) => node.task.title);
}

test('open tab, collapsed: top-level members only, childCount still counts, default order', () => {
  const tree = derive('open');
  const t = titles(tree);
  expect(t).toContain('the parent');
  expect(t).toContain('standalone overdue');
  expect(t).toContain('unbound capture'); // capture-first: visible under All
  expect(t).not.toContain('dropped junk');
  expect(t).not.toContain('hidden task');
  expect(t).not.toContain('child a'); // collapsed: children render only when expanded

  const parent = tree.find((node) => node.task.title === 'the parent')!;
  expect(parent.children).toEqual([]);
  expect(parent.childCount).toBe(3);

  // due ascending at top level: overdue first, future-due parent after
  expect(t.indexOf('standalone overdue')).toBeLessThan(t.indexOf('the parent'));
});

test('an expanded parent brings all its open-composite children; the done child needs the Done tab', () => {
  const tree = derive('open', 'all', {}, new Set([parentId]));
  const parent = tree.find((node) => node.task.title === 'the parent')!;
  const kids = parent.children.map((node) => node.task.title);
  // the children have no due dates — they match no view, but the expanded
  // parent surfaces its included set anyway. The grandchild stays hidden
  // under the collapsed child b (depth-2 test below).
  expect(kids).toEqual(['child b', 'child a']);
  expect(parent.children.map((node) => node.depth)).toEqual([1, 1]);
  expect(kids).not.toContain('done child');
});

test('the Done tab lists done tasks (and only them)', () => {
  const tree = derive('open', 'all', { tab: 'done' });
  expect(titles(tree)).toEqual(['done child']);
});

test('the Dropped tab lists dropped tasks', () => {
  const tree = derive('open', 'all', { tab: 'dropped' });
  expect(titles(tree)).toEqual(['dropped junk']);
});

test('an explicit status filter narrows the Open tab', async () => {
  const blocker = tasks.find((task) => task.title === 'the blocker')!;
  await patch(blocker.id, { status: 'active' });
  tasks = (await (await fetch(`${daemon.baseUrl}/tasks?view=all`)).json()).tasks as Task[];

  const tree = derive('open', 'all', { statuses: ['active'] }, new Set([parentId]));
  const t = titles(tree);
  expect(t).toContain('the blocker'); // active
  expect(t).not.toContain('the parent'); // pending — filtered out
  expect(t).not.toContain('unbound capture'); // pending — filtered out
});

test('children nest recursively: a grandchild sits at depth 2 under its expanded chain', () => {
  const tree = derive('open', 'all', {}, new Set([parentId, childBId]));
  const parent = tree.find((node) => node.task.title === 'the parent')!;
  const childB = parent.children.find((node) => node.task.title === 'child b')!;
  const grandchild = childB.children.find((node) => node.task.title === 'grandchild under b')!;
  expect(childB.depth).toBe(1);
  expect(grandchild.depth).toBe(2);

  // collapsing the middle node hides the grandchild again
  const collapsed = derive('open', 'all', {}, new Set([parentId]));
  const b = collapsed.find((node) => node.task.title === 'the parent')!.children.find((node) => node.task.title === 'child b')!;
  expect(b.children).toEqual([]);
  expect(b.childCount).toBe(1);
});

test('today/blocked views ignore tabs: fixed composites', () => {
  expect(titles(derive('today'))).toEqual(['standalone overdue']);
  expect(titles(derive('blocked'))).toEqual(['blocked behind it']);
});

test('scoping: project narrows the tree, Unbound isolates, all is global', () => {
  expect(titles(derive('open', projectId))).not.toContain('unbound capture');
  expect(titles(derive('open', 'unbound'))).toEqual(['unbound capture']);
});

test('the hidden gate is time-sensitive on the Open tab; showHidden re-includes', () => {
  // hidden task, gated out of the default Open tab
  expect(titles(derive('open'))).not.toContain('hidden task');
  const shown = derive('open', 'all', { showHidden: true });
  expect(titles(shown)).toContain('hidden task');

  // after hidden_until passes it is plain open again
  const afterHidden = buildTree(tasks, {
    view: 'open',
    scope: 'all',
    status: ALL,
    now: NOW + 25 * 3600_000,
    expanded: new Set(),
    query: '',
  });
  expect(titles(afterHidden)).toContain('hidden task');
});

test('countViews: sidebar counts, tab counts, and the store-wide Unbound chip', () => {
  const counts = countViews(tasks, 'all', NOW);
  // open composite at NOW: parent, a, b, grandchild, standalone, unbound,
  // blocker, blocked-child — the hidden task is gated out
  expect(counts.open).toBe(8);
  expect(counts.today).toBe(1); // the overdue standalone only
  expect(counts.blocked).toBe(1);
  expect(counts.done).toBe(1);
  expect(counts.dropped).toBe(1);
  expect(counts.unbound).toBe(1);
});
