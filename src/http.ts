import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer } from './mcp.js';
import { createProject, listProjects, ProjectError, resolveCurrentProject } from './projects.js';
import type { Db } from './db.js';

/**
 * Plain node:http routing (ADR-0001; no framework — the SDK transport takes
 * Node req/res natively and the routes are few):
 *
 *   GET  /healthz           -> 200 {"status":"ok"}
 *   POST /projects          -> 201 project (name + bound paths)
 *   GET  /projects          -> 200 all projects with paths + open-task counts
 *   GET  /projects/current  -> 200 resolve ?cwd= to the Current Project
 *   *    /mcp               -> MCP streamable HTTP transport (stateful sessions)
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
        const project = createProject(db, body);
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
