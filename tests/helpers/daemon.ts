import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Process-level test harness (the seam every later change reuses): boots the
 * BUILT daemon (`node dist/index.js`) as a real subprocess on a random port
 * with a fresh temp data dir, waits for readiness, and tears everything down.
 *
 * Durability tests (T9) can pass a fixed `dataDir` (to restart a NEW daemon
 * process on a previous dir), keep the dir on stop, and `kill()` for crash
 * simulation. The existing `startDaemon()` / `startDaemon({ env })` /
 * `daemon.stop()` call shapes are unchanged.
 *
 * Readiness contract with the daemon:
 *   1. the daemon prints one JSON line `{"event":"listening",...,"port":N}`
 *      to stdout once the HTTP server is bound;
 *   2. `GET /healthz` answers 200 once the daemon serves traffic.
 */
/**
 * The repo root: relative to this module under normal (file://) resolution,
 * falling back to the vitest cwd — DOM test environments rewrite
 * import.meta.url to a non-file URL, where fileURLToPath cannot help.
 */
function projectRoot(): string {
  try {
    return fileURLToPath(new URL('../..', import.meta.url));
  } catch {
    return process.cwd();
  }
}
const PROJECT_ROOT = projectRoot();
const DAEMON_ENTRY = join(PROJECT_ROOT, 'dist', 'index.js');

const PORT_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;
const KILL_TIMEOUT_MS = 5_000;

export interface DaemonHandle {
  port: number;
  baseUrl: string;
  dataDir: string;
  /** Path of the SQLite database file under the temp data dir. */
  dbPath: string;
  /**
   * SIGTERMs the daemon (SIGKILL fallback) and waits for exit. Removes the
   * temp data dir unless the caller provided it (options.dataDir) or asked to
   * keep it (durability tests restart a new daemon on the same dir).
   */
  stop: (options?: StopDaemonOptions) => Promise<void>;
  /**
   * SIGKILLs the daemon immediately (crash simulation) and waits for exit.
   * Never touches the data dir — the caller owns it after this.
   */
  kill: () => Promise<void>;
}

export interface StartDaemonOptions {
  env?: Record<string, string>;
  /**
   * Use this exact data dir instead of a fresh temp one (durability tests
   * restart a NEW daemon process on a previous dir). Created by the daemon if
   * missing; never removed by the helper.
   */
  dataDir?: string;
}

export interface StopDaemonOptions {
  /** Keep the helper-created data dir instead of removing it. */
  keepDataDir?: boolean;
}

export async function startDaemon(options: StartDaemonOptions = {}): Promise<DaemonHandle> {
  if (!existsSync(DAEMON_ENTRY)) {
    throw new Error(`daemon entry ${DAEMON_ENTRY} not found — run \`npm run build\` before \`npm test\``);
  }

  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'baton-test-')));
  const child = spawn(process.execPath, [DAEMON_ENTRY, '--port', '0', '--data', dataDir], {
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
  });

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`daemon did not report its listening port within ${PORT_TIMEOUT_MS}ms; stderr:\n${stderr}`));
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
          continue; // not part of the contract; ignore
        }
        if (isListeningEvent(message)) {
          clearTimeout(timer);
          resolve(message.port);
        }
      }
    });
    exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited before listening (code ${code}); stderr:\n${stderr}`));
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);

  const stop = async (stopOptions: StopDaemonOptions = {}): Promise<void> => {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, KILL_TIMEOUT_MS);
      await exited;
      clearTimeout(killTimer);
    }
    // rm -rf also removes the WAL/-shm sidecar files. A caller-provided data
    // dir is never the helper's to delete.
    if (options.dataDir === undefined && !stopOptions.keepDataDir) {
      await rm(dataDir, { recursive: true, force: true });
    }
  };

  const kill = async (): Promise<void> => {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGKILL');
    }
    await exited;
  };

  return { port, baseUrl, dataDir, dbPath: join(dataDir, 'data.db'), stop, kill };
}

function isListeningEvent(message: unknown): message is { event: 'listening'; port: number } {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { event?: unknown }).event === 'listening' &&
    typeof (message as { port?: unknown }).port === 'number'
  );
}

/**
 * One health probe over node:http directly — DOM test environments replace
 * the global fetch with their own implementation, which must never sit on
 * this harness's readiness path.
 */
function healthOnce(baseUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = httpGet(`${baseUrl}/healthz`, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.end();
  });
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    if (await healthOnce(baseUrl)) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`daemon did not answer GET /healthz within ${HEALTH_TIMEOUT_MS}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
