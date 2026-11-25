import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startDaemon, type DaemonHandle } from './helpers/daemon.js';

/**
 * The end-to-end acceptance journey (spec #12 / ADR-0005), as ONE continuous
 * scenario over shared state: capture Unbound → structure inside the Unbound
 * set → bind a whole subtree → the two project constraints (deps same-project,
 * move rejection with pair lists) → the query contract (global default,
 * project filter, cwd reads) → status/interval pass → provenance → durability.
 *
 * Two modes:
 *   default          — spawns an isolated daemon on a temp data dir (CI; the
 *                      durability step restarts it in-place at the end);
 *   BATON_ACCEPTANCE_URL — targets an ALREADY RUNNING daemon instead (verify a
 *                      real install). Mutates that store: created tasks are
 *                      dropped in cleanup, the two uniquely-named projects
 *                      remain (there is no hard delete). The durability step
 *                      is skipped — this suite must not restart your daemon.
 */

const EXTERNAL_URL = process.env.BATON_ACCEPTANCE_URL;
const EXTERNAL = EXTERNAL_URL !== undefined;
const RUN = `acc-${Date.now()}`;

let daemon: DaemonHandle | undefined;
let baseUrl = EXTERNAL_URL as string;
let workDir: string;

// The journey's shared state, built up in order.
let paper: { id: number };
let section: { id: number };
let reproduce: { id: number };
let papers: { id: number };
let repo: { id: number };
let repoA: { id: number };
let repoB: { id: number };
const created: number[] = [];

beforeAll(async () => {
  if (EXTERNAL) {
    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.ok).toBe(true);
    await health.body?.cancel();
    console.log(
      `[integration] external mode against ${baseUrl} — this run MUTATES that store: ` +
        'tasks are dropped in cleanup, the acceptance-* projects remain (no hard delete).',
    );
    workDir = await mkdtemp(join(tmpdir(), 'baton-acceptance-'));
  } else {
    daemon = await startDaemon();
    baseUrl = daemon.baseUrl;
    workDir = daemon.dataDir;
  }
});

