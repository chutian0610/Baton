import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import {
  createProject,
  listProjects,
  ProjectError,
  resolveCurrentProject,
} from './projects.js';
import type { Db } from './db.js';

/**
 * The MCP surface. ADR-0001: MCP is a thin adapter over the HTTP core, so
 * every tool maps 1:1 onto a core operation (src/projects.ts) and returns the
 * same JSON payload the HTTP route would; domain failures surface as tool
 * errors carrying the identical message text.
 *
 * A fresh McpServer is built per MCP session (a server instance owns one
 * transport); the Db handle is shared across sessions and owned by the daemon.
 */
export function buildMcpServer(db: Db): McpServer {
  const mcp = new McpServer({ name: 'baton', version: '0.1.0' });

  mcp.registerTool(
    'project_create',
    {
      title: 'Create project',
      description:
        'Create a Project with a unique name and one or more bound absolute local paths. ' +
        'Paths are stored canonically (no trailing slash) and each path binds to at most one project; ' +
        'duplicate names and already-bound paths are rejected.',
      inputSchema: {
        name: z.string().min(1),
        paths: z.array(z.string().min(1)).min(1),
      },
    },
    async ({ name, paths }) =>
      runTool(() => ({ project: createProject(db, { name, paths }) })),
  );

  mcp.registerTool(
    'project_list',
    {
      title: 'List projects',
      description: 'List all Projects with their bound paths and open-task counts.',
    },
    async () => runTool(() => ({ projects: listProjects(db) })),
  );

  mcp.registerTool(
    'project_current',
    {
      title: 'Current project',
      description:
        "Resolve a working directory (cwd) to the Current Project via longest-prefix match over all " +
        "projects' bound paths; errors with the fix when the cwd is not under any bound path.",
      inputSchema: {
        cwd: z.string().min(1),
      },
    },
    async ({ cwd }) => runTool(() => resolveCurrentProject(db, cwd)),
  );

  return mcp;
}

/** Runs a core operation, returning its payload as JSON text or a tool error. */
function runTool(operation: () => unknown): CallToolResult {
  try {
    return {
      content: [{ type: 'text', text: JSON.stringify(operation(), null, 2) }],
    };
  } catch (err) {
    if (err instanceof ProjectError) {
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
    throw err; // unexpected — let the SDK surface it as a protocol error
  }
}
