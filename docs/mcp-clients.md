# MCP clients

Point any MCP host that speaks streamable HTTP at the endpoint. The URL is the only variable part; the daemon must be running before clients connect.

Generic shape used by most hosts:

```json
{
  "mcpServers": {
    "baton": {
      "type": "http",
      "url": "http://127.0.0.1:7600/mcp"
    }
  }
}
```

Hosts that spell the transport out explicitly (ZCode-style):

```json
{
  "mcpServers": {
    "baton": {
      "transport": "http",
      "url": "http://127.0.0.1:7600/mcp"
    }
  }
}
```

Each client initializes its own session (stateful streamable HTTP). The client identity is recorded as the Actor on every change and annotation, so "which session did this" stays answerable.

The 11 tools: `task_create`, `task_get`, `task_list`, `task_update`, `task_start`, `task_done`, `task_annotate`, `project_create`, `project_list`, `project_current`, `tag_list`.

Tool descriptions mirror the HTTP API (see [http-api.md](./http-api.md)); the query cookbook in [examples.md](./examples.md) applies to `task_list` verbatim.
