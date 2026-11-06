import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from './db.js';

/**
 * The MCP surface. ADR-0001: MCP is a thin adapter over the HTTP core, so
 * every tool maps 1:1 onto core operations. Later tickets register the real
 * 11-tool surface here; for now `ping` proves the mount end-to-end.
 *
 * A fresh McpServer is built per MCP session (a server instance owns one
 * transport); the Db handle is shared across sessions and owned by the daemon.
 */
export function buildMcpServer(db: Db): McpServer {
  const mcp = new McpServer({ name: 'baton', version: '0.1.0' });

  // Placeholder tracer-round tool; real tools arriving from ticket #3 on will
  // use `db` (kept in scope for that reason).
  void db;
  mcp.registerTool(
    'ping',
    {
      title: 'Ping',
      description: 'Tracer-round placeholder: replies with a static string to prove the MCP mount works.',
    },
    async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }),
  );

  return mcp;
}
