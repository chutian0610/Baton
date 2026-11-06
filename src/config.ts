import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'smol-toml';

/**
 * Daemon configuration.
 *
 * Resolution order (highest wins):
 *   dataDir: --data CLI arg  >  BATON_DATA_DIR env  >  ~/.baton
 *   port:    --port CLI arg  >  BATON_PORT env      >  port in <dataDir>/config.toml  >  0 (random)
 *
 * Full config handling (config.toml schema, validation, writes) is ticket #9/T8;
 * this resolver is the minimal stub the daemon needs to boot today.
 */
export interface DaemonConfig {
  dataDir: string;
  port: number;
}

const DEFAULT_PORT = 0; // 0 = OS-assigned random port; avoids clashes until config lands (T8)

export function resolveConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): DaemonConfig {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p' },
      data: { type: 'string' },
    },
  });

  const positional = positionals[0];
  if (positional !== undefined && positional !== 'daemon') {
    throw new UsageError(`unknown command: ${positional} (expected: baton [daemon])`);
  }

  const dataDir = values.data ?? env.BATON_DATA_DIR ?? join(homedir(), '.baton');

  const port =
    parsePort(values.port, '--port') ??
    parsePort(env.BATON_PORT, 'BATON_PORT') ??
    readPortFromConfigToml(join(dataDir, 'config.toml')) ??
    DEFAULT_PORT;

  return { dataDir, port };
}

export class UsageError extends Error {}

function parsePort(raw: string | undefined, source: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(`invalid port from ${source}: ${raw} (expected integer 0-65535; 0 = random)`);
  }
  return port;
}

function readPortFromConfigToml(configPath: string): number | undefined {
  if (!existsSync(configPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new UsageError(`failed to parse ${configPath}: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || !('port' in parsed)) return undefined;
  const port = (parsed as { port: unknown }).port;
  if (typeof port !== 'number' || !Number.isInteger(port)) {
    throw new UsageError(`invalid port in ${configPath}: expected an integer, got ${JSON.stringify(port)}`);
  }
  return parsePort(String(port), configPath);
}
