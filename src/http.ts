import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer } from './mcp.js';
import { HTTP_ACTOR, WEB_ACTOR, type Actor } from './actors.js';
import { appendAnnotation } from './annotations.js';
import { listChanges } from './changelog.js';
import { display } from './internal.js';
import { transitionTaskStatus } from './lifecycle.js';
import { createProject, listProjects, ProjectError, resolveCurrentProject } from './projects.js';
import { queryTasks } from './query.js';
import { createTask, getTask, requireTaskId, requireTaskRow, TaskError, updateTask } from './tasks.js';
import type { Db } from './db.js';

/**
 * Plain node:http routing (ADR-0001; no framework — the SDK transport takes
 * Node req/res natively and the routes are few):
 *
 *   GET  /healthz                 -> 200 {"status":"ok"}
 *   POST /projects                -> 201 project (name + bound paths)
 *   GET  /projects                -> 200 all projects with paths + open-task counts
 *   GET  /projects/current        -> 200 resolve ?cwd= to the Current Project
 *   POST /tasks                   -> 201 task (project optional; capture-first,
 *                                    absent/null leaves the task Unbound)
 *   GET /tasks                    -> 200 {tasks, note?} (query: ?view= quick view or
 *                                    ?filter= URL-encoded JSON filter, plus optional
 *                                    ?cwd= — consulted only by view=current)
 *   GET  /tasks/:id               -> 200 task + children + intervals + annotations + recent changes
 *   PATCH /tasks/:id              -> 200 updated task (fields/reparent; status via the machine)
 *   POST /tasks/:id/start         -> 200 task (start verb: pending|waiting -> active)
 *   POST /tasks/:id/done          -> 200 task (done verb: any non-done -> done)
 *   POST /tasks/:id/annotations   -> 201 annotation (append-only; no edit/delete route)
 *   GET  /tasks/:id/annotations   -> 200 annotations, newest first
 *   GET  /tasks/:id/changes       -> 200 {changes, total}: the FULL change history,
 *                                    newest first, paged (?limit= default 100, ?offset= 0)
 *   GET  /ui, /ui/*               -> the built Web UI bundle (ADR-0006): static files
 *                                    under dist/ui, any other /ui/* path falls back to
 *                                    index.html (client-side routing owns unknown paths)
 *   *    /mcp                     -> MCP streamable HTTP transport (stateful sessions)
 *
 * Origin/Host check (ADR-0006, v0.3 T1): every request bearing an Origin
 * header whose authority differs from the request's Host is 403-rejected
 * before routing — the drive-by/CSRF guard a browser surface introduces.
 * curl and MCP clients send no Origin and are unaffected.
 *
 * Direct HTTP calls record Actor {kind: "http"} (src/actors.ts) on every
 * change and annotation they cause; requests arriving with a passing Origin
 * header — the bundled Web UI — record {kind: "web"}.
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
  // The drive-by/CSRF guard (ADR-0006): a browser page anywhere on the web
  // can fire requests at a localhost daemon; reads are already CORS-blocked,
  // writes would not be. Uniform across every route — there are no exempt
  // paths. curl and MCP clients send no Origin and sail through.
  if (crossOrigin(req)) {
    res.writeHead(403, JSON_HEADERS);
    res.end(JSON.stringify({ error: 'cross-origin request rejected: the Origin header does not match the request Host' }));
    return;
  }

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

  if (path === '/ui' || path.startsWith('/ui/')) {
    await handleUiRoute(req, res, path);
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

function firstHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * True when the request carries an Origin header that does not belong to this
 * server. Comparison is authority-only (host[:port], case-insensitive) against
 * the request's own Host header — exactly what a browser guarantees for
 * same-origin requests, whatever hostname was used to reach the daemon. An
 * unparseable Origin (including the literal "null", e.g. sandboxed iframes)
 * and a missing Host alongside an Origin both fail closed.
 */
function crossOrigin(req: IncomingMessage): boolean {
  const origin = firstHeader(req, 'origin');
  if (origin === undefined) {
    return false;
  }
  const host = firstHeader(req, 'host');
  if (host === undefined) {
    return true;
  }
  let originAuthority: string;
  try {
    originAuthority = new URL(origin).host;
  } catch {
    return true; // "null" and other non-URL origins are never same-origin
  }
  return originAuthority.toLowerCase() !== host.toLowerCase();
}

/**
 * Actor classification for the JSON API surface (v0.3 T1): a passing Origin
 * header means the request came from a browser (the bundled Web UI is the
 * only same-origin browser client on a localhost daemon) — record `web`;
 * without one it is a direct HTTP call — record the constant `http`.
 */
