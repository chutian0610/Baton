import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import type { Actor } from './actors.js';
import { appendAnnotation } from './annotations.js';
import {
  createProject,
  listProjects,
  ProjectError,
  resolveCurrentProject,
} from './projects.js';
import { createTask, getTask, TaskError, updateTask } from './tasks.js';
import type { Db } from './db.js';

/**
 * The MCP surface. ADR-0001: MCP is a thin adapter over the HTTP core, so
 * every tool maps 1:1 onto a core operation (src/projects.ts, src/tasks.ts,
 * src/annotations.ts) and returns the same JSON payload the HTTP route would;
 * domain failures surface as tool errors carrying the identical message text.
 *
 * Input schemas deliberately stay type-shaped (e.g. priority is a plain
 * string) instead of encoding domain rules: those checks live in the core
 * layer so MCP tool errors and HTTP error bodies share the same text. The
 * not-yet-supported arguments (status, deps, project-on-update) ARE declared
 * so they reach the core layer, which rejects them with a clear message
 * instead of zod silently stripping them.
 *
 * Actor recording (spec "Actor recording"): every mutating tool passes the
 * MCP actor — the handshake's clientInfo via `mcp.server.getClientVersion()`
 * (populated after initialize, i.e. by the time any tool handler runs) plus
 * the session id from the handler's `extra` — down into the core layer as a
 * parameter, exactly like the HTTP surface passes its constant actor.
 *
 * A fresh McpServer is built per MCP session (a server instance owns one
 * transport); the Db handle is shared across sessions and owned by the daemon.
 */
export function buildMcpServer(db: Db): McpServer {
  const mcp = new McpServer({ name: 'baton', version: '0.1.0' });

  /** The MCP actor for a request: clientInfo from the handshake + session id when the transport has one. */
  const mcpActor = (sessionId?: string): Actor => {
    const client = mcp.server.getClientVersion();
    return {
      kind: 'mcp',
      clientName: client?.name ?? 'unknown',
      ...(client?.version !== undefined ? { clientVersion: client.version } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
  };

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
    async ({ name, paths }, extra) =>
      runTool(() => ({ project: createProject(db, { name, paths }, mcpActor(extra.sessionId)) })),
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

  mcp.registerTool(
    'task_create',
    {
      title: 'Create task',
      description:
        'Create a Task with a title plus optional parent/project/tags/due/priority/effort/hidden_until/cwd. ' +
        'The owning project comes from an explicit project (name or id), which wins, or from cwd via ' +
        "longest-prefix match over the projects' bound paths; passing neither (or an unbound cwd) errors. " +
        'A parent must be a task in the same project — a task tree lives inside one project. ' +
        'New tasks start pending: status and deps are not supported yet and are rejected. ' +
        'Tags are normalized to lowercase and deduplicated.',
      inputSchema: {
        title: z.string().describe('short, imperative task title'),
        project: z
          .union([z.string(), z.number().int()])
          .optional()
          .describe('explicit project name or id; wins over cwd when both are given'),
        parent: z.number().int().optional().describe('id of the parent task (same project)'),
        tags: z.array(z.string()).optional().describe('lowercased and deduplicated on save'),
        due: z.string().optional().describe('ISO-8601 date or datetime'),
        priority: z.string().optional().describe('one of "H", "M", "L"'),
        effort: z.string().optional().describe('free-text effort estimate'),
        hidden_until: z.string().optional().describe('ISO-8601 datetime; hides the task from default views until then'),
        cwd: z.string().optional().describe("caller's working directory; resolved to the Current Project when no explicit project is given"),
        status: z.unknown().optional().describe('not supported yet: new tasks start pending (lifecycle changes come later)'),
        deps: z.unknown().optional().describe('not supported yet: dependencies ship with a later change'),
      },
    },
    async (args, extra) => runTool(() => ({ task: createTask(db, args, mcpActor(extra.sessionId)) })),
  );

  mcp.registerTool(
    'task_get',
    {
      title: 'Get task',
      description:
        'Read one task in full: all fields, a summary of its direct children (id, title, status) ordered by id, ' +
        'its annotations (newest first; append-only), and its recent changes (the last 20 change-log rows, ' +
        'newest first, with the actor that made each change).',
      inputSchema: {
        id: z.number().int().describe('task id'),
      },
    },
    async ({ id }) => runTool(() => getTask(db, id)),
  );

  mcp.registerTool(
    'task_update',
    {
      title: 'Update task',
      description:
        'Update a task: title, tags (replaces the set), due, priority, effort, hidden_until, and parent ' +
        '(reparenting within the same project; parent: null makes the task a root). ' +
        'Ancestor-cycle reparenting is rejected with the cycle path. ' +
        'Passing null clears an optional field; omitting a field leaves it unchanged. ' +
        'Not supported and rejected: status (task lifecycle comes later), project moves, deps.',
      inputSchema: {
        id: z.number().int().describe('task id'),
        title: z.string().optional(),
        tags: z.array(z.string()).optional().describe('full replacement tag set; lowercased and deduplicated'),
        due: z.string().nullable().optional().describe('ISO-8601 date or datetime; null clears'),
        priority: z.string().nullable().optional().describe('one of "H", "M", "L"; null clears'),
        effort: z.string().nullable().optional().describe('free-text estimate; null clears'),
        hidden_until: z.string().nullable().optional().describe('ISO-8601 datetime; null clears'),
        parent: z
          .number()
          .int()
          .nullable()
          .optional()
          .describe('new parent task id (same project); null makes this task a root'),
        status: z.unknown().optional().describe('not supported yet: status transitions come with the task lifecycle'),
        deps: z.unknown().optional().describe('not supported yet: dependencies ship with a later change'),
        project: z.unknown().optional().describe('not supported: moving a task between projects is rejected'),
      },
    },
    async ({ id, ...fields }, extra) => runTool(() => ({ task: updateTask(db, id, fields, mcpActor(extra.sessionId)) })),
  );

  mcp.registerTool(
    'task_annotate',
    {
      title: 'Annotate task',
      description:
        'Append a timestamped Annotation to a task — the channel for interim findings and progress that ' +
        'outlives a session. Annotations are append-only: they can never be edited or deleted, and each one ' +
        'records the actor (this client) that wrote it. Appending an annotation is not a task change and does ' +
        'not write a change-log entry.',
      inputSchema: {
        id: z.number().int().describe('task id'),
        body: z.string().min(1).describe('annotation text'),
      },
    },
    async ({ id, body }, extra) =>
      runTool(() => ({ annotation: appendAnnotation(db, id, body, mcpActor(extra.sessionId)) })),
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
    if (err instanceof ProjectError || err instanceof TaskError) {
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
    throw err; // unexpected — let the SDK surface it as a protocol error
  }
}
