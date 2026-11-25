# The Web UI (the human surface)

Start the daemon and open [http://127.0.0.1:7600/ui](http://127.0.0.1:7600/ui) — the Web UI is served by the daemon itself, on the same port as the HTTP API and MCP endpoint (ADR-0006: one daemon, no extra process, port, or lifecycle).

## Who it is for

Baton's surfaces each have one audience (ADR-0006, `CONTEXT.md` → Surface): agents write and read over MCP; scripts and curl use the HTTP JSON API; the **Web UI is the human's window into the shared store** — and the human's direct write path for corrections (drop a junk task, close finished work, fix a field) without detouring through conversation with an agent.

## Views

Three entry views sit above the task tree, plus an explicit **project picker**:

- **Open** — every open task across the store (Unbound ones included; capture-first)
- **Today** — open tasks due today or overdue
- **Blocked** — open tasks whose derived `blocked` flag is true

A browser has no working directory, so **Current Project resolution does not apply** to the Web UI: scoping is the picker's explicit selection — All projects / Unbound / one project — remembered across reloads.

### Visibility toggles

The default views hide `done`, `dropped`, and tasks whose `hidden_until` is still in the future — rules built for an agent's attention, not a supervisor's. The toggles re-add each set on top of any view, with live counts and distinguishing badges, so agent decisions never erase information from the observer: **show done**, **show dropped**, **show hidden**.

## Task detail

Click any task (or deep-link straight to `/ui/tasks/<id>`) for the audit window:

- every stored field (status, project/Unbound, priority, effort, due, hidden-until, parent, tags), derived `blocked` and parent `progress`
- **dependencies read-only** with their status and blocked state
- the **annotation timeline**, newest first, attributed to its Actor
- **intervals** — every recorded span of the task being active, plus total active time
- the **change log** — what changed, when, and which surface did it: `web` (this UI), `http` (curl/scripts), or `mcp (<client name>)` (an agent session). The first 100 rows load with the page; older history loads on demand.

The window re-polls every few seconds, so an agent mutating the task mid-audit is visible without re-navigation.

## Writes

The UI writes like any other surface — every change is recorded in the change log under the `web` Actor:

- **Create** — title plus optional fields; defaults Unbound; when the picker scopes a project, that project is the assignment. No parent input.
- **Edit fields** — title, tags, priority, effort, due, hidden-until.
- **Status transitions** — only the machine-legal targets are offered (the daemon validates; `ui/src/transitions.ts` mirrors the matrix).
- **Annotate** — append-only, like every annotation.

**Structural editing — reparenting, dependency editing, project re-binding/cascade — is deliberately absent.** Trees and dependency DAGs are agent work over MCP; a browser DAG editor costs more than it buys (ADR-0006).

## Security posture

- The daemon binds `127.0.0.1` only; there is no token — same-user, single-machine (unchanged since v1).
- Every request bearing an **`Origin` header that does not match the request's `Host` is rejected with 403**, uniformly across all routes including `/mcp` — the drive-by guard a browser surface requires. curl and MCP clients send no `Origin` and are unaffected; `null` origins fail closed.
- No CORS headers are served: pages on other origins cannot read the API either.

## Refresh

The UI polls `GET /tasks?view=all` every few seconds and derives the views client-side. Polling pauses while the tab is hidden. There is no event stream — hooks/events remain deferred (spec: revisit when a real pain appears).
