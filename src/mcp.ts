import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import {
  createProject,
  listProjects,
  ProjectError,
  resolveCurrentProject,
} from './projects.js';
import { createTask, getTask, TaskError, updateTask } from './tasks.js';
import { transitionTaskStatus } from './lifecycle.js';
import type { Db } from './db.js';

/**
 * The MCP surface. ADR-0001: MCP is a thin adapter over the HTTP core, so
 * every tool maps 1:1 onto a core operation (src/projects.ts, src/tasks.ts,
 * src/lifecycle.ts) and returns the same JSON payload the HTTP route would;
 * domain failures surface as tool errors carrying the identical message text.
 *
 * Input schemas deliberately stay type-shaped (e.g. priority is a plain
 * string) instead of encoding domain rules: those checks live in the core
 * layer so MCP tool errors and HTTP error bodies share the same text. The
 * not-yet-supported arguments (deps, project-on-update) ARE declared
 * so they reach the core layer, which rejects them with a clear message
 * instead of zod silently stripping them.
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

  mcp.registerTool(
    'task_create',
    {
      title: 'Create task',
      description:
        'Create a Task with a title plus optional parent/project/tags/due/priority/effort/hidden_until/cwd. ' +
        'The owning project comes from an explicit project (name or id), which wins, or from cwd via ' +
        "longest-prefix match over the projects' bound paths; passing neither (or an unbound cwd) errors. " +
        'A parent must be a task in the same project — a task tree lives inside one project. ' +
        'New tasks start pending: status at create is rejected (use task_update, task_start, or task_done to move it); ' +
        'deps are not supported yet and are rejected. ' +
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
    async (args) => runTool(() => ({ task: createTask(db, args) })),
  );

  mcp.registerTool(
    'task_get',
    {
      title: 'Get task',
      description:
        'Read one task in full: all fields, a summary of its direct children (id, title, status) ordered by id, ' +
        'its recorded Intervals (spans of being active, oldest first), and totalActiveMs (total active time; ' +
        'an open Interval counts up to now).',
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
        'A provided status goes through the status machine: legal moves only — ' +
        'start (pending|waiting -> active), waiting (pending|active -> waiting), done (any non-done), ' +
        'drop (any non-dropped), reopen (done|dropped -> pending); same-status moves are rejected. ' +
        'Entering active opens an Interval, leaving active (or entering done/dropped) closes it. ' +
        'Passing null clears an optional field; omitting a field leaves it unchanged. ' +
        'Not supported and rejected: project moves, deps.',
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
        status: z
          .string()
          .optional()
          .describe(
            'target status ("pending", "active", "waiting", "done", "dropped"); validated against the status machine — illegal moves are rejected',
          ),
        deps: z.unknown().optional().describe('not supported yet: dependencies ship with a later change'),
        project: z.unknown().optional().describe('not supported: moving a task between projects is rejected'),
      },
    },
    async ({ id, ...fields }) => runTool(() => ({ task: updateTask(db, id, fields) })),
  );

  mcp.registerTool(
    'task_start',
    {
      title: 'Start task',
      description:
        'The start transition as a verb: pending or waiting -> active. Entering active opens an Interval ' +
        'automatically. Identical semantics and error messages to task_update with status "active" ' +
        '(an already-active task errors, since same-status transitions are rejected).',
      inputSchema: {
        id: z.number().int().describe('task id'),
      },
    },
    async ({ id }) => runTool(() => ({ task: transitionTaskStatus(db, id, 'active') })),
  );

  mcp.registerTool(
    'task_done',
    {
      title: 'Done task',
      description:
        'The done transition as a verb: any non-done status -> done, auto-closing any open Interval. ' +
        'Identical semantics and error messages to task_update with status "done" ' +
        '(an already-done task errors, since same-status transitions are rejected).',
      inputSchema: {
        id: z.number().int().describe('task id'),
      },
    },
    async ({ id }) => runTool(() => ({ task: transitionTaskStatus(db, id, 'done') })),
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
