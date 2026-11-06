import { afterAll, beforeAll, expect, test } from 'vitest';
import { startDaemon, type DaemonHandle } from './helpers/daemon.js';

/**
 * Process-level tests for the Task HTTP JSON API: creation (project
 * assignment via explicit project or cwd), the single-parent tree (nesting,
 * children summary, reparenting, cycle rejection), field updates, and the
 * error mapping (400 invalid / 404 unknown|unbound / 409 conflict).
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
    status: 'pending', // fixed in this ticket
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

test('create resolves the project from cwd via longest-prefix match', async () => {
  await makeProject('outer', ['/workspace/nest']);
  await makeProject('inner', ['/workspace/nest/inner']);

  const deep = await makeTask({ title: 'Deep work', cwd: '/workspace/nest/inner/sub' });
  expect(deep.projectName).toBe('inner');

  const shallow = await makeTask({ title: 'Shallow work', cwd: '/workspace/nest/other' });
  expect(shallow.projectName).toBe('outer');
});

test('explicit project wins over cwd when both are given', async () => {
  await makeProject('explicit-wins', ['/workspace/explicit']);

  const task = await makeTask({ title: 'Explicit', project: 'explicit-wins', cwd: '/workspace/nest/inner' });
  expect(task.projectName).toBe('explicit-wins');
});

test('create with neither project nor cwd answers 404 naming the fix', async () => {
  const response = await post({ title: 'Nowhere to go' });
  expect(response.status).toBe(404);

  const body = await json(response);
  expect(body.error).toContain('project');
  expect(body.error).toContain('project_create');
});

test('create with an unbound cwd answers 404 with the resolver message', async () => {
  const response = await post({ title: 'Unbound', cwd: '/unbound/dir' });
  expect(response.status).toBe(404);

  const body = await json(response);
  expect(body.error).toContain('/unbound/dir');
  expect(body.error).toContain('project_create');
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

test('cross-project parents are rejected at create and on reparent', async () => {
  const home = await makeProject('home', ['/workspace/home']);
  const away = await makeProject('away', ['/workspace/away']);
  const homeTask = await makeTask({ title: 'Home task', project: 'home' });

  const atCreate = await post({ title: 'Away task', project: 'away', parent: homeTask.id });
  expect(atCreate.status).toBe(409);
  expect(((await json(atCreate)) as { error: string }).error).toContain('one project');

  const awayTask = await makeTask({ title: 'Away task', project: 'away' });
  const onReparent = await patch(awayTask.id, { parent: homeTask.id });
  expect(onReparent.status).toBe(409);
  expect(((await json(onReparent)) as { error: string }).error).toContain('one project');
});

test('unknown parent at create answers 404', async () => {
  await makeProject('orphan', ['/workspace/orphan']);
  const response = await post({ title: 'Orphan', project: 'orphan', parent: 999999 });
  expect(response.status).toBe(404);
  expect(((await json(response)) as { error: string }).error).toContain('unknown parent task id');
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

test('status changes are rejected as not yet supported (create and update)', async () => {
  const project = await makeProject('status', ['/workspace/status']);

  const atCreate = await post({ title: 'Status at create', project: 'status', status: 'pending' });
  expect(atCreate.status).toBe(409);
  expect(((await json(atCreate)) as { error: string }).error).toContain('not');

  const task = await makeTask({ title: 'Status update', project: 'status' });
  const onUpdate = await patch(task.id, { status: 'active' });
  expect(onUpdate.status).toBe(409);
  expect(((await json(onUpdate)) as { error: string }).error).toContain('not yet supported');
});

test('project moves are rejected', async () => {
  const project = await makeProject('movable', ['/workspace/movable']);
  await makeProject('elsewhere', ['/workspace/elsewhere']);
  const task = await makeTask({ title: 'Movable', project: 'movable' });

  const response = await patch(task.id, { project: 'elsewhere' });
  expect(response.status).toBe(409);
  expect(((await json(response)) as { error: string }).error).toContain('not supported');
});

test('deps are rejected as unsupported on create and update', async () => {
  const project = await makeProject('deps', ['/workspace/deps']);

  const atCreate = await post({ title: 'Deps at create', project: 'deps', deps: [42] });
  expect(atCreate.status).toBe(409);
  expect(((await json(atCreate)) as { error: string }).error).toContain('dependencies');

  const task = await makeTask({ title: 'Deps update', project: 'deps' });
  const onUpdate = await patch(task.id, { deps: [task.id + 1] });
  expect(onUpdate.status).toBe(409);
  expect(((await json(onUpdate)) as { error: string }).error).toContain('dependencies');
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
  const onCollection = await fetch(`${daemon.baseUrl}/tasks`);
  expect(onCollection.status).toBe(405);

  const onTask = await fetch(`${daemon.baseUrl}/tasks/1`, { method: 'DELETE' });
  expect(onTask.status).toBe(405);
});
