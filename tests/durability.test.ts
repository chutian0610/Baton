import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon, type DaemonHandle } from './helpers/daemon.js';

/**
 * Durability verification (T9, ADR-0002): everything the daemon confirmed
 * before a graceful SIGTERM — and everything confirmed before a hard SIGKILL
 * mid-activity — is on disk and reads back identically from a NEW daemon
 * process started on the same data dir. Crash-during-active-Interval is
 * explicitly NOT promised to auto-close (issue #9): durability here means the
 * status and the open Interval survive exactly as they were.
 */

const JSON_HEADERS = { 'content-type': 'application/json' };

const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  await Promise.all(cleanups.map((cleanup) => cleanup()));
});

async function newDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'baton-durability-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------- helpers

async function request(daemon: DaemonHandle, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    method,
    headers: JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function ok(daemon: DaemonHandle, method: string, path: string, body: unknown, context: string): Promise<any> {
  const response = await request(daemon, method, path, body);
  const text = await response.text();
  const summary = `${context}: ${response.status} ${text}`;
  expect(response.status, summary).toBeGreaterThanOrEqual(200);
  expect(response.status, summary).toBeLessThan(300);
  return text === '' ? null : JSON.parse(text);
}

async function makeProject(daemon: DaemonHandle, name: string): Promise<{ id: number }> {
  return (await ok(daemon, 'POST', '/projects', { name, paths: [`/workspace/${name}`] }, `project ${name}`)).project;
}

async function makeTask(
  daemon: DaemonHandle,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: number; title: string }> {
  const { task } = await ok(daemon, 'POST', '/tasks', { title, ...extra }, `task ${title}`);
  return { id: task.id, title: task.title };
}

async function detail(daemon: DaemonHandle, id: number): Promise<any> {
  return ok(daemon, 'GET', `/tasks/${id}`, undefined, `read ${id}`);
}

// ------------------------------------------------------ graceful restart

test('graceful SIGTERM restart: every entity and record reads back identical from a new daemon process', async () => {
  const dataDir = await newDataDir();
  const first = await startDaemon({ dataDir });

  await makeProject(first, 'durable');
  const root = await makeTask(first, 'Root', { project: 'durable', tags: ['infra'] });
  const childA = await makeTask(first, 'Child A', { project: 'durable', parent: root.id });
  const childB = await makeTask(first, 'Child B', { project: 'durable', parent: root.id });
  const grandchild = await makeTask(first, 'Grandchild', { project: 'durable', parent: childA.id });

  // Child A lives a full life and ends waiting: two closed Intervals.
  await ok(first, 'POST', `/tasks/${childA.id}/start`, undefined, 'childA start');
  await ok(first, 'POST', `/tasks/${childA.id}/done`, undefined, 'childA done');
  await ok(first, 'PATCH', `/tasks/${childA.id}`, { status: 'pending' }, 'childA reopen');
  await ok(first, 'POST', `/tasks/${childA.id}/start`, undefined, 'childA restart');
  await ok(first, 'PATCH', `/tasks/${childA.id}`, { status: 'waiting' }, 'childA waiting');

  // Child B is done straight from pending: no Interval ever.
  await ok(first, 'POST', `/tasks/${childB.id}/done`, undefined, 'childB done');

  // Grandchild collects annotations; root collects field updates plus one note.
  for (const body of ['first note', 'second note', 'third note']) {
    await ok(first, 'POST', `/tasks/${grandchild.id}/annotations`, { body }, `grandchild ${body}`);
  }
  await ok(
    first,
    'PATCH',
    `/tasks/${root.id}`,
    { priority: 'H', due: '2026-12-31T00:00:00Z', effort: '3h', tags: ['infra', 'q4'] },
    'root fields',
  );
  await ok(first, 'POST', `/tasks/${root.id}/annotations`, { body: 'root note' }, 'root note');

  const ids = [root.id, childA.id, childB.id, grandchild.id];
  const snapshot = {
    projects: await ok(first, 'GET', '/projects', undefined, 'projects'),
    tasks: Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await detail(first, id)]))),
  };
  // Every Interval is closed, so nothing in the snapshot is time-derived.
  for (const id of ids) {
    expect(snapshot.tasks[id].intervals.every((interval: any) => interval.endedAt !== null)).toBe(true);
  }

  await first.stop(); // graceful SIGTERM; the caller-owned data dir is kept

  const second = await startDaemon({ dataDir }); // a NEW process, same store
  try {
    const reread = {
      projects: await ok(second, 'GET', '/projects', undefined, 'projects after restart'),
      tasks: Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await detail(second, id)]))),
    };
    expect(reread).toEqual(snapshot); // tasks, statuses, intervals, annotations, change log

    // Ids continue from where the old process left off…
    const fresh = await makeTask(second, 'After restart', { project: 'durable' });
    expect(fresh.id).toBeGreaterThan(Math.max(...ids));
    // …and the change log appends on top of the preserved rows.
    await ok(second, 'PATCH', `/tasks/${root.id}`, { priority: 'L' }, 'root post-restart change');
    const rootAfter = await detail(second, root.id);
    expect(rootAfter.recentChanges[0].diff).toEqual({ priority: { before: 'H', after: 'L' } });
    expect(rootAfter.recentChanges.slice(1)).toEqual(snapshot.tasks[root.id].recentChanges);
  } finally {
    await second.stop();
  }
});

