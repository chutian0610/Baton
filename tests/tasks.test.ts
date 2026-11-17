import { afterAll, beforeAll, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon, type DaemonHandle } from './helpers/daemon.js';
import { MIGRATIONS } from '../src/db.js';

/**
 * Process-level tests for the Task HTTP JSON API: creation (capture-first —
 * every task starts Unbound; an explicit project assigns, cwd is never
 * consulted), the single-parent tree (nesting, children summary, reparenting,
 * ancestor-cycle rejection; trees may span projects), project as an attribute
 * (task_update {project} cascades over the subtree; moves that would split a
 * dependency are rejected with the offending pairs), field updates, and the
 * error mapping (400 invalid / 404 unknown / 409 conflict).
 * Bound paths are plain strings to the daemon — the directories need not
 * exist — so tests use fictional absolute paths.
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

async function get(id: number): Promise<Response> {
  return fetch(`${daemon.baseUrl}/tasks/${id}`);
}

async function json(response: Response): Promise<any> {
  return response.json();
}

/** Creates a project via the HTTP API and returns its view. */
async function makeProject(name: string, paths: string[]): Promise<{ id: number; name: string }> {
  const response = await fetch(`${daemon.baseUrl}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, paths }),
  });
  expect(response.status).toBe(201);
  return (await json(response)).project;
}

/** Creates a task (expecting success) and returns its view. */
async function makeTask(body: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await post(body);
  expect(response.status).toBe(201);
  return (await json(response)).task;
}

// ------------------------------------------------------------- creation

test('create with an explicit project name echoes the full field set, normalizing tags', async () => {
  const project = await makeProject('alpha', ['/workspace/alpha/main']);

  const task = await makeTask({
    title: '  Ship the release  ',
    project: 'alpha',
    tags: ['Core', 'core', ' Release ', 'release'],
    due: '2026-12-01T10:00:00Z',
    priority: 'H',
    effort: '2h',
    hidden_until: '2026-11-20T09:00:00Z',
  });

  expect(task).toMatchObject({
    id: expect.any(Number),
    title: 'Ship the release', // trimmed
    status: 'pending', // fixed at creation: new tasks always start pending
    projectId: project.id,
    projectName: 'alpha',
    parentId: null,
    tags: ['core', 'release'], // lowercased, deduplicated, sorted
    due: '2026-12-01T10:00:00Z',
    priority: 'H',
    effort: '2h',
    hiddenUntil: '2026-11-20T09:00:00Z',
  });
  expect(typeof task.createdAt).toBe('string');
  expect(typeof task.updatedAt).toBe('string');
});

test('create accepts a project id instead of a name', async () => {
  const project = await makeProject('by-id', ['/workspace/by-id']);

  const task = await makeTask({ title: 'Pick by id', project: project.id });
  expect(task.projectId).toBe(project.id);
  expect(task.projectName).toBe('by-id');
});

test('create with no project captures an Unbound task; cwd is never consulted', async () => {
  await makeProject('cwdless', ['/workspace/cwdless']); // the cwd below points INTO this project...

  const task = await makeTask({ title: 'Captured anywhere', cwd: '/workspace/cwdless/deep' });
  expect(task.projectId).toBeNull(); // ...and is still ignored: capture is unbound by default
  expect(task.projectName).toBeNull();
});

test('create with project: null also stays Unbound', async () => {
  const task = await makeTask({ title: 'Explicitly unbound', project: null });
  expect(task.projectId).toBeNull();
  expect(task.projectName).toBeNull();
});

test('unknown explicit project answers 404', async () => {
  const response = await post({ title: 'Ghost', project: 'no-such-project' });
  expect(response.status).toBe(404);
  expect(((await json(response)) as { error: string }).error).toContain('unknown project name');

  const byId = await post({ title: 'Ghost id', project: 999999 });
  expect(byId.status).toBe(404);
  expect(((await json(byId)) as { error: string }).error).toContain('unknown project id');
});

test('creating a task raises the project open-task count', async () => {
  const project = await makeProject('counted', ['/workspace/counted']);
  await makeTask({ title: 'Counted task', project: project.id });
  await makeTask({ title: 'Another counted task', project: project.id });

  const response = await fetch(`${daemon.baseUrl}/projects`);
  const body = (await json(response)) as { projects: { id: number; openTaskCount: number }[] };
  const found = body.projects.find((entry) => entry.id === project.id);
  expect(found?.openTaskCount).toBe(2);
});

// ------------------------------------------------------- nesting and reads

test('nesting: a task has one parent; task_get returns direct children ordered by id', async () => {
  const project = await makeProject('tree', ['/workspace/tree']);

  const root = await makeTask({ title: 'Root', project: 'tree' });
  const first = await makeTask({ title: 'First child', project: 'tree', parent: root.id });
  const second = await makeTask({ title: 'Second child', project: 'tree', parent: root.id });
  const grandchild = await makeTask({ title: 'Grandchild', project: 'tree', parent: first.id });

  expect(first.parentId).toBe(root.id);
  expect(grandchild.parentId).toBe(first.id);

  const detail = await json(await get(root.id));
  expect(detail.task.id).toBe(root.id);
  expect(detail.children).toEqual([
    { id: first.id, title: 'First child', status: 'pending' },
    { id: second.id, title: 'Second child', status: 'pending' },
  ]);

  // direct children only — the grandchild shows up under its own parent
  const firstDetail = await json(await get(first.id));
  expect(firstDetail.children).toEqual([{ id: grandchild.id, title: 'Grandchild', status: 'pending' }]);
});

test('an Unbound tree nests and reads like any other tree', async () => {
  const root = await makeTask({ title: 'Unbound root' });
  const child = await makeTask({ title: 'Unbound child', parent: root.id });
  const grandchild = await makeTask({ title: 'Unbound grandchild', parent: child.id });

  expect(child).toMatchObject({ parentId: root.id, projectId: null, projectName: null });
  const detail = await json(await get(root.id));
  expect(detail.children).toEqual([{ id: child.id, title: 'Unbound child', status: 'pending' }]);
  expect((await json(await get(grandchild.id))).task.parentId).toBe(child.id);
});

test('task_get with an unknown id answers 404', async () => {
  const response = await get(999999);
  expect(response.status).toBe(404);
  expect(((await json(response)) as { error: string }).error).toContain('unknown task id');
});

test('non-integer task ids answer 400', async () => {
  const response = await fetch(`${daemon.baseUrl}/tasks/not-a-number`);
  expect(response.status).toBe(400);
  expect(((await json(response)) as { error: string }).error).toContain('task id must be an integer');
});

// ------------------------------------------------------------- reparenting

test('reparent moves a task to a new parent; parent null makes it a root', async () => {
  const project = await makeProject('reparent', ['/workspace/reparent']);
  const a = await makeTask({ title: 'A', project: 'reparent' });
  const b = await makeTask({ title: 'B', project: 'reparent', parent: a.id });
  const c = await makeTask({ title: 'C', project: 'reparent' });

  const moved = await json(await patch(b.id, { parent: c.id }));
  expect(moved.task.parentId).toBe(c.id);
  expect((await json(await get(c.id))).children).toEqual([{ id: b.id, title: 'B', status: 'pending' }]);
  expect((await json(await get(a.id))).children).toEqual([]);

  const detached = await json(await patch(b.id, { parent: null }));
  expect(detached.task.parentId).toBe(null);
  expect((await json(await get(c.id))).children).toEqual([]);
});

test('multi-level ancestor-cycle reparenting answers 409 with the cycle path', async () => {
  const project = await makeProject('cycle', ['/workspace/cycle']);
  const top = await makeTask({ title: 'Top', project: 'cycle' });
  const middle = await makeTask({ title: 'Middle', project: 'cycle', parent: top.id });
  const bottom = await makeTask({ title: 'Bottom', project: 'cycle', parent: middle.id });

  // moving `top` under `bottom` would make it its own ancestor
  const response = await patch(top.id, { parent: bottom.id });
  expect(response.status).toBe(409);

  const body = (await json(response)) as { error: string };
  const expectedPath = `${top.id} -> ${bottom.id} -> ${middle.id} -> ${top.id}`;
  expect(body.error).toContain('cycle');
  expect(body.error).toContain(expectedPath);

  // the tree is unchanged
  expect((await json(await get(top.id))).task.parentId).toBe(null);
});

test('a task cannot be its own parent', async () => {
  const project = await makeProject('self', ['/workspace/self']);
  const task = await makeTask({ title: 'Self', project: 'self' });

  const response = await patch(task.id, { parent: task.id });
  expect(response.status).toBe(409);
  expect(((await json(response)) as { error: string }).error).toContain('cannot be its own parent');
});

test('parent-child across projects is legal at create and on reparent (trees may span projects)', async () => {
  await makeProject('home', ['/workspace/home']);
  const away = await makeProject('away', ['/workspace/away']);
  const homeTask = await makeTask({ title: 'Home task', project: 'home' });

  const atCreate = await makeTask({ title: 'Away child', project: 'away', parent: homeTask.id });
  expect(atCreate.parentId).toBe(homeTask.id);
  expect(atCreate.projectName).toBe('away');

  // reparenting across projects — including under an Unbound parent — is legal
  const unboundParent = await makeTask({ title: 'Unbound foster parent' });
  const onReparent = await json(await patch(atCreate.id, { parent: unboundParent.id }));
  expect(onReparent.task.parentId).toBe(unboundParent.id);
  expect(onReparent.task.projectId).toBe(away.id); // the move does not touch the project
  expect((await json(await get(unboundParent.id))).children).toEqual([
    { id: atCreate.id, title: 'Away child', status: 'pending' },
  ]);
});

test('unknown parent at create answers 404', async () => {
  await makeProject('orphan', ['/workspace/orphan']);
  const response = await post({ title: 'Orphan', project: 'orphan', parent: 999999 });
  expect(response.status).toBe(404);
  expect(((await json(response)) as { error: string }).error).toContain('unknown parent task id');
});

// ------------------------------------- project as an attribute (cascade move)

test('task_update {project} binds the whole subtree in one call; one change-log row per changed task', async () => {
  const project = await makeProject('bound', ['/workspace/bound']);
  const root = await makeTask({ title: 'Subtree root' });
  const child = await makeTask({ title: 'Subtree child', parent: root.id });
  const grandchild = await makeTask({ title: 'Subtree grandchild', parent: child.id });
  const outside = await makeTask({ title: 'Outside the subtree' });

  const moved = await json(await patch(root.id, { project: 'bound' }));
  expect(moved.task).toMatchObject({ id: root.id, projectId: project.id, projectName: 'bound' });
  for (const id of [child.id, grandchild.id]) {
    expect((await json(await get(id))).task).toMatchObject({ projectId: project.id, projectName: 'bound' });
  }
  expect((await json(await get(outside.id))).task.projectId).toBeNull(); // cascade stops at the subtree

  // provenance: one row per affected task (the projectId diff), one actor
  for (const id of [root.id, child.id, grandchild.id]) {
    const changes = (await json(await get(id))).recentChanges;
    expect(changes[0].diff).toEqual({ projectId: { before: null, after: project.id } });
    expect(changes[0].actor).toEqual({ kind: 'http' });
  }
});

test('re-binding a bound parent re-cascades over descendants created later', async () => {
  await makeProject('cascade-a', ['/workspace/cascade-a']);
  const beta = await makeProject('cascade-b', ['/workspace/cascade-b']);
  const root = await makeTask({ title: 'Cascade root', project: 'cascade-a' });
  const child = await makeTask({ title: 'Cascade child', parent: root.id }); // Unbound child under a bound parent

  const moved = await json(await patch(root.id, { project: 'cascade-b' }));
  expect(moved.task.projectId).toBe(beta.id);
  expect((await json(await get(child.id))).task.projectId).toBe(beta.id);
});

test('project: null unbinds the whole subtree', async () => {
  const project = await makeProject('unbind', ['/workspace/unbind']);
  const root = await makeTask({ title: 'Unbind root', project: 'unbind' });
  const child = await makeTask({ title: 'Unbind child', project: 'unbind', parent: root.id });

  const moved = await json(await patch(root.id, { project: null }));
  expect(moved.task).toMatchObject({ projectId: null, projectName: null });
  expect((await json(await get(child.id))).task).toMatchObject({ projectId: null, projectName: null });
  expect((await json(await get(root.id))).recentChanges[0].diff).toEqual({
    projectId: { before: project.id, after: null },
  });
});

test('same-value assignment keeps the one-row PATCH convention and leaves descendants alone', async () => {
  const project = await makeProject('same-value', ['/workspace/same-value']);
  const root = await makeTask({ title: 'Same value root', project: 'same-value' });
  const child = await makeTask({ title: 'Same value child', project: 'same-value', parent: root.id });

  const moved = await json(await patch(root.id, { project: 'same-value' }));
  expect(moved.task.projectId).toBe(project.id);
  const changes = (await json(await get(root.id))).recentChanges;
  expect(changes).toHaveLength(2); // create + the no-op PATCH row
  expect(changes[0].diff).toEqual({}); // the existing one-row PATCH convention
  expect((await json(await get(child.id))).recentChanges).toHaveLength(1); // only its create row
});

test('a move that would split a dependency across projects is rejected with the offending pairs', async () => {
  const here = await makeProject('move-a', ['/workspace/move-a']);
  await makeProject('move-b', ['/workspace/move-b']);
  // every edge is legal BEFORE the move: root->outsideDep shares move-a, and
  // outsideDependent->movedChild pairs two Unbound tasks
  const outsideDep = await makeTask({ title: 'Outside dependency', project: 'move-a' }); // moved root depends on this
  const movedRoot = await makeTask({ title: 'Moved root', project: 'move-a', deps: [outsideDep.id] });
  const movedChild = await makeTask({ title: 'Moved child', parent: movedRoot.id });
  const outsideDependent = await makeTask({ title: 'Outside dependent', deps: [movedChild.id] });

  const response = await patch(movedRoot.id, { project: 'move-b' });
  expect(response.status).toBe(409);

  const body = (await json(response)) as { error: string };
  expect(body.error).toContain('cross-project dependencies');
  expect(body.error).toContain(
    `task ${movedRoot.id} depends on task ${outsideDep.id} (still in project ${here.name})`,
  );
  expect(body.error).toContain(
    `task ${outsideDependent.id} (still unbound) depends on task ${movedChild.id}`,
  );
  expect(body.error).toContain('resolve them first');

  // rejected means rejected: full rollback, nothing moved
  expect((await json(await get(movedRoot.id))).task.projectId).toBe(here.id);
  expect((await json(await get(movedChild.id))).task.projectId).toBeNull();
  expect((await json(await get(movedRoot.id))).task.deps).toEqual([outsideDep.id]);
});

test('a legal cascade move keeps intra-subtree dependencies intact', async () => {
  await makeProject('legal-a', ['/workspace/legal-a']);
  const target = await makeProject('legal-b', ['/workspace/legal-b']);

  const root = await makeTask({ title: 'Legal moved root', project: 'legal-a' });
  const child = await makeTask({ title: 'Legal moved child', project: 'legal-a', parent: root.id });
  const grandchild = await makeTask({ title: 'Legal moved grandchild', project: 'legal-a', parent: child.id });
  await patch(child.id, { deps: [root.id] }); // edge wholly inside the moved set
  await patch(grandchild.id, { deps: [child.id, root.id] });

  const moved = await json(await patch(root.id, { project: 'legal-b' }));
  expect(moved.task.projectId).toBe(target.id);
  expect((await json(await get(child.id))).task).toMatchObject({ projectId: target.id, deps: [root.id], blocked: true });
  expect((await json(await get(grandchild.id))).task).toMatchObject({
    projectId: target.id,
    deps: [root.id, child.id], // sorted, as deps always read back
  });
});

test('project update accepts an id, rejects an unknown project with 404', async () => {
  await makeProject('by-id-move', ['/workspace/by-id-move']);
  const task = await makeTask({ title: 'Move me by id' });

  const unknown = await patch(task.id, { project: 'no-such-project' });
  expect(unknown.status).toBe(404);
  expect(((await json(unknown)) as { error: string }).error).toContain('unknown project name');

  const byId = await makeProject('by-id-target', ['/workspace/by-id-target']);
  const moved = await json(await patch(task.id, { project: byId.id }));
  expect(moved.task.projectId).toBe(byId.id);
});

test('one PATCH can bind a task and set same-project deps together', async () => {
  await makeProject('bind-and-dep', ['/workspace/bind-and-dep']);
  const anchor = await makeTask({ title: 'Bind anchor', project: 'bind-and-dep' });
  const captor = await makeTask({ title: 'Captured then bound' });

  const updated = await json(await patch(captor.id, { project: 'bind-and-dep', deps: [anchor.id] }));
  expect(updated.task).toMatchObject({ projectId: anchor.projectId, deps: [anchor.id], blocked: true });
});

// --------------------------------------------------------- field updates

test('field updates: title, tags (replaced), due, priority, effort, hidden_until; null clears', async () => {
  const project = await makeProject('fields', ['/workspace/fields']);
  const task = await makeTask({
    title: 'Before',
    project: 'fields',
    tags: ['old'],
    due: '2026-10-01T00:00:00Z',
    priority: 'L',
  });

  const updated = await json(
    await patch(task.id, {
      title: 'After',
      tags: ['Mixed', 'mixed', ' CASE '],
      due: '2027-01-15T12:00:00Z',
      priority: 'M',
      effort: '3d',
      hidden_until: '2026-12-24T00:00:00Z',
    }),
  );
  expect(updated.task).toMatchObject({
    title: 'After',
    tags: ['case', 'mixed'],
    due: '2027-01-15T12:00:00Z',
    priority: 'M',
    effort: '3d',
    hiddenUntil: '2026-12-24T00:00:00Z',
  });

  const cleared = await json(await patch(task.id, { due: null, priority: null, effort: null, hidden_until: null }));
  expect(cleared.task).toMatchObject({ due: null, priority: null, effort: null, hiddenUntil: null });
  expect(cleared.task.tags).toEqual(['case', 'mixed']); // untouched keys survive

  // tags replace wholesale, and an empty array clears them
  const retagged = await json(await patch(task.id, { tags: [] }));
  expect(retagged.task.tags).toEqual([]);
});

test('hiddenUntil (the read-side spelling) is accepted as an alias on update', async () => {
  const project = await makeProject('alias', ['/workspace/alias']);
  const task = await makeTask({ title: 'Alias', project: 'alias' });

  const updated = await json(await patch(task.id, { hiddenUntil: '2026-12-01T00:00:00Z' }));
  expect(updated.task.hiddenUntil).toBe('2026-12-01T00:00:00Z');
});

test('status cannot be set at create: new tasks start as pending', async () => {
  const project = await makeProject('status', ['/workspace/status']);

  const atCreate = await post({ title: 'Status at create', project: 'status', status: 'pending' });
  expect(atCreate.status).toBe(409);
  const message = ((await json(atCreate)) as { error: string }).error;
  expect(message).toContain('status');
  expect(message).toContain('pending');
});

test('priority must be H, M, or L', async () => {
  const project = await makeProject('priority', ['/workspace/priority']);

  const atCreate = await post({ title: 'Bad priority', project: 'priority', priority: 'high' });
  expect(atCreate.status).toBe(400);
  expect(((await json(atCreate)) as { error: string }).error).toContain('priority must be one of');

  const task = await makeTask({ title: 'Priority change', project: 'priority', priority: 'L' });
  const onUpdate = await patch(task.id, { priority: 'X' });
  expect(onUpdate.status).toBe(400);
});

test('title must be a non-empty string', async () => {
  const project = await makeProject('title', ['/workspace/title']);

  const atCreate = await post({ title: '   ', project: 'title' });
  expect(atCreate.status).toBe(400);
  expect(((await json(atCreate)) as { error: string }).error).toContain('title');

  const task = await makeTask({ title: 'Title change', project: 'title' });
  const onUpdate = await patch(task.id, { title: '' });
  expect(onUpdate.status).toBe(400);
});

test('due and hidden_until must be ISO-8601 strings; tags must be strings', async () => {
  const project = await makeProject('validation', ['/workspace/validation']);

  const badDue = await post({ title: 'Bad due', project: 'validation', due: 'whenever' });
  expect(badDue.status).toBe(400);
  expect(((await json(badDue)) as { error: string }).error).toContain('due must be an ISO-8601');

  const badHidden = await post({ title: 'Bad hidden', project: 'validation', hidden_until: 'tomorrow' });
  expect(badHidden.status).toBe(400);

  const badTags = await post({ title: 'Bad tags', project: 'validation', tags: ['ok', 7] });
  expect(badTags.status).toBe(400);
  expect(((await json(badTags)) as { error: string }).error).toContain('each tag must be a non-empty string');
});

test('updating an unknown task id answers 404', async () => {
  const response = await patch(999999, { title: 'Nope' });
  expect(response.status).toBe(404);
});

// ------------------------------------------------------- schema migration

test('the v6 -> v7 migration rebuilds a real v6 database without losing a row', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baton-migrate-'));
  try {
    // Build a genuine v6 database by applying migrations v1..v6 verbatim.
    const db = new Database(join(dataDir, 'data.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 6)) {
      db.transaction(() => {
        migration.up(db);
        db.pragma(`user_version = ${migration.version}`);
      })();
    }
    db.prepare('INSERT INTO projects (name) VALUES (?)').run('legacy');
    const legacyProjectId = db.prepare('SELECT id FROM projects').get() as { id: number };
    db.prepare('INSERT INTO tasks (title, project_id) VALUES (?, ?)').run('Legacy root', legacyProjectId.id);
    const rootId = (db.prepare('SELECT id FROM tasks WHERE title = ?').get('Legacy root') as { id: number }).id;
    db.prepare('INSERT INTO tasks (title, project_id, parent_id) VALUES (?, ?, ?)').run(
      'Legacy child',
      legacyProjectId.id,
      rootId,
    );
    const childId = (db.prepare('SELECT id FROM tasks WHERE title = ?').get('Legacy child') as { id: number }).id;
    db.prepare('INSERT INTO task_tags (task_id, tag) VALUES (?, ?)').run(childId, 'kept');
    db.prepare('INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)').run(childId, rootId);
    const seqBefore = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'tasks'").get() as { seq: number }).seq;
    db.close();

    // Opening through the daemon applies v7 on top; every row must survive.
    const migrated = await startDaemon({ dataDir });
    const migratedUrl = migrated.baseUrl;
    const readTask = async (id: number): Promise<any> => {
      const response = await fetch(`${migratedUrl}/tasks/${id}`);
      expect(response.status).toBe(200);
      return (await response.json()) as any;
    };
    try {
      const root = await readTask(rootId);
      expect(root.task).toMatchObject({
        id: rootId,
        title: 'Legacy root',
        projectId: legacyProjectId.id,
        projectName: 'legacy',
        parentId: null,
      });
      const child = await readTask(childId);
      expect(child.task).toMatchObject({
        title: 'Legacy child',
        projectId: legacyProjectId.id,
        parentId: rootId,
        tags: ['kept'],
        deps: [rootId],
      });

      // The store is fully live on v7: capture works, ids continue.
      const captureResponse = await fetch(`${migratedUrl}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Post-migration capture' }),
      });
      expect(captureResponse.status).toBe(201);
      const captured = (await captureResponse.json()).task;
      expect(captured.projectId).toBeNull();
      expect(captured.id).toBeGreaterThan(seqBefore);
    } finally {
      await migrated.stop({ keepDataDir: true });
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ plumbing

test('malformed JSON body answers 400 on POST and PATCH', async () => {
  const postResponse = await fetch(`${daemon.baseUrl}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  });
  expect(postResponse.status).toBe(400);

  const patchResponse = await fetch(`${daemon.baseUrl}/tasks/1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  });
  expect(patchResponse.status).toBe(400);
});

test('unsupported methods answer 405', async () => {
  // GET /tasks is the query model (tests/query.test.ts); DELETE on the
  // collection stays unsupported.
  const onCollection = await fetch(`${daemon.baseUrl}/tasks`, { method: 'DELETE' });
  expect(onCollection.status).toBe(405);

  const onTask = await fetch(`${daemon.baseUrl}/tasks/1`, { method: 'DELETE' });
  expect(onTask.status).toBe(405);
});
