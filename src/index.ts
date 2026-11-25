#!/usr/bin/env node
import { runDaemon, installSignalHandlers } from './daemon.js';
import { USAGE, resolveConfig, UsageError } from './config.js';

const HELP_TEXT = `Baton — a single-machine task management daemon for AI coding agents.

${USAGE}

  baton              start the daemon in the foreground (same as: baton daemon)
  baton daemon       start the daemon
  --port N           listen on port N (0 = random)      [env: BATON_PORT]
  --data DIR         store data.db under DIR (absolute) [env: BATON_DATA_DIR]

Configuration: ~/.baton/config.toml (port, data_dir). See the repository
README for MCP client setup, the HTTP API, and usage examples.`;

/**
 * Entrypoint: `baton [daemon]` runs the daemon in the foreground (spec: start
 * with `baton daemon`; running bare `baton` does the same for now — a richer
 * CLI surface is out of scope for v1).
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return; // exit 0; no server is started
  }
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