// ------------------------------------------------------ hard kill mid-activity

interface ConfirmedWrite {
  id: number;
  title: string;
  /** Last status transition whose response arrived before the kill. */
  lastStatus: 'pending' | 'active' | 'done';
  annotates: number;
}

test('SIGKILL mid-activity: every confirmed write survives and the store reopens cleanly', async () => {
  const dataDir = await newDataDir();
  const victim = await startDaemon({ dataDir });
  await makeProject(victim, 'chaos');

  const QUORUM = 40; // kill once this many tasks have fully-confirmed pipelines
  const confirmed: ConfirmedWrite[] = [];
  let killed = false;
  let reachedQuorum!: () => void;
  const quorum = new Promise<void>((resolve) => {
    reachedQuorum = resolve;
  });
  let quorumTimeout!: NodeJS.Timeout;
  const quorumDeadline = new Promise<never>((_, reject) => {
    quorumTimeout = setTimeout(
      () => reject(new Error('quorum of confirmed writes not reached in time')),
      15_000,
    );
  });

  // Sequential writer: create → start → annotate → done per task. Whatever
  // response has ARRIVED when the SIGKILL lands is owed to us afterwards;
  // in-flight requests may fail with connection errors — that is the point.
  const writer = (async () => {
    for (let i = 0; i < 400 && !killed; i++) {
      try {
        const title = `chaos-${i}`;
        const entry: ConfirmedWrite = { id: 0, title, lastStatus: 'pending', annotates: 0 };
        const created = await ok(victim, 'POST', '/tasks', { title, project: 'chaos' }, `create ${title}`);
        entry.id = created.task.id;
        confirmed.push(entry);

        await ok(victim, 'POST', `/tasks/${entry.id}/start`, undefined, `start ${title}`);
        entry.lastStatus = 'active';

        await ok(victim, 'POST', `/tasks/${entry.id}/annotations`, { body: `note ${title}` }, `annotate ${title}`);
        entry.annotates += 1;

        await ok(victim, 'POST', `/tasks/${entry.id}/done`, undefined, `done ${title}`);
        entry.lastStatus = 'done';

        if (confirmed.length >= QUORUM) reachedQuorum();
      } catch (err) {
        if (!killed) throw err; // a failure BEFORE the kill is a real failure
      }
    }
  })();

  await Promise.race([
    quorum,
    writer, // rejects (and fails the test) if anything breaks before the kill
    quorumDeadline,
  ]);
  clearTimeout(quorumTimeout);
  killed = true;
  await victim.kill(); // hard crash: no SIGTERM, no cleanup, no db.close()
  await writer; // remaining in-flight requests error out and the loop stops

  expect(confirmed.length).toBeGreaterThanOrEqual(QUORUM);

  // A new daemon process on the same data dir: readiness itself proves the
  // schema (and the WAL) recovered without corruption.
  const successor = await startDaemon({ dataDir });
  try {
    for (const { id, title, lastStatus, annotates } of confirmed) {
      const reread = await detail(successor, id);
      expect(reread.task.title).toBe(title);
      expect(reread.task.status).toBe(lastStatus); // exactly the last confirmed status
      expect(reread.annotations).toHaveLength(annotates);
      expect(reread.annotations.every((annotation: any) => annotation.body.startsWith('note chaos-'))).toBe(true);
    }

    // The recovered store still accepts writes.
    const fresh = await makeTask(successor, 'after the crash', { project: 'chaos' });
    expect((await detail(successor, fresh.id)).task.title).toBe('after the crash');
  } finally {
    await successor.stop();
  }
});

// ------------------------------------------------- open Interval across a crash

test('a task active at SIGKILL keeps its status and its open Interval after restart (no auto-close)', async () => {
  const dataDir = await newDataDir();
  const first = await startDaemon({ dataDir });
  await makeProject(first, 'active-crash');
  const task = await makeTask(first, 'Mid-flight work', { project: 'active-crash' });
  await ok(first, 'POST', `/tasks/${task.id}/start`, undefined, 'start');

  const before = await detail(first, task.id);
  expect(before.task.status).toBe('active');
  expect(before.intervals).toHaveLength(1);
  expect(before.intervals[0].endedAt).toBeNull();

  await first.kill(); // crash while the Interval is open
  const second = await startDaemon({ dataDir });
  try {
    const after = await detail(second, task.id);
    expect(after.task.status).toBe('active'); // NOT auto-closed (issue #9)
    expect(after.intervals).toEqual(before.intervals); // same Interval, still open

    // The board is still fully usable: the old Interval closes normally on done.
    await ok(second, 'POST', `/tasks/${task.id}/done`, undefined, 'done after restart');
    const closed = await detail(second, task.id);
    expect(closed.task.status).toBe('done');
    expect(closed.intervals).toHaveLength(1);
    expect(closed.intervals[0].endedAt).not.toBeNull();
  } finally {
    await second.stop();
  }
});
