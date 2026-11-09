import { afterAll, beforeAll, expect, test } from 'vitest';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { startDaemon, type DaemonHandle } from './helpers/daemon.js';

let daemon: DaemonHandle;

beforeAll(async () => {
  daemon = await startDaemon();
});

afterAll(async () => {
  await daemon.stop();
});

test('GET /healthz answers 200 with JSON status ok', async () => {
  const response = await fetch(`${daemon.baseUrl}/healthz`);

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.json()).toEqual({ status: 'ok' });
});

test('daemon creates the SQLite database under the data dir with a schema version applied', async () => {
  expect(existsSync(daemon.dbPath)).toBe(true);

  const db = new Database(daemon.dbPath, { readonly: true });
  try {
    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBeGreaterThan(0);
  } finally {
    db.close();
  }
});