function httpSurfaceActor(req: IncomingMessage): Actor {
  return firstHeader(req, 'origin') !== undefined ? WEB_ACTOR : HTTP_ACTOR;
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

/**
 * The Web UI bundle (ADR-0006/0007): the built SPA lives in dist/ui/, next to
 * this compiled file — the same relative layout ships in the npm package, so
 * the resolution works identically in a checkout and a global install.
 */
const UI_ROOT = fileURLToPath(new URL('./ui', import.meta.url));

const UI_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * GET/HEAD /ui and /ui/*: serve files from the built bundle. Any path that
 * does not resolve to a file falls back to index.html — client-side routing
 * owns unknown URLs (SPA semantics). URL-decoding happens before the
 * containment check, so %2e%2e-style traversal escapes are refused with a
 * 404. When even index.html is missing, the bundle was not built: say so.
 */
async function handleUiRoute(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', ...JSON_HEADERS });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path.slice('/ui'.length));
  } catch {
    res.writeHead(404, JSON_HEADERS);
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  const absolute = resolve(UI_ROOT, decoded.replace(/^\/+/, ''));
  if (absolute !== UI_ROOT && !absolute.startsWith(UI_ROOT + sep)) {
    res.writeHead(404, JSON_HEADERS);
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  let target = absolute;
  try {
    const stats = await stat(target);
    if (stats.isDirectory()) {
      target = join(target, 'index.html');
    } else if (!stats.isFile()) {
      throw new Error('not a regular file');
    }
  } catch {
    target = join(UI_ROOT, 'index.html'); // SPA fallback: the shell renders unknown paths
  }
  try {
    const content = await readFile(target);
    // Cache contract: index.html (the shell and every SPA fallback) must
    // always be revalidated — it is what points at the content-hashed asset
    // bundles. Hashed assets never change content, so they cache forever.
    const isShell = basename(target) === 'index.html';
    const cacheControl = isShell ? 'no-cache' : 'public, max-age=31536000, immutable';
    res.writeHead(200, {
      'content-type': UI_CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
      'content-length': content.length,
      'cache-control': cacheControl,
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch {
    res.writeHead(404, JSON_HEADERS);
    res.end(JSON.stringify({ error: 'ui bundle not found — run npm run build to produce dist/ui' }));
  }
}

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
        const project = createProject(db, body, httpSurfaceActor(req));
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

/**
 * The one code -> HTTP status table for the domain errors: ProjectError and
 * TaskError carry their own code vocabularies, but the statuses they map to
 * are these and only these (`invalid` -> 400, `not-found`/`unbound` -> 404,
 * `conflict`/`unsupported`/`duplicate` -> 409). Both error senders below are
 * driven from this map so the two surfaces can never drift apart.
 */
const DOMAIN_ERROR_STATUS: Record<string, number> = {
  invalid: 400,
  unbound: 404,
  'not-found': 404,
  duplicate: 409,
  conflict: 409,
  unsupported: 409,
};

/** Writes the mapped status + `{"error": message}` body for a domain error code. */
function sendDomainError(res: ServerResponse, code: string, message: string): void {
  res.writeHead(DOMAIN_ERROR_STATUS[code] ?? 400, JSON_HEADERS);
  res.end(JSON.stringify({ error: message }));
}

/** Maps a ProjectError onto an HTTP status + `{"error": message}` body; rethrows anything else. */
function sendProjectError(res: ServerResponse, err: unknown): void {
  if (!(err instanceof ProjectError)) {
    throw err; // unexpected — let the top-level 500 handler deal with it
  }
  sendDomainError(res, err.code, err.message);
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
        const task = createTask(db, body, httpSurfaceActor(req));
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

  // Full change history (spec user story 32: audit "what agents did"): the
  // whole change log for one task, newest first, paged — task_get's
  // recentChanges stays the capped 20-row peek.
  if (segments.length === 2 && segments[1] === 'changes') {
    await handleChangesRoute(req, res, db, segments[0]);
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
      const task = transitionTaskStatus(db, segments[0], segments[1] === 'start' ? 'active' : 'done', httpSurfaceActor(req));
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
      const task = updateTask(db, id, body, httpSurfaceActor(req));
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
 * Change-history sub-resource of a task. GET pages through the task's full
 * change log, newest first: ?limit= (default 100, minimum 1) and ?offset=
 * (default 0, minimum 0); malformed paging values are 400s. Unknown tasks
 * keep the exact task error text (404). The payload is {changes, total},
 * with `total` counting every row across pages.
 */
async function handleChangesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  db: Db,
  id: string,
): Promise<void> {
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET', ...JSON_HEADERS });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }
  const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  try {
    const taskId = requireTaskId(id);
    requireTaskRow(db, taskId);
    const limit = pageParam(nonEmptyParam(params.get('limit')), 'limit', 100, 1);
    const offset = pageParam(nonEmptyParam(params.get('offset')), 'offset', 0, 0);
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify(listChanges(db, 'task', taskId, limit, offset)));
  } catch (err) {
    sendTaskError(res, err);
  }
}

/** Parses a paging query param (?limit/?offset) into an integer >= min; absent/empty means the default. */
function pageParam(raw: string | undefined, field: string, fallback: number, min: number): number {
  if (raw === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(raw) || Number(raw) < min) {
    throw new TaskError('invalid', `${field} must be an integer >= ${min}, got: ${display(raw)}`);
  }
  return Number(raw);
}

/**
 * Annotation sub-resource of a task. Append-only by construction: POST
 * appends (carrying the classified HTTP-surface actor — `web` with a passing
 * Origin header, `http` otherwise), GET lists; every other method
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
      const annotation = appendAnnotation(db, id, text, httpSurfaceActor(req));
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
  sendDomainError(res, err.code, err.message);
}