afterAll(async () => {
  // Courtesy cleanup: drop what we created so it leaves default views. The
  // acceptance-* projects cannot be deleted (no hard delete) — noted above.
  if (EXTERNAL) {
    for (const id of created) {
      await fetch(`${baseUrl}/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'dropped' }),
      });
    }
    await rm(workDir, { recursive: true, force: true });
  } else {
    await daemon?.stop();
  }
});

// ------------------------------------------------------------------ helpers

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, body: json };
}

async function createTask(payload: Record<string, unknown>): Promise<{ id: number }> {
  const { status, body } = await call('POST', '/tasks', payload);
  expect(status).toBe(201);
  created.push(body.task.id);
  return body.task;
}

// ------------------------------------------------------------------- 1) capture

test('capture: tasks are born Unbound — no cwd consulted, no project error, structure legal', async () => {
  // capture with zero project context: the v1 unbound error no longer exists
  paper = await createTask({ title: `${RUN} read the complete-induction paper` });
  expect(paper.projectName).toBeNull();
  expect(paper.projectId).toBeNull();
  expect(paper.status).toBe('pending');

  // structure inside the Unbound set: nesting
  section = await createTask({ title: `${RUN} study section 3`, parent: paper.id });
  reproduce = await createTask({
    title: `${RUN} run the reproduction`,
    parent: paper.id,
    deps: [section.id],
  });
  expect(reproduce.parentId).toBe(paper.id);
  expect(reproduce.deps).toEqual([section.id]);
  expect(reproduce.blocked).toBe(true); // derived: section is open
  expect(reproduce.progress).toBeNull(); // leaf: no progress value

  const detail = await (await call('GET', `/tasks/${paper.id}`)).body;
  expect(detail.children.map((c: any) => c.id).sort()).toEqual(
    [section.id, reproduce.id].sort(),
  );
  expect(detail.task.projectName).toBeNull();
});

// ------------------------------------------------------- 2) projects + cascade

test('bind: one PATCH assigns the whole subtree; the log records every affected Task', async () => {
  const created1 = await call('POST', '/projects', {
    name: `${RUN}-papers`,
    paths: [join(workDir, 'papers')],
  });
  expect(created1.status).toBe(201);
  papers = created1.body.project;

  const { status, body } = await call('PATCH', `/tasks/${paper.id}`, { project: papers.name });
  expect(status).toBe(200);
  expect(body.task.projectName).toBe(`${RUN}-papers`);

  // default cascade: every descendant flipped with the root
  for (const id of [section.id, reproduce.id]) {
    const { body: child } = await call('GET', `/tasks/${id}`);
    expect(child.task.projectName).toBe(`${RUN}-papers`);
    expect(child.task.projectId).toBe(papers.id);
  }

  // provenance: one change-log row per affected Task (3), single actor
  const changes = await (await call('GET', `/tasks/${paper.id}/changes`)).body;
  expect(changes.total).toBe(2); // create row + the binding row
  expect(changes.changes[0].diff.projectId).toEqual({ before: null, after: papers.id });
  expect(changes.changes[0].actor).toEqual({ kind: 'http' });
  expect(changes.changes[1].diff.title.after).toContain(RUN); // the create row

  const childChanges = await (await call('GET', `/tasks/${section.id}/changes`)).body;
  expect(childChanges.total).toBe(2);
  expect(childChanges.changes[0].diff.projectId).toEqual({ before: null, after: papers.id });

  // same-value assignment is accepted (single-row convention)
  const again = await call('PATCH', `/tasks/${paper.id}`, { project: papers.name });
  expect(again.status).toBe(200);
});

// ------------------------------------------------------------- 3) constraints

test('constraints: deps stay same-project; a splitting move is rejected with pairs and rolls back', async () => {
  const created2 = await call('POST', '/projects', {
    name: `${RUN}-repo`,
    paths: [join(workDir, 'repo')],
  });
  expect(created2.status).toBe(201);
  repo = created2.body.project;

  repoA = await createTask({ title: `${RUN} repo task A`, project: repo.name });
  repoB = await createTask({
    title: `${RUN} repo task B`,
    project: repo.name,
    deps: [repoA.id],
  });

  // projected ↔ projected across projects: illegal
  const across = await call('PATCH', `/tasks/${repoA.id}`, { deps: [reproduce.id] });
  expect(across.status).toBe(409);

  // projected ↔ Unbound: illegal in both directions
  const toUnbound = await call('PATCH', `/tasks/${repoA.id}`, { deps: [paper.id] });
  expect(toUnbound.status).toBe(409);
  const fromUnbound = await call('PATCH', `/tasks/${section.id}`, { deps: [repoA.id] });
  expect(fromUnbound.status).toBe(409);

  // move rejection: repo A depends on nothing, but repo B depends on repo A —
  // moving A to papers would split that dependency; expect pairs + rollback
  const move = await call('PATCH', `/tasks/${repoA.id}`, { project: papers.name });
  expect(move.status).toBe(409);
  expect(move.body.error).toContain(`${RUN}-repo`); // names the still-bound side
  expect(move.body.error).toContain(`task ${repoB.id}`); // names the dependent

  const afterMove = await call('GET', `/tasks/${repoA.id}`);
  expect(afterMove.body.task.projectName).toBe(`${RUN}-repo`); // rolled back

  // resolve the dependency, then the same move succeeds
  await call('PATCH', `/tasks/${repoB.id}`, { deps: [] });
  const moved = await call('PATCH', `/tasks/${repoA.id}`, { project: papers.name });
  expect(moved.status).toBe(200);
  expect(moved.body.task.projectName).toBe(`${RUN}-papers`);

  // trees span projects by design: a papers task under a repo parent is legal
  const crossTree = await createTask({ title: `${RUN} cross-project child`, parent: repoB.id });
  const bound = await call('PATCH', `/tasks/${crossTree.id}`, { project: papers.name });
  expect(bound.status).toBe(200);

  // cycles are still rejected (unchanged invariant)
  const selfCycle = await call('PATCH', `/tasks/${paper.id}`, { parent: paper.id });
  expect(selfCycle.status).toBe(409);
});

// ------------------------------------------------------------------- 4) query

test('query: default is global open work; cwd serves reads only; no Inbox surface exists', async () => {
  // default listing: Unbound and bound tasks side by side, done/dropped excluded
  const doneTask = await createTask({ title: `${RUN} will be done` });
  await call('POST', `/tasks/${doneTask.id}/done`);
  const dropped = await createTask({ title: `${RUN} will be dropped` });
  const hidden = await createTask({
    title: `${RUN} hidden until later`,
    hidden_until: '2099-01-01T00:00:00Z',
  });

  const def = await (await call('GET', '/tasks')).body;
  expect(def.note).toBeUndefined(); // global default needs no note
  const ids = def.tasks.map((t: any) => t.id);
  expect(ids).toContain(paper.id);
  expect(ids).toContain(repoB.id); // Unbound side by side with bound work
  expect(ids).not.toContain(doneTask.id);
  expect(ids).not.toContain(hidden.id); // future hidden_until excluded

  // a cwd on the default query is IGNORED (create and listing are cwd-free)
  const withCwd = await (await call('GET', `/tasks?cwd=${encodeURIComponent(workDir)}`)).body;
  expect(withCwd.note).toBeUndefined();
  expect(withCwd.tasks.map((t: any) => t.id)).toContain(paper.id);

  // project filter by name and by id
  const byName = await (await call('GET', `/tasks?filter=${encodeURIComponent(`{"project":"${RUN}-papers"}`)}`)).body;
  for (const t of byName.tasks) expect(t.projectName).toBe(`${RUN}-papers`);
  const byId = await (await call('GET', `/tasks?filter=${encodeURIComponent(`{"project":${papers.id}}`)}`)).body;
  expect(byId.tasks.map((t: any) => t.id)).toEqual(byName.tasks.map((t: any) => t.id));

  // view=current: the one read that consults cwd
  const current = await (await call('GET', `/tasks?view=current&cwd=${encodeURIComponent(join(workDir, 'papers'))}`)).body;
  expect(current.note).toBeUndefined();
  for (const t of current.tasks) expect(t.projectName).toBe(`${RUN}-papers`);
  const fallback = await (await call('GET', `/tasks?view=current&cwd=${encodeURIComponent(join(workDir, 'nowhere'))}`)).body;
  expect(fallback.note).toContain('whole store');

  // project_current still resolves
  const resolved = await (await call('GET', `/projects/current?cwd=${encodeURIComponent(join(workDir, 'papers'))}`)).body;
  expect(resolved.project.name).toBe(`${RUN}-papers`);

  // view=all includes the closed work; there is no Inbox surface
  const all = await (await call('GET', '/tasks?view=all')).body;
  expect(all.tasks.map((t: any) => t.id)).toContain(doneTask.id);
  const inbox = await call('GET', '/tasks?view=inbox');
  expect(inbox.status).toBe(400);
  expect(inbox.body.error).toContain('view must be one of');
  const hasProject = await call('GET', `/tasks?filter=${encodeURIComponent('{"hasProject":true}')}`);
  expect(hasProject.status).toBe(400);

  // explicit status overrides the default exclusions (hidden task surfaces)
  const pendingOnly = await (await call('GET', `/tasks?filter=${encodeURIComponent('{"status":"pending"}')}`)).body;
  expect(pendingOnly.tasks.map((t: any) => t.id)).toContain(hidden.id);

  // project_list: open counts per project, Unbound counted nowhere
  const projects = await (await call('GET', '/projects')).body;
  const byName2 = new Map(projects.projects.map((p: any) => [p.name, p]));
  expect(byName2.get(`${RUN}-papers`).openTaskCount).toBeGreaterThanOrEqual(3);
});

// ------------------------------------------------- 5) status machine + intervals

test('lifecycle: verbs drive the machine; intervals open and close; blocked and progress derive', async () => {
  const started = await call('POST', `/tasks/${reproduce.id}/start`);
  expect(started.status).toBe(200);
  expect(started.body.task.status).toBe('active');
  const active = await (await call('GET', `/tasks/${reproduce.id}`)).body;
  expect(active.intervals).toHaveLength(1); // detail-level, beside `task`
  expect(active.totalActiveMs).toBeGreaterThanOrEqual(0);

  // blocked flips when the dependency closes; the parent's progress derives
  const before = await (await call('GET', `/tasks/${section.id}`)).body;
  expect(before.task.status).toBe('pending');
  const done = await call('POST', `/tasks/${section.id}/done`);
  expect(done.status).toBe(200);
  const neverActive = await (await call('GET', `/tasks/${section.id}`)).body;
  expect(neverActive.intervals).toHaveLength(0); // never active: no Interval
  const after = await (await call('GET', `/tasks/${reproduce.id}`)).body;
  expect(after.task.blocked).toBe(false); // the dep is done
  const parent = await (await call('GET', `/tasks/${paper.id}`)).body;
  expect(parent.task.progress).toBeCloseTo(1 / 2); // 1 of 2 open-scope descendants done

  const finished = await call('POST', `/tasks/${reproduce.id}/done`);
  expect(finished.status).toBe(200);
  const closed = await (await call('GET', `/tasks/${reproduce.id}`)).body;
  expect(closed.intervals).toHaveLength(1);
  expect(closed.intervals[0].endedAt).not.toBeNull(); // done auto-closes
  expect(closed.totalActiveMs).toBeGreaterThan(0);
});

// ------------------------------------------------------------------ durability

const restartsOnly = EXTERNAL ? test.skip : test;

restartsOnly('durability: SIGTERM restart on the same data dir preserves the whole journey', async () => {
  const before = await (await call('GET', `/tasks/${paper.id}`)).body;
  await daemon!.stop({ keepDataDir: true });
  daemon = await startDaemon({ dataDir: daemon!.dataDir });
  baseUrl = daemon.baseUrl; // fresh random port, same store

  const after = await (await call('GET', `/tasks/${paper.id}`)).body;
  expect(after.task.projectName).toBe(`${RUN}-papers`);
  expect(after.children.map((c: any) => c.id).sort()).toEqual(
    before.children.map((c: any) => c.id).sort(),
  );
  const sectionAfter = await (await call('GET', `/tasks/${section.id}`)).body;
  expect(sectionAfter.task.status).toBe('done');
  expect(sectionAfter.task.projectName).toBe(`${RUN}-papers`);
  const reproduceAfter = await (await call('GET', `/tasks/${reproduce.id}`)).body;
  expect(reproduceAfter.task.status).toBe('done');
  expect(reproduceAfter.intervals).toHaveLength(1); // history intact
});
