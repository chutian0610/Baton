/**
 * The Actor (CONTEXT.md): the provenance recorded on every change — which
 * surface performed it: an MCP client (and agent session, when known), the
 * bundled Web UI (`web`), or a direct HTTP caller (`http`).
 *
 * An Actor is a plain value threaded from the surface (HTTP route / MCP tool
 * handler) down into the core layer as a parameter. Nothing here reads
 * globals: each surface decides the actor at its boundary, where the request
 * metadata actually lives.
 */

/** Direct HTTP JSON API calls without an Origin header (curl, scripts) record this constant actor. */
export const HTTP_ACTOR: Actor = { kind: 'http' };

/** Requests arriving with a passing browser Origin header (the Web UI) record this actor. */
export const WEB_ACTOR: Actor = { kind: 'web' };

export type Actor = HttpActor | McpActor | WebActor;

export interface HttpActor {
  kind: 'http';
}

export interface WebActor {
  kind: 'web';
}

/**
 * MCP calls record the handshake's clientInfo (name/version, via
 * `McpServer.server.getClientVersion()`, populated after initialize) plus the
 * session identifier from the tool handler's `extra` when the transport
 * exposes one (stateful sessions do).
 */
export interface McpActor {
  kind: 'mcp';
  clientName: string;
  clientVersion?: string;
  sessionId?: string;
}
