#!/usr/bin/env node
import { runDaemon, installSignalHandlers } from './daemon.js';
import { resolveConfig, UsageError } from './config.js';

/**
 * Entrypoint: `baton [daemon]` runs the daemon in the foreground (spec: start
 * with `baton daemon`; running bare `baton` does the same for now — a richer
 * CLI surface is out of scope for v1).
 */
async function main(): Promise<void> {
  const config = resolveConfig();
  const daemon = await runDaemon(config);
  installSignalHandlers(daemon);
}

main().catch((err) => {
  if (err instanceof UsageError) {
    process.stderr.write(`baton: ${err.message}\n`);
  } else {
    process.stderr.write(`baton: failed to start: ${(err as Error)?.stack ?? err}\n`);
  }
  process.exit(1);
});
