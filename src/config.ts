import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'smol-toml';

/**
 * Daemon configuration.
 *
 * The daemon always reads `~/.baton/config.toml` when that file exists. The
 * file knows exactly two keys, both optional:
 *
 *   port      integer 0-65535        (0 = OS-assigned random port)
 *   data_dir  absolute path string   (where data.db lives)
 *
 * An empty or missing file is fine. A file with an unknown key, a value of
 * the wrong type, or invalid TOML fails startup with an error naming the
 * offender — fail-fast beats silently ignoring a typo'd knob.
 *
 * Resolution order per key (highest wins):
 *   port:     --port CLI arg  >  BATON_PORT env  >  config.toml `port`      >  7600
 *   data_dir: --data CLI arg  >  BATON_DATA_DIR  >  config.toml `data_dir`  >  ~/.baton
 */
export interface DaemonConfig {
  dataDir: string;
  port: number;
}

export class UsageError extends Error {}

const DEFAULT_PORT = 7600;

/** The config file always lives at `~/.baton/config.toml`, wherever data_dir ends up pointing. */
export function configFilePath(): string {
  return join(homedir(), '.baton', 'config.toml');
}

interface FileConfig {
  port?: number;
  dataDir?: string;
}

const CONFIG_KEYS = ['port', 'data_dir'] as const;

export function resolveConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): DaemonConfig {
  let values: { port?: string; data?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        port: { type: 'string', short: 'p' },
        data: { type: 'string' },
      },
    }));
  } catch (err) {
    // Unknown flags etc. (node:util parseArgs errors): a clean usage line,
    // not a stack trace — this is the "is the binary wired" path.
    throw new UsageError(`${(err as Error).message} (usage: baton [daemon] [--port N] [--data DIR])`);
  }

  const positional = positionals[0];
  if (positional !== undefined && positional !== 'daemon') {
    throw new UsageError(`unknown command: ${positional} (expected: baton [daemon])`);
  }

  const fileConfig = readConfigFile(configFilePath());

  const dataDir =
    nonEmpty(values.data) ??
    nonEmpty(env.BATON_DATA_DIR) ??
    fileConfig?.dataDir ??
    join(homedir(), '.baton');

  const port =
    parsePort(values.port, '--port') ??
    parsePort(env.BATON_PORT, 'BATON_PORT') ??
    fileConfig?.port ??
    DEFAULT_PORT;

  return { dataDir, port };
}

/** Treat an empty string as "not provided" (--data "" and BATON_DATA_DIR= both mean: look further down). */
function nonEmpty(raw: string | undefined): string | undefined {
  return raw === undefined || raw === '' ? undefined : raw;
}

function parsePort(raw: string | undefined, source: string): number | undefined {
  const value = nonEmpty(raw);
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(`invalid port from ${source}: ${value} (expected integer 0-65535; 0 = random)`);
  }
  return port;
}

/** Parses and validates the config file. Missing file -> undefined; anything wrong -> UsageError. */
function readConfigFile(configPath: string): FileConfig | undefined {
  if (!existsSync(configPath)) return undefined;

  let parsed: unknown;
  try {
    parsed = parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new UsageError(`failed to parse ${configPath}: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`invalid config file ${configPath}: expected a top-level TOML table`);
  }

  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new UsageError(
        `unknown config key "${key}" in ${configPath} (allowed keys: ${CONFIG_KEYS.join(', ')})`,
      );
    }
  }

  const fileConfig: FileConfig = {};

  if (record.port !== undefined) {
    const port = record.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
      throw new UsageError(
        `invalid config key "port" in ${configPath}: ${JSON.stringify(port)} (expected integer 0-65535)`,
      );
    }
    fileConfig.port = port;
  }

  if (record.data_dir !== undefined) {
    const dataDir = record.data_dir;
    if (typeof dataDir !== 'string' || dataDir === '' || !isAbsolute(dataDir)) {
      throw new UsageError(
        `invalid config key "data_dir" in ${configPath}: ${JSON.stringify(dataDir)} ` +
          '(expected a non-empty absolute path; the daemon may be started from any directory)',
      );
    }
    fileConfig.dataDir = dataDir;
  }

  return fileConfig;
}

function isAbsolute(path: string): boolean {
  return path.startsWith('/');
}
