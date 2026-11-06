import { afterAll, beforeAll, expect, test } from 'vitest';
import { startDaemon, type DaemonHandle } from './helpers/daemon.js';

/**
 * Process-level tests for the Status machine and Intervals (HTTP surface):
 * the full 5x5 legal/illegal transition matrix via PATCH {status}, Interval
 * auto open/close across waiting/done/drop, reopen preserving history, and
 * the verb endpoints (POST /tasks/:id/start|done) agreeing with PATCH.
 */
let daemon: DaemonHandle;

beforeAll(async () => {
  daemon = await startDaemon();
});

afterAll(async () => {
  await daemon.stop();
});

// ---------------------------------------------------------------- helpers

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function patch(id: number, body: unknown): Promise<Response> {
  return fetch(`${daemon.baseUrl}/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postStatus(id: number, verb: 'start' | 'done'): Promise<Response> {
  return fetch(`${daemon.baseUrl}/tasks/${id}/${verb}`, { method: 'POST' });
}

async function get(id: number): Promise<any> {
  const response = await fetch(`${daemon.baseUrl}/tasks/${id}`);
  expect(response.status).toBe(200);
  return response.json();
}

async function makeTask(title: string): Promise<{ id: number }> {
  const response = await fetch(`${daemon.baseUrl}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, project: 'lifecycle' }),
  });
  expect(response.status).toBe(201);
  return (await response.json()).task;
}

