import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer } from './mcp.js';
import { HTTP_ACTOR } from './actors.js';
import { appendAnnotation } from './annotations.js';
import { transitionTaskStatus } from './lifecycle.js';
import { createProject, listProjects, ProjectError, resolveCurrentProject } from './projects.js';
import { queryTasks } from './query.js';
import { createTask, getTask, TaskError, updateTask } from './tasks.js';
import type { Db } from './db.js';

/**
 * Plain node:http routing (ADR-0001; no framework — the SDK transport takes
 * Node req/res natively and the routes are few):
 *
 *   GET  /healthz                 -> 200 {"status":"ok"}
 *   POST /projects                -> 201 project (name + bound paths)
 *   GET  /projects                -> 200 all projects with paths + open-task counts
 *   GET  /projects/current        -> 200 resolve ?cwd= to the Current Project
 *   POST /tasks                   -> 201 task (project explicit or resolved from cwd)
 *   GET  /tasks                   -> 200 {tasks, scope} (query: ?view= quick view or
 *                                    ?filter= URL-encoded JSON filter, plus optional ?cwd=)
 *   GET  /tasks/:id               -> 200 task + children + intervals + annotations + recent changes
 *   PATCH /tasks/:id              -> 200 updated task (fields/reparent; status via the machine)
 *   POST /tasks/:id/start         -> 200 task (start verb: pending|waiting -> active)
 *   POST /tasks/:id/done          -> 200 task (done verb: any non-done -> done)
 *   POST /tasks/:id/annotations   -> 201 annotation (append-only; no edit/delete route)
 *   GET  /tasks/:id/annotations   -> 200 annotations, newest first
 *   *    /mcp                     -> MCP streamable HTTP transport (stateful sessions)
 *
 * Direct HTTP calls record the constant Actor {kind: "http"} (src/actors.ts)
 * on every change and annotation they cause.
 *
 * Stateful session handling follows the SDK's canonical wiring: one
 * StreamableHTTPServerTransport (plus a fresh McpServer) per initialize; the
 * session id comes back in the `Mcp-Session-Id` header and must be echoed by
 * the client on subsequent requests.
 */
export interface BatonHttpServer {
  httpServer: Server;
  /** Closes every live MCP session transport. Call before closing the HTTP server. */
  closeMcpSessions: () => Promise<void>;
}

export function createBatonHttpServer({ db }: { db: Db }): BatonHttpServer {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, db, sessions).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
      process.stderr.write(`request handler failed: ${(err as Error)?.stack ?? err}\n`);
    });
  });

  return {
    httpServer,
    closeMcpSessions: async () => {
      await Promise.allSettled([...sessions.values()].map((transport) => transport.close()));
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  db: Db,
  sessions: Map<string, StreamableHTTPServerTransport>,
): Promise<void> {
  const path = (req.url ?? '').split('?')[0];

  if (path === '/healthz') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (path === '/projects' || path === '/projects/current') {
    await handleProjectsRoute(req, res, db, path);
    return;
  }

  if (path === '/tasks' || path.startsWith('/tasks/')) {
    await handleTasksRoute(req, res, db, path);
    return;
  }

  if (path !== '/mcp') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const rawSessionId = req.headers['mcp-session-id'];
  const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    const transport = sessionId ? sessions.get(sessionId) : undefined;
    if (transport) {
      await transport.handleRequest(req, res, body); // body stream already consumed; pass it through
      return;
    }
    if (!sessionId && isInitializeRequest(body)) {
      const newTransport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          sessions.set(id, newTransport);
        },
      });
      newTransport.onclose = () => {
        const id = newTransport.sessionId;
        if (id) sessions.delete(id);
      };
      const mcpServer = buildMcpServer(db);
      await mcpServer.connect(newTransport);
      await newTransport.handleRequest(req, res, body);
      return;
    }
    res.writeHead(sessionId ? 404 : 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: sessionId ? 'unknown or expired session' : 'missing session: initialize first' }));
    return;
  }

  // GET (standalone SSE stream) and DELETE (session termination) route to the
  // existing session's transport; JSON-response mode answers GET with 405.
  const transport = sessionId ? sessions.get(sessionId) : undefined;
  if (transport) {
    await transport.handleRequest(req, res);
    return;
  }
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'missing or unknown session id' }));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const JSON_HEADERS = { 'content-type': 'application/json' };

/** Treat a missing or empty query param as absent (?view= is the same as no view). */
function nonEmptyParam(value: string | null): string | undefined {
  return value === null || value === '' ? undefined : value;
}

async function handleProjectsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  db: Db,
  path: string,
): Promise<void> {
  if (path === '/projects') {
    if (req.method === 'POST') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        res.writeHead(400, JSON_HEADERS);
        res.end(JSON.stringify({ error: 'invalid JSON body' }));
        return;
      }
      try {
        const project = createProject(db, body, HTTP_ACTOR);
        res.writeHead(201, JSON_HEADERS);
        res.end(JSON.stringify({ project }));
      } catch (err) {
        sendProjectError(res, err);
      }
      return;
    }
    if (req.method === 'GET') {
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({ projects: listProjects(db) }));
      return;
    }
    res.writeHead(405, { allow: 'GET, POST', ...JSON_HEADERS });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  // path === '/projects/current': resolve ?cwd=... to the Current Project.
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET', ...JSON_HEADERS });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }
  const cwd = new URL(req.url ?? '/', 'http://localhost').searchParams.get('cwd');
  try {
    const current = resolveCurrentProject(db, cwd);
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify(current));
  } catch (err) {
    sendProjectError(res, err);
  }
}

