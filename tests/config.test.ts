import { spawn, type ChildProcess } from 'node:child_process';
import { type AddressInfo, createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

/**
 * Process-level config tests (T8): the real daemon binary, real HOME, real
 * config.toml. The shared harness (tests/helpers/daemon.ts) always passes
 * explicit --port/--data, which would override the config file — so these
 * tests spawn the daemon directly with controlled argv/env instead.
 *
 * Hermeticity: every test points HOME at a fresh temp dir, so `~/.baton/...`
 * resolves inside it and the developer's real home is never read or written.
 */
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DAEMON_ENTRY = join(PROJECT_ROOT, 'dist', 'index.js');

const PORT_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 15_000;

interface BootedDaemon {
  /** Port from the daemon's readiness line (the actual listening port). */
  port: number;
  stop: () => Promise<void>;
}

interface SpawnOptions {
  argv?: string[];
  home: string;
  env?: Record<string, string>;
}

/** Spawns the daemon and resolves once it prints its listening line. */
function bootDaemon(options: SpawnOptions): Promise<BootedDaemon> {
  const { child, stderr } = spawnDaemon(options);
  return new Promise<BootedDaemon>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`daemon did not report its listening port within ${PORT_TIMEOUT_MS}ms; stderr:\n${stderr()}`));
      void kill(child);
    }, PORT_TIMEOUT_MS);
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newlineAt: number;
      while ((newlineAt = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineAt).trim();
        buffer = buffer.slice(newlineAt + 1);
        if (line === '') continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          typeof message === 'object' &&
          message !== null &&
          (message as { event?: unknown }).event === 'listening' &&
          typeof (message as { port?: unknown }).port === 'number'
        ) {
          clearTimeout(timer);
          resolve({
            port: (message as { port: number }).port,
            stop: async () => {
              child.kill('SIGTERM');
              await exited(child);
            },
          });
          return;
        }
      }
    });
    exited(child).then((code) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited before listening (code ${code}); stderr:\n${stderr()}`));
    });
  });
}

/** Spawns the daemon and resolves its exit code plus collected stderr. */
function runDaemonExpectExit(options: SpawnOptions): Promise<{ code: number | null; stderr: string }> {
  const { child, stderr } = spawnDaemon(options);
  const timer = setTimeout(() => void kill(child), EXIT_TIMEOUT_MS);
  return exited(child).then((code) => {
    clearTimeout(timer);
    return { code, stderr: stderr() };
  });
}

function spawnDaemon(options: SpawnOptions): { child: ChildProcess; stderr: () => string } {
  // Empty-string env values are "not provided" to the resolver, so this
  // neutralizes any BATON_PORT/BATON_DATA_DIR inherited from the test runner.
  const env = { ...process.env, BATON_PORT: '', BATON_DATA_DIR: '', HOME: options.home, ...options.env };
  const child = spawn(process.execPath, [DAEMON_ENTRY, ...(options.argv ?? [])], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return { child, stderr: () => stderr };
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once('exit', (code) => resolve(code));
  });
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
  await exited(child);
}

/** A fresh empty HOME; removed when the test finishes. */
async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'baton-home-'));
  return home;
}

/** Writes `~/.baton/config.toml` (under the given HOME) with TOML body text. */
async function writeConfig(home: string, body: string): Promise<void> {
  const dir = join(home, '.baton');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.toml'), body, 'utf8');
}

async function cleanupDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/** A currently-free TCP port (bind 0, read the port, close; small race, fine for tests). */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

// --------------------------------------------------------------------------

test('config.toml port is honored when no CLI/env override exists', async () => {
  const home = await tempHome();
  const port = await freePort();
  await writeConfig(home, `port = ${port}\n`);
  try {
    const daemon = await bootDaemon({ home });
    expect(daemon.port).toBe(port);
    await daemon.stop();
  } finally {
    await cleanupDir(home);
  }
});

test('config.toml data_dir is honored: the database lands there', async () => {
  const home = await tempHome();
  const dataDir = await mkdtemp(join(tmpdir(), 'baton-data-'));
  await writeConfig(home, `data_dir = ${JSON.stringify(dataDir)}\n`);
  try {
    const daemon = await bootDaemon({ home });
    expect(daemon.port).toBeGreaterThan(0);
    expect(existsSync(join(dataDir, 'data.db'))).toBe(true);
    await daemon.stop();
  } finally {
    await cleanupDir(home);
    await cleanupDir(dataDir);
  }
});

test('BATON_PORT and BATON_DATA_DIR override config.toml', async () => {
  const home = await tempHome();
  const configPort = await freePort();
  const envPort = await freePort();
  const configDataDir = await mkdtemp(join(tmpdir(), 'baton-data-'));
  const envDataDir = await mkdtemp(join(tmpdir(), 'baton-data-'));
  await writeConfig(
    home,
    `port = ${configPort}\ndata_dir = ${JSON.stringify(configDataDir)}\n`,
  );
  try {
    const daemon = await bootDaemon({ home, env: { BATON_PORT: String(envPort), BATON_DATA_DIR: envDataDir } });
    expect(daemon.port).toBe(envPort);
    expect(existsSync(join(envDataDir, 'data.db'))).toBe(true);
    expect(existsSync(join(configDataDir, 'data.db'))).toBe(false);
    await daemon.stop();
  } finally {
    await cleanupDir(home);
    await cleanupDir(configDataDir);
    await cleanupDir(envDataDir);
  }
});

test('missing config file falls back to product defaults: port 7600, ~/.baton', async () => {
  const home = await tempHome();
  try {
    const daemon = await bootDaemon({ home });
    expect(daemon.port).toBe(7600);
    expect(existsSync(join(home, '.baton', 'data.db'))).toBe(true);
    await daemon.stop();
  } finally {
    await cleanupDir(home);
  }
});

test('empty config file is not an error: defaults still apply', async () => {
  const home = await tempHome();
  await writeConfig(home, '# nothing configured\n');
  try {
    const daemon = await bootDaemon({ home });
    expect(daemon.port).toBe(7600);
    await daemon.stop();
  } finally {
    await cleanupDir(home);
  }
});

test('unknown config key fails startup naming the key', async () => {
  const home = await tempHome();
  await writeConfig(home, 'florp = 1\n');
  try {
    const { code, stderr } = await runDaemonExpectExit({ home });
    expect(code).not.toBe(0);
    expect(stderr).toContain('florp');
  } finally {
    await cleanupDir(home);
  }
});

test('config port of the wrong type fails startup naming the key', async () => {
  const home = await tempHome();
  await writeConfig(home, 'port = "seven"\n');
  try {
    const { code, stderr } = await runDaemonExpectExit({ home });
    expect(code).not.toBe(0);
    expect(stderr).toContain('port');
  } finally {
    await cleanupDir(home);
  }
});

test('relative data_dir fails startup asking for an absolute path', async () => {
  const home = await tempHome();
  await writeConfig(home, 'data_dir = "baton-data"\n');
  try {
    const { code, stderr } = await runDaemonExpectExit({ home });
    expect(code).not.toBe(0);
    expect(stderr).toContain('data_dir');
    expect(stderr).toContain('absolute');
  } finally {
    await cleanupDir(home);
  }
});
