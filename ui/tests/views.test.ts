import { afterAll, beforeAll, expect, test } from 'vitest';
import { startDaemon, type DaemonHandle } from '../../tests/helpers/daemon.js';
import { buildTree, countViews, type Scope, type ViewName, type Visibility } from '../src/views.js';
import type { Task } from '../src/types.js';

/**
 * Client-side tree derivation, asserted against a REAL daemon (v0.3
 * redesign): the daemon is seeded through the HTTP API, the view=all payload
 * feeds buildTree, and the derivation must reproduce the server's view
 * semantics (src/query.ts is the reference) plus the redesigned tree rules —
 * an expanded parent brings all its included children regardless of their
 * own view match, collapsed parents hide them (childCount still counts),
 * and every level orders by the server default.
 */

const NOW = new Date(2026, 10, 25, 12, 0, 0).getTime(); // 2026-11-25 12:00 local

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

const NO_TOGGLES: Visibility = { showHidden: false, showDone: false, showDropped: false };

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
  // children carry no due dates: they never match Today themselves — an
  // expanded parent must surface them anyway
  const childA = await seed('child a', { parent: parent.id });
  const childB = await seed('child b', { parent: parent.id, priority: 'H' });
  childBId = childB.id;
  const doneChild = await seed('done child', { parent: parent.id });
  await patch(doneChild.id, { status: 'done' });
  await seed('grandchild under b', { parent: childB.id }); // depth-2 node

  const hidden = await seed('hidden task', { hiddenUntil: iso(NOW + 24 * 3600_000) });
  await patch(hidden.id, { hiddenUntil: iso(NOW + 24 * 3600_000) });
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

function derive(view: ViewName, scope: Scope = 'all', visibility: Visibility = NO_TOGGLES, expanded: Set<number> = new Set()) {
  return buildTree(tasks, { view, scope, visibility, now: NOW, expanded, query: '' });
}

function titles(nodes: ReturnType<typeof derive>): string[] {
  return nodes.map((node) => node.task.title);
}

test('open view, collapsed: top-level members only, childCount still counts, default order', () => {
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

test('an expanded parent brings all its OPEN children regardless of their own view match', () => {
  const tree = derive('open', 'all', NO_TOGGLES, new Set([parentId]));
  const parent = tree.find((node) => node.task.title === 'the parent')!;
  const kids = parent.children.map((node) => node.task.title);
  // the children have no due dates — they match no view, but the expanded
  // parent surfaces its included (open) set anyway. The grandchild stays
  // hidden: child b is not expanded in this call (depth-2 test below).
  expect(kids).toEqual(['child b', 'child a']);
  expect(parent.children.map((node) => node.depth)).toEqual([1, 1]);

  // the done child stays out unless the toggle asks for it
  expect(kids).not.toContain('done child');
  const withDone = derive('open', 'all', { ...NO_TOGGLES, showDone: true }, new Set([parentId]));
  expect(
    withDone
      .find((node) => node.task.title === 'the parent')!
      .children.map((node) => node.task.title),
  ).toContain('done child');
});

test('children nest recursively: a grandchild sits at depth 2 under its expanded chain', () => {
  const tree = derive('open', 'all', NO_TOGGLES, new Set([parentId, childBId]));
  const parent = tree.find((node) => node.task.title === 'the parent')!;
  const childB = parent.children.find((node) => node.task.title === 'child b')!;
  const grandchild = childB.children.find((node) => node.task.title === 'grandchild under b')!;
  expect(childB.depth).toBe(1);
  expect(grandchild.depth).toBe(2);

  // collapsing the middle node hides the grandchild again
  const collapsed = derive('open', 'all', NO_TOGGLES, new Set([parentId]));
  const b = collapsed.find((node) => node.task.title === 'the parent')!.children.find((node) => node.task.title === 'child b')!;
  expect(b.children).toEqual([]);
  expect(b.childCount).toBe(1);
});

test('today view: a view-matching child whose parent is out of view surfaces top-level', async () => {
  // the parent (future due) does not match Today — the overdue child would be
  // swallowed by a naive tree; the surface-at-highest-rendered-level rule
  // puts it top level instead
  const child = tasks.find((task) => task.title === 'child a')!;
  await patch(child.id, { due: iso(NOW - 3600_000) });
  tasks = (await (await fetch(`${daemon.baseUrl}/tasks?view=all`)).json()).tasks as Task[];

  const titlesNow = titles(
    buildTree(tasks, { view: 'today', scope: 'all', visibility: NO_TOGGLES, now: NOW, expanded: new Set([parentId]), query: '' }),
  );
  expect(titlesNow).toContain('standalone overdue');
  expect(titlesNow).toContain('child a');
  // the future-due parent still does not match
  expect(titlesNow).not.toContain('the parent');

  // restore: strip the child's due again
  await patch(child.id, { due: null });
  tasks = (await (await fetch(`${daemon.baseUrl}/tasks?view=all`)).json()).tasks as Task[];
  const after = buildTree(tasks, { view: 'today', scope: 'all', visibility: NO_TOGGLES, now: NOW, expanded: new Set([parentId]), query: '' });
  expect(titles(after)).toEqual(['standalone overdue']);
});

test('blocked view: only the derived-blocked task', () => {
  expect(titles(derive('blocked'))).toEqual(['blocked behind it']);
});

test('scoping: project narrows the tree, Unbound isolates, all is global', () => {
  expect(titles(derive('open', projectId))).not.toContain('unbound capture');
  expect(titles(derive('open', 'unbound'))).toEqual(['unbound capture']);
});

test('the hidden gate is time-sensitive: included while hidden, open after it passes', () => {
  // hidden task, collapsed in the default view
  expect(titles(derive('open'))).not.toContain('hidden task');
  const shown = derive('open', 'all', { ...NO_TOGGLES, showHidden: true });
  expect(titles(shown)).toContain('hidden task');

  // after hidden_until passes it is plain open again
  const afterHidden = buildTree(tasks, {
    view: 'open',
    scope: 'all',
    visibility: NO_TOGGLES,
    now: NOW + 25 * 3600_000,
    expanded: new Set(),
    query: '',
  });
  expect(titles(afterHidden)).toContain('hidden task');
});

test('countViews: sidebar counts for the current scope plus the store-wide Unbound chip', () => {
  const counts = countViews(tasks, 'all', NOW);
  // open at NOW: parent, a, b, grandchild, standalone, unbound, blocker,
  // blocked-child — the hidden task does not count while its hide is in force
  expect(counts.open).toBe(8);
  expect(counts.today).toBe(1); // the overdue standalone only
  expect(counts.blocked).toBe(1);
  expect(counts.unbound).toBe(1);
});