let lifecycleProjectReady: Promise<void> | undefined;
function ensureProject(): Promise<void> {
  lifecycleProjectReady ??= (async () => {
    const response = await fetch(`${daemon.baseUrl}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'lifecycle', paths: ['/workspace/lifecycle'] }),
    });
    expect(response.status).toBe(201);
  })();
  return lifecycleProjectReady;
}

const STATUSES = ['pending', 'active', 'waiting', 'done', 'dropped'] as const;
type Status = (typeof STATUSES)[number];

/** Legal targets per the spec's transition table; everything else is illegal. */
const LEGAL: Record<Status, Status[]> = {
  pending: ['active', 'waiting', 'done', 'dropped'],
  active: ['waiting', 'done', 'dropped'],
  waiting: ['active', 'done', 'dropped'],
  done: ['pending'],
  dropped: ['pending'],
};

/** Creates a fresh task and drives it to `status` through legal moves. */
async function taskInStatus(status: Status): Promise<number> {
  await ensureProject();
  const task = await makeTask(`Matrix ${status}`);
  if (status !== 'pending') {
    const response = await patch(task.id, { status });
    expect(response.status).toBe(200);
  }
  return task.id;
}

// ------------------------------------------------------ the 5x5 matrix

const matrix = STATUSES.flatMap((from) =>
  STATUSES.map((to) => ({ from, to, outcome: LEGAL[from].includes(to) ? 'legal' : 'rejected' })),
);

test.each(matrix)('$from -> $to via PATCH is $outcome', async ({ from, to, outcome }) => {
  const id = await taskInStatus(from);
  const response = await patch(id, { status: to });

  if (outcome === 'legal') {
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.task.status).toBe(to);
    expect(body.task.id).toBe(id);
    return;
  }

  expect(response.status).toBe(409);
  const body = await response.json();
  if (from === to) {
    // same-status: rejected as a no-op, naming the status
    expect(body.error).toContain(`already ${from}`);
  } else {
    // illegal move: names the current status, the target, and the legal targets
    expect(body.error).toContain(from);
    expect(body.error).toContain(to);
    expect(body.error).toContain('legal targets');
    expect(body.error).toContain(LEGAL[from].join(', '));
  }
  // and the stored status is untouched
  expect((await get(id)).task.status).toBe(from);
});

test('a status value outside the five statuses answers 400', async () => {
  const id = await taskInStatus('pending');
  const response = await patch(id, { status: 'paused' });
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: string }).error).toContain(
    'status must be one of "pending", "active", "waiting", "done", "dropped"',
  );
  expect((await get(id)).task.status).toBe('pending');
});

// ------------------------------------------------------------- intervals

test('intervals: entering active opens one; waiting closes it; done closes it; reopen preserves history', async () => {
  await ensureProject();
  const id = (await makeTask('Interval lifecycle')).id;

  // never active: no intervals, no active time
  const initial = await get(id);
  expect(initial.intervals).toEqual([]);
  expect(initial.totalActiveMs).toBe(0);

  // pending -> active opens an Interval
  await patch(id, { status: 'active' });
  const active = await get(id);
  expect(active.intervals).toHaveLength(1);
  expect(active.intervals[0]).toMatchObject({ id: expect.any(Number), endedAt: null });
  expect(typeof active.intervals[0].startedAt).toBe('string');
  expect(active.totalActiveMs).toBeGreaterThanOrEqual(0);

  // active -> waiting closes it
  await sleep(30);
  await patch(id, { status: 'waiting' });
  const waiting = await get(id);
  expect(waiting.intervals).toHaveLength(1);
  expect(waiting.intervals[0].endedAt).not.toBeNull();
  expect(waiting.totalActiveMs).toBeGreaterThanOrEqual(25);

  // waiting -> active opens a second Interval; done closes it
  await patch(id, { status: 'active' });
  await sleep(30);
  await patch(id, { status: 'done' });
  const done = await get(id);
  expect(done.intervals).toHaveLength(2);
  expect(done.intervals.map((interval: { endedAt: string | null }) => interval.endedAt)).toEqual([
    expect.any(String),
    expect.any(String),
  ]);
  expect(done.totalActiveMs).toBeGreaterThanOrEqual(50);

  // reopen leaves the recorded history intact and unchanged
  await patch(id, { status: 'pending' });
  const reopened = await get(id);
  expect(reopened.task.status).toBe('pending');
  expect(reopened.intervals).toHaveLength(2);
  expect(reopened.totalActiveMs).toBe(done.totalActiveMs);

  // a new run after reopen adds a third (open) Interval
  await patch(id, { status: 'active' });
  const again = await get(id);
  expect(again.intervals).toHaveLength(3);
  expect(again.intervals[2].endedAt).toBeNull();
  expect(again.totalActiveMs).toBeGreaterThanOrEqual(reopened.totalActiveMs);
});

test('done straight from pending records no intervals', async () => {
  await ensureProject();
  const id = (await makeTask('Never active')).id;
  await patch(id, { status: 'done' });

  const detail = await get(id);
  expect(detail.task.status).toBe('done');
  expect(detail.intervals).toEqual([]);
  expect(detail.totalActiveMs).toBe(0);
});

test('drop while active auto-closes the open Interval', async () => {
  await ensureProject();
  const id = (await makeTask('Abandoned mid-run')).id;
  await patch(id, { status: 'active' });
  await sleep(30);
  await patch(id, { status: 'dropped' });

  const detail = await get(id);
  expect(detail.task.status).toBe('dropped');
  expect(detail.intervals).toHaveLength(1);
  expect(detail.intervals[0].endedAt).not.toBeNull();
  expect(detail.totalActiveMs).toBeGreaterThanOrEqual(25);
});

test('field updates and a status transition in one PATCH commit together', async () => {
  await ensureProject();
  const id = (await makeTask('Combined change')).id;

  const updated = await (await patch(id, { title: 'Combined and started', status: 'active' })).json();
  expect(updated.task.title).toBe('Combined and started');
  expect(updated.task.status).toBe('active');
  expect((await get(id)).intervals).toHaveLength(1);

  // an illegal status rolls the field changes back with it
  const failed = await patch(id, { title: 'Never written', status: 'pending' });
  expect(failed.status).toBe(409);
  const detail = await get(id);
  expect(detail.task.title).toBe('Combined and started');
  expect(detail.task.status).toBe('active');
});

// ---------------------------------------------------------- verb endpoints

test('POST /tasks/:id/start and /tasks/:id/done map onto the machine like PATCH', async () => {
  await ensureProject();

  // start on pending -> active, opening an Interval (same effect as PATCH)
  const started = (await makeTask('Verb start')).id;
  const startResponse = await postStatus(started, 'start');
  expect(startResponse.status).toBe(200);
  expect(((await startResponse.json()) as any).task.status).toBe('active');
  expect((await get(started)).intervals).toHaveLength(1);

  // done on active -> done, closing it
  await sleep(30);
  const doneResponse = await postStatus(started, 'done');
  expect(doneResponse.status).toBe(200);
  expect(((await doneResponse.json()) as any).task.status).toBe('done');
  const detail = await get(started);
  expect(detail.intervals[0].endedAt).not.toBeNull();
  expect(detail.totalActiveMs).toBeGreaterThanOrEqual(25);
});

test('verb endpoints error with exactly the PATCH {status} message for the same task', async () => {
  await ensureProject();
  const id = (await makeTask('Verb parity')).id;

  // start on a done task: identical message through both surfaces
  await patch(id, { status: 'done' });
  const viaPatch = await patch(id, { status: 'active' });
  expect(viaPatch.status).toBe(409);
  const viaVerb = await postStatus(id, 'start');
  expect(viaVerb.status).toBe(409);
  expect(((await viaVerb.json()) as { error: string }).error).toBe(
    ((await viaPatch.json()) as { error: string }).error,
  );

  // done on an already-done task: same-status rejection through both surfaces
  const patchAgain = await patch(id, { status: 'done' });
  expect(patchAgain.status).toBe(409);
  const verbAgain = await postStatus(id, 'done');
  expect(verbAgain.status).toBe(409);
  expect(((await verbAgain.json()) as { error: string }).error).toBe(
    ((await patchAgain.json()) as { error: string }).error,
  );
});

test('verb endpoints reject unknown tasks and non-POST methods', async () => {
  await ensureProject();

  const unknown = await postStatus(999999, 'start');
  expect(unknown.status).toBe(404);
  expect(((await unknown.json()) as { error: string }).error).toContain('unknown task id');

  const badId = await fetch(`${daemon.baseUrl}/tasks/not-a-number/start`, { method: 'POST' });
  expect(badId.status).toBe(400);
  expect(((await badId.json()) as { error: string }).error).toContain('task id must be an integer');

  const task = await makeTask('Method police');
  const onVerb = await fetch(`${daemon.baseUrl}/tasks/${task.id}/start`);
  expect(onVerb.status).toBe(405);
});
