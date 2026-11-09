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
import { FILTER_FIELD_KEYS, listTags, queryTasks } from './query.js';
import { transitionTaskStatus } from './lifecycle.js';
import type { Db } from './db.js';

/**
 * The MCP surface. ADR-0001: MCP is a thin adapter over the HTTP core, so
 * every tool maps 1:1 onto a core operation (src/projects.ts, src/tasks.ts,
 * src/lifecycle.ts, src/annotations.ts) and returns the same JSON payload the HTTP route would;
 * domain failures surface as tool errors carrying the identical message text.
 *
 * Input schemas deliberately stay type-shaped (e.g. priority is a plain
 * string) instead of encoding domain rules: those checks live in the core
 * layer so MCP tool errors and HTTP error bodies share the same text. The
 * not-yet-supported argument (project-on-update) IS declared
 * so it reaches the core layer, which rejects it with a clear message
 * instead of zod silently stripping it.
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
        'Create a Task with a title plus optional parent/project/tags/deps/due/priority/effort/hidden_until/cwd. ' +
        'The owning project comes from an explicit project (name or id), which wins, or from cwd via ' +
        "longest-prefix match over the projects' bound paths; passing neither (or an unbound cwd) errors. " +
        'A parent must be a task in the same project — a task tree lives inside one project. ' +
        'deps name tasks this task depends on; each must exist and belong to the same project (dependencies never cross projects). ' +
        'New tasks start pending: status at create is rejected (use task_update, task_start, or task_done to move it). ' +
        'Tags are normalized to lowercase and deduplicated.',
      inputSchema: {
        title: z.string().describe('short, imperative task title'),
        project: z
          .union([z.string(), z.number().int()])
          .optional()
          .describe('explicit project name or id; wins over cwd when both are given'),
        parent: z.number().int().optional().describe('id of the parent task (same project)'),
        tags: z.array(z.string()).optional().describe('lowercased and deduplicated on save'),
        deps: z
          .array(z.number().int())
          .optional()
          .describe('ids of tasks this task depends on (same project only); sorted and deduplicated on save'),
        due: z.string().optional().describe('ISO-8601 date or datetime'),
        priority: z.string().optional().describe('one of "H", "M", "L"'),
        effort: z.string().optional().describe('free-text effort estimate'),
        hidden_until: z.string().optional().describe('ISO-8601 datetime; hides the task from default views until then'),
        cwd: z.string().optional().describe("caller's working directory; resolved to the Current Project when no explicit project is given"),
        status: z.unknown().optional().describe('not supported yet: new tasks start pending (lifecycle changes come later)'),
      },
    },
    async (args, extra) => runTool(() => ({ task: createTask(db, args, mcpActor(extra.sessionId)) })),
  );

  mcp.registerTool(
    'task_get',
    {
      title: 'Get task',
      description:
        'Read one task in full: all fields — including its dependency ids (deps), the derived blocked flag ' +
        '(true while any dependency is neither done nor dropped; advisory only), and the derived progress ' +
        '(done descendants ÷ non-dropped descendants; null when there is nothing below the task) — ' +
        'a summary of its direct children (id, title, status) ordered by id, ' +
        'its recorded Intervals (spans of being active, oldest first), totalActiveMs (total active time; ' +
        'an open Interval counts up to now), its annotations (newest first; append-only), and its recent ' +
        'changes (the last 20 change-log rows, newest first, with the actor that made each change).',
      inputSchema: {
        id: z.number().int().describe('task id'),
      },
    },
    async ({ id }) => runTool(() => getTask(db, id)),
  );

  mcp.registerTool(
    'task_list',
    {
      title: 'List tasks',
      description:
        'List tasks through the query model: a quick view (view: "current" | "today" | "blocked" | "all") ' +
        'OR a structured filter (the filter fields below, combined with AND), plus an optional cwd. ' +
        'current = open tasks of the cwd-resolved Current Project; today = open tasks due today or overdue; ' +
        'blocked = open and blocked; all = everything with no default exclusions. ' +
        'Every view and filter except "all" (and any filter naming statuses) excludes done, dropped, and ' +
        'tasks whose hidden_until is still in the future; naming statuses explicitly (e.g. status: "done") ' +
        'returns exactly those. Default ordering: due ascending (no due last) -> priority descending ' +
        '(H > M > L, none last) -> id ascending; sort and limit override (sort entries are field names or ' +
        '{field, direction} with direction "asc"|"desc"). ' +
        'Scope: an explicit project wins; otherwise a resolvable cwd scopes the query to that project; ' +
        'an absent or unbound cwd lists the whole store with a note in scope.note. ' +
        'The response is {tasks: [task views], scope: {project: {id, name} | null, note?}} — ' +
        'identical to GET /tasks on the HTTP API.',
      inputSchema: {
        view: z.string().optional().describe('quick view: "current", "today", "blocked", or "all"'),
        cwd: z.string().optional().describe("caller's working directory; scopes the query to the Current Project it resolves to"),
        status: z.union([z.string(), z.array(z.string())]).optional().describe('status or array of statuses ("pending", "active", "waiting", "done", "dropped")'),
        project: z.union([z.string(), z.number()]).optional().describe('project name or id; wins over cwd'),
        tags: z.array(z.string()).optional().describe('tags the tasks must carry (lowercased before matching)'),
        tagMode: z.string().optional().describe('"any" (default: at least one tag matches) or "all" (every tag must be carried)'),
        parent: z.number().optional().describe('task id; only this parent\'s direct children match'),
        hasParent: z.boolean().optional().describe('false lists root tasks only; true lists non-roots'),
        blocked: z.boolean().optional().describe('filter on the derived blocked flag (some dependency is neither done nor dropped)'),
        dueBefore: z.string().optional().describe('ISO-8601 date or datetime; inclusive; tasks without a due date never match'),
        dueAfter: z.string().optional().describe('ISO-8601 date or datetime; inclusive; tasks without a due date never match'),
        priority: z.union([z.string(), z.array(z.string())]).optional().describe('priority or array: "H", "M", "L"'),
        text: z.string().optional().describe('case-insensitive title substring'),
        sort: z
          .union([
            z.string(),
            z.array(z.union([z.string(), z.object({ field: z.string(), direction: z.string().optional() })])),
          ])
          .optional()
          .describe('field name, {field, direction}, or an array of them; fields: due, priority, id, title, status, createdAt, updatedAt'),
        limit: z.number().optional().describe('return at most this many tasks (after sorting)'),
      },
    },
    async (args) =>
      runTool(() => {
        // Thin adapter: the flat tool arguments become the core's
        // {view, filter, cwd} input — only the filter fields actually present.
        const { view, cwd, ...rest } = args as Record<string, unknown>;
        const filter: Record<string, unknown> = {};
        for (const key of FILTER_FIELD_KEYS) {
          if (rest[key] !== undefined) {
            filter[key] = rest[key];
          }
        }
        return queryTasks(db, {
          ...(view !== undefined ? { view } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          ...(Object.keys(filter).length > 0 ? { filter } : {}),
        });
      }),
  );

  mcp.registerTool(
    'task_update',
    {
      title: 'Update task',
      description:
        'Update a task: title, tags (replaces the set), due, priority, effort, hidden_until, parent ' +
        '(reparenting within the same project; parent: null makes the task a root), and deps ' +
        '(replaces the dependency set; deps: null or [] clears it). Dependencies must reference tasks in the ' +
        'same project, cannot include the task itself, and must keep the graph a DAG — cycle-forming dep sets ' +
        'are rejected with the offending path. ' +
        'Ancestor-cycle reparenting is rejected with the cycle path. ' +
        'A provided status goes through the status machine: legal moves only — ' +
        'start (pending|waiting -> active), waiting (pending|active -> waiting), done (any non-done), ' +
        'drop (any non-dropped), reopen (done|dropped -> pending); same-status moves are rejected. ' +
        'Entering active opens an Interval, leaving active (or entering done/dropped) closes it. ' +
        'Passing null clears an optional field; omitting a field leaves it unchanged. ' +
        'Not supported and rejected: project moves.',
      inputSchema: {
        id: z.number().int().describe('task id'),
        title: z.string().optional(),
        tags: z.array(z.string()).optional().describe('full replacement tag set; lowercased and deduplicated'),
        deps: z
          .array(z.number().int())
          .nullable()
          .optional()
          .describe('full replacement dependency set (task ids, same project only); null or [] clears'),
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
    async ({ id }, extra) => runTool(() => ({ task: transitionTaskStatus(db, id, 'active', mcpActor(extra.sessionId)) })),
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
    async ({ id }, extra) => runTool(() => ({ task: transitionTaskStatus(db, id, 'done', mcpActor(extra.sessionId)) })),
  );

  mcp.registerTool(
    'tag_list',
    {
      title: 'List tags',
      description:
        'Every tag in use across the store with the count of tasks carrying it (all statuses — a tag ' +
        'carried only by done or dropped tasks still appears) — the vocabulary for tag filters, so they ' +
        'do not misspell into oblivion. Response: {tags: [{tag, count}]}, sorted by tag.',
    },
    async () => runTool(() => listTags(db)),
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