/** Maps a ProjectError onto an HTTP status + `{"error": message}` body; rethrows anything else. */
function sendProjectError(res: ServerResponse, err: unknown): void {
  if (!(err instanceof ProjectError)) {
    throw err; // unexpected — let the top-level 500 handler deal with it
  }
  const status = err.code === 'duplicate' ? 409 : err.code === 'unbound' ? 404 : 400;
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify({ error: err.message }));
}

/**
 * Task routes. Same conventions as the projects routes: 201 on create, 200 on
 * read/update, and TaskError codes map to `invalid` -> 400,
 * `not-found`/`unbound` -> 404, `conflict`/`unsupported` -> 409.
 */
async function handleTasksRoute(
  req: IncomingMessage,
  res: ServerResponse,
  db: Db,
  path: string,
): Promise<void> {
  if (path === '/tasks') {
    if (req.method === 'POST') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        res.writeHead(400, JSON_HEADERS);
        res.end(JSON.stringify({ error: 'invalid JSON body' }));
        return;
      }
      try {
        const task = createTask(db, body, HTTP_ACTOR);
        res.writeHead(201, JSON_HEADERS);
        res.end(JSON.stringify({ task }));
      } catch (err) {
        sendTaskError(res, err);
      }
      return;
    }
    if (req.method === 'GET') {
      // The query model (src/query.ts): a quick view or a JSON filter, plus an
      // optional cwd — the same core read the MCP task_list tool uses.
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
      const view = nonEmptyParam(params.get('view'));
      const cwd = nonEmptyParam(params.get('cwd'));
      const filterRaw = params.get('filter');
      let filter: unknown;
      if (filterRaw !== null) {
        try {
          filter = JSON.parse(filterRaw);
        } catch {
          res.writeHead(400, JSON_HEADERS);
          res.end(JSON.stringify({ error: `filter must be a URL-encoded JSON object, got: ${filterRaw}` }));
          return;
        }
      }
      try {
        const result = queryTasks(db, {
          ...(view !== undefined ? { view } : {}),
          ...(filter !== undefined ? { filter } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
        });
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify(result));
      } catch (err) {
        sendTaskError(res, err);
      }
      return;
    }
    res.writeHead(405, { allow: 'GET, POST', ...JSON_HEADERS });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  const rest = path.slice('/tasks/'.length);
  const segments = rest.split('/');

  // Sub-resource routes: annotations are append-only, so only POST (append)
  // and GET (list) exist — edit/delete attempts get a 405 naming what is
  // allowed, and deeper paths (e.g. /annotations/:aid) do not exist at all.
  if (segments.length === 2 && segments[1] === 'annotations') {
    await handleAnnotationsRoute(req, res, db, segments[0]);
    return;
  }

  // Verb endpoints (spec: start/done get verb-shaped calls; they map onto the
  // same status machine as PATCH {status}, so successes and errors are
  // identical for the same task and situation).
  if (segments.length === 2 && (segments[1] === 'start' || segments[1] === 'done')) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', ...JSON_HEADERS });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    try {
      const task = transitionTaskStatus(db, segments[0], segments[1] === 'start' ? 'active' : 'done', HTTP_ACTOR);
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({ task }));
    } catch (err) {
      sendTaskError(res, err);
    }
    return;
  }

  if (rest === '' || rest.includes('/')) {
    res.writeHead(404, JSON_HEADERS);
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  const id = rest;

  if (req.method === 'GET') {
    try {
      const detail = getTask(db, id);
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify(detail));
    } catch (err) {
      sendTaskError(res, err);
    }
    return;
  }
  if (req.method === 'PATCH') {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      res.writeHead(400, JSON_HEADERS);
      res.end(JSON.stringify({ error: 'invalid JSON body' }));
      return;
    }
    try {
      const task = updateTask(db, id, body, HTTP_ACTOR);
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({ task }));
    } catch (err) {
      sendTaskError(res, err);
    }
    return;
  }
  res.writeHead(405, { allow: 'GET, PATCH', ...JSON_HEADERS });
  res.end(JSON.stringify({ error: 'method not allowed' }));
}

/**
 * Annotation sub-resource of a task. Append-only by construction: POST
 * appends (carrying the constant HTTP actor), GET lists; every other method
 * is a 405 naming the allowed ones — no edit or delete route exists.
 */
async function handleAnnotationsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  db: Db,
  id: string,
): Promise<void> {
  if (req.method === 'POST') {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      res.writeHead(400, JSON_HEADERS);
      res.end(JSON.stringify({ error: 'invalid JSON body' }));
      return;
    }
    const text = (typeof body === 'object' && body !== null ? (body as { body?: unknown }).body : undefined);
    try {
      const annotation = appendAnnotation(db, id, text, HTTP_ACTOR);
      res.writeHead(201, JSON_HEADERS);
      res.end(JSON.stringify({ annotation }));
    } catch (err) {
      sendTaskError(res, err);
    }
    return;
  }
  if (req.method === 'GET') {
    try {
      // route through getTask so unknown ids keep the exact task error text
      const detail = getTask(db, id);
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({ annotations: detail.annotations }));
    } catch (err) {
      sendTaskError(res, err);
    }
    return;
  }
  res.writeHead(405, { allow: 'GET, POST', ...JSON_HEADERS });
  res.end(JSON.stringify({ error: 'method not allowed' }));
}

/** Maps a TaskError onto an HTTP status + `{"error": message}` body; rethrows anything else. */
function sendTaskError(res: ServerResponse, err: unknown): void {
  if (!(err instanceof TaskError)) {
    throw err; // unexpected — let the top-level 500 handler deal with it
  }
  const status =
    err.code === 'invalid' ? 400 : err.code === 'not-found' || err.code === 'unbound' ? 404 : 409;
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify({ error: err.message }));
}
