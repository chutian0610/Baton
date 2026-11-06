/**
 * The Actor (CONTEXT.md): the provenance recorded on every change — which
 * MCP client (and agent session, when known) performed it, or `http` for
 * direct calls against the HTTP JSON API.
 *
 * An Actor is a plain value threaded from the surface (HTTP route / MCP tool
 * handler) down into the core layer as a parameter. Nothing here reads
 * globals: each surface decides the actor at its boundary, where the request
 * metadata actually lives.
 */

/** Direct HTTP JSON API calls always record this constant actor. */
export const HTTP_ACTOR: Actor = { kind: 'http' };

export type Actor = HttpActor | McpActor;

export interface HttpActor {
  kind: 'http';
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
