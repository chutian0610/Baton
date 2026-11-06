import { type AddressInfo } from 'node:net';
import { openDatabase, type Db } from './db.js';
import { createBatonHttpServer, type BatonHttpServer } from './http.js';

/**
 * Daemon lifecycle: open the store, listen on 127.0.0.1 only (ADR-0001),
 * announce readiness on stdout as a single JSON line (the test harness
 * contract), and shut down cleanly on SIGINT/SIGTERM.
 */
export interface DaemonOptions {
  dataDir: string;
  /** 0 = OS-assigned random port. */
  port: number;
  hostname?: string;
}

export interface RunningDaemon {
  port: number;
  baseUrl: string;
  db: Db;
  http: BatonHttpServer;
  stop: () => Promise<void>;
}

const DEFAULT_HOSTNAME = '127.0.0.1';

export async function runDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;

  const db = openDatabase(options.dataDir);
  const http = createBatonHttpServer({ db });

  await new Promise<void>((resolve, reject) => {
    http.httpServer.once('error', reject);
    http.httpServer.listen(options.port, hostname, resolve);
  });
  const address = http.httpServer.address() as AddressInfo;
  const port = address.port;
  const baseUrl = `http://${hostname}:${port}`;

  process.stdout.write(`${JSON.stringify({ event: 'listening', address: hostname, port })}\n`);

  return { port, baseUrl, db, http, stop: () => shutdown(http, db) };
}

async function shutdown(http: BatonHttpServer, db: Db): Promise<void> {
  await http.closeMcpSessions();
  await new Promise<void>((resolve) => {
    http.httpServer.close(() => resolve());
    http.httpServer.closeAllConnections(); // drop keep-alive sockets so close() can complete
  });
  db.close();
}

/** Installs signal handlers around a running daemon; resolves once shutdown finished. */
export function installSignalHandlers(daemon: RunningDaemon): void {
  let shuttingDown = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      // Second signal while shutting down: give up gracefully-enough.
      process.exit(1);
    }
    shuttingDown = true;
    process.stderr.write(`received ${signal}, shutting down\n`);
    daemon
      .stop()
      .then(() => process.exit(0))
      .catch((err) => {
        process.stderr.write(`shutdown failed: ${(err as Error)?.stack ?? err}\n`);
        process.exit(1);
      });
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}
