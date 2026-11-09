import { afterAll, beforeAll, expect, test } from 'vitest';
import { startDaemon, type DaemonHandle } from './helpers/daemon.js';

/**
 * Process-level tests for the Projects HTTP JSON API (create, list,
 * Current Project resolution). Bound paths are plain strings to the daemon —
 * the directories need not exist — so tests use fictional absolute paths.
 */
let daemon: DaemonHandle;

beforeAll(async () => {
  daemon = await startDaemon();
});

afterAll(async () => {
  await daemon.stop();
});

async function postProject(body: unknown): Promise<Response> {
  return fetch(`${daemon.baseUrl}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function resolveCwd(cwd: string): Promise<Response> {
  return fetch(`${daemon.baseUrl}/projects/current?cwd=${encodeURIComponent(cwd)}`);
}

test('GET /projects starts empty', async () => {
  const response = await fetch(`${daemon.baseUrl}/projects`);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ projects: [] });
});

test('POST /projects creates a project with multiple bound paths, canonicalized', async () => {
  const response = await postProject({
    name: 'alpha',
    paths: ['/workspace/alpha/main', '/workspace/alpha/worktree/'],
  });

  expect(response.status).toBe(201);
  const body = (await response.json()) as { project: Record<string, unknown> };
  expect(body.project).toMatchObject({
    id: expect.any(Number),
    name: 'alpha',
    paths: ['/workspace/alpha/main', '/workspace/alpha/worktree'], // trailing slash stripped
    openTaskCount: 0,
  });
  expect(typeof body.project.createdAt).toBe('string');
});

test('GET /projects lists created projects with paths and open-task counts', async () => {
  await postProject({ name: 'beta', paths: ['/workspace/beta'] });

  const response = await fetch(`${daemon.baseUrl}/projects`);
  expect(response.status).toBe(200);

  const body = (await response.json()) as { projects: { name: string; openTaskCount: number; paths: string[] }[] };
  const names = body.projects.map((project) => project.name);
  expect(names).toContain('alpha');
  expect(names).toContain('beta');
  for (const project of body.projects) {
    expect(project.openTaskCount).toBe(0);
    expect(Array.isArray(project.paths)).toBe(true);
  }
});

test('longest-prefix resolution: nested checkout hits the most specific project', async () => {
  await postProject({ name: 'outer', paths: ['/workspace/nest'] });
  await postProject({ name: 'inner', paths: ['/workspace/nest/inner'] });

  const deep = await resolveCwd('/workspace/nest/inner/sub/dir');
  expect(deep.status).toBe(200);
  const deepBody = (await deep.json()) as { project: { name: string }; matchedPath: string };
  expect(deepBody.project.name).toBe('inner');
  expect(deepBody.matchedPath).toBe('/workspace/nest/inner');

  const shallow = await resolveCwd('/workspace/nest/sibling');
  expect(shallow.status).toBe(200);
  expect(((await shallow.json()) as { project: { name: string } }).project.name).toBe('outer');

  const exact = await resolveCwd('/workspace/nest');
  expect(exact.status).toBe(200);
  expect(((await exact.json()) as { project: { name: string } }).project.name).toBe('outer');
});

test('prefix matching respects segment boundaries: /workspace/aaab does not match /workspace/aaa', async () => {
  await postProject({ name: 'boundary', paths: ['/workspace/aaa'] });

  const response = await resolveCwd('/workspace/aaab/child');
  expect(response.status).toBe(404);
  const body = (await response.json()) as { error: string };
  expect(body.error).toContain('/workspace/aaab/child');
});

test('a project bound to two paths resolves as Current Project from both', async () => {
  await postProject({ name: 'dual', paths: ['/workspace/dual/main', '/workspace/dual/checkout'] });

  for (const cwd of ['/workspace/dual/main/src', '/workspace/dual/checkout/pkg']) {
    const response = await resolveCwd(cwd);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { project: { name: string }; matchedPath: string };
    expect(body.project.name).toBe('dual');
    expect(cwd.startsWith(body.matchedPath)).toBe(true);
  }
});

test('cwd with a trailing slash resolves identically', async () => {
  const response = await resolveCwd('/workspace/beta/sub/');
  expect(response.status).toBe(200);
  expect(((await response.json()) as { project: { name: string } }).project.name).toBe('beta');
});

test('unbound cwd answers 404 with an error naming the fix', async () => {
  const response = await resolveCwd('/nowhere/at/all');
  expect(response.status).toBe(404);

  const body = (await response.json()) as { error: string };
  expect(body.error).toContain('/nowhere/at/all');
  expect(body.error).toContain('project_create'); // the fix is named
});

test('missing cwd answers 400 with a clear message', async () => {
  const response = await fetch(`${daemon.baseUrl}/projects/current`);
  expect(response.status).toBe(400);

  const body = (await response.json()) as { error: string };
  expect(body.error).toContain('cwd');
});

test('duplicate project name answers 409 with a clear message', async () => {
  await postProject({ name: 'dupe', paths: ['/workspace/dupe'] });

  const response = await postProject({ name: 'dupe', paths: ['/workspace/dupe/other'] });
  expect(response.status).toBe(409);

  const body = (await response.json()) as { error: string };
  expect(body.error).toContain('project name already exists: dupe');
});

test('path already bound to another project answers 409 naming the owner', async () => {
  await postProject({ name: 'owner', paths: ['/workspace/owned'] });

  const response = await postProject({ name: 'squatter', paths: ['/somewhere/else', '/workspace/owned/'] });
  expect(response.status).toBe(409);

  const body = (await response.json()) as { error: string };
  expect(body.error).toContain('path already bound to project owner: /workspace/owned');
});

test('duplicate path within one request answers 409', async () => {
  const response = await postProject({ name: 'echo', paths: ['/workspace/echo', '/workspace/echo/'] });
  expect(response.status).toBe(409);

  const body = (await response.json()) as { error: string };
  expect(body.error).toContain('duplicate path in request: /workspace/echo');
});

test('invalid input answers 400: empty name, empty paths, relative path', async () => {
  const emptyName = await postProject({ name: '   ', paths: ['/workspace/x'] });
  expect(emptyName.status).toBe(400);

  const noPaths = await postProject({ name: 'pathless', paths: [] });
  expect(noPaths.status).toBe(400);

  const relative = await postProject({ name: 'relative', paths: ['workspace/relative'] });
  expect(relative.status).toBe(400);

  const body = (await relative.json()) as { error: string };
  expect(body.error).toContain('absolute');
});

test('malformed JSON body answers 400', async () => {
  const response = await fetch(`${daemon.baseUrl}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  });
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: string }).error).toContain('invalid JSON body');
});

test('wrong method on /projects answers 405', async () => {
  const response = await fetch(`${daemon.baseUrl}/projects`, { method: 'DELETE' });
  expect(response.status).toBe(405);
});
