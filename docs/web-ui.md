# The Web UI (the human surface)

Start the daemon and open [http://127.0.0.1:7600/ui](http://127.0.0.1:7600/ui) — the Web UI is served by the daemon itself, on the same port as the HTTP API and MCP endpoint (ADR-0006: one daemon, no extra process, port, or lifecycle).

## Who it is for

Baton's surfaces each have one audience (ADR-0006, `CONTEXT.md` → Surface): agents write and read over MCP; scripts and curl use the HTTP JSON API; the **Web UI is the human's window into the shared store** — and the human's direct write path for capture and corrections, without detouring through conversation with an agent.

## Layout

Three panes (Todoist-style, light):

- **Sidebar** — the three views with live counts (**Open / Today / Blocked**) and the **Projects** section (All projects / Unbound / each project with a stable color dot and its open-task count). Selecting here is the scope for everything to the right.
- **Main list** — a quick-add bar, a slim toggle row, and the **task tree**.
- **Detail panel** — clicking a task's title (or deep-linking to `/ui/tasks/<id>`) slides in the audit window next to the list; `✕` closes it.

## Views and scoping

The list header carries **status tabs** (GitHub issues style): **Open** (aggregating `pending` + `active` + `waiting` — the glossary's open set), **Done**, and **Dropped**, each with a live count. The **Status ▾** dropdown beside them multi-selects the Open tab's individual statuses (with colored dots and counts) and carries the **Show hidden** switch. The sidebar keeps the special views — **Today** (open tasks due today or overdue) and **Blocked** (open tasks whose derived `blocked` flag is true) — which are fixed composites that ignore the tabs.

A browser has no working directory, so **Current Project resolution does not apply** to the Web UI: scoping is the sidebar's explicit selection, remembered across reloads.

### Hidden gating and search

Tasks whose `hidden_until` is still in the future are gated out of the Open tab (and Today/Blocked) unless **Show hidden** is switched on — rules built for an agent's attention, not a supervisor's; the gate lifts automatically once the timestamp passes. The **search box** in the toolbar narrows the current view by title or tag substring (case-insensitive) — combined with the tabs and filters, not instead of them.

## The task tree (nested tasks)

Tasks nest as a single-parent tree, and the list shows it:

- A task with children wears an **expand chevron** and a **count chip**; expanding reveals its children **indented, recursively** (grandchildren included). Collapse state is per session.
- **An expanded parent brings all its open children regardless of the current view** — a parent surfaced by Today still shows its not-due children under it. Tasks whose parent chain is not visible surface at top level instead of disappearing.
- **Add subtask**: every expanded parent has an inline input at the bottom of its children. The created child inherits the parent's project at create time (an Unbound parent yields an Unbound child). This is capture-with-structure per the ADR-0006 amendment.
- **Completion circle**: one click closes a task (`done`), one click on a done task reopens it (`pending`) — the two machine-legal directions a single control can safely offer. Every other transition lives in the detail panel.
- **Re-parenting existing tasks, drag-and-drop reordering, and dependency editing are deliberately absent** — re-organization is agent work over MCP. Project binding, however, IS available: the detail panel's Project select (ADR-0006 amendments).

## Quick add

The quick-add bar captures a top-level task with Enter — Unbound under All/Unbound, into the selected project when one is picked (the only assignment path). The `▾` toggle folds out a labeled field grid: tags, priority, effort, due, hidden-until. The tree's inline add-subtask input speaks the same language (＋ glyph, Enter to create).

## Task detail panel

The audit window, next to the list:

- every stored field (status, project/Unbound, priority, effort, due, hidden-until, parent, tags), derived `blocked` and parent `progress`, children with statuses
- **dependencies read-only** with their status and blocked state
- the **annotation timeline**, newest first, attributed to its Actor, with an append-only input
- **intervals** — every recorded span of the task being active, plus total active time
- the **history timeline** — what changed, when, and which surface did it: a colored dot and chip per surface (`web` / `http` / `mcp (<client name>)`), relative stamps, and per-field diff rows (`before → after`, unchanged fields cut; create rows summarize their meaningful fields instead of dumping every column). The first 100 rows load with the panel; older history loads on demand.
- **status transitions** — only the machine-legal targets are offered (`ui/src/transitions.ts` mirrors the matrix; the daemon validates)
- **per-field editing** — every property edits on its own: the title in place (click, Enter saves, Esc cancels), Priority as an inline select, Effort/Due/Hidden-until each with their own save, **Tags as an array of chips** (remove with ×, add with ＋ tag) — each action a single-field PATCH under the `web` Actor
- **project binding** — the Project row is a select (Unbound + every project); changing it moves the task and its whole subtree in one cascade (ADR-0006 second amendment)

The panel re-polls on its own (paused while hidden), so an agent mutating the task mid-audit is visible without re-navigation.

## Projects

Projects are born in the sidebar: the **＋** affordance opens a **modal dialog** — name required, description and bound paths optional (comma-separated absolute paths; a pathless project never resolves as the Current Project for agent callers, and projects carry an optional description shown under their sidebar name). Binding a task happens in the detail panel's Project select: one action, whole-subtree cascade, change-logged per affected task.

## Writes and the web Actor

Every UI write is recorded in the change log under the **`web` Actor** — distinct from `http` and `mcp` rows, so provenance separates the human's clicks from scripts and agent sessions.

## Security posture

- The daemon binds `127.0.0.1` only; there is no token — same-user, single-machine (unchanged since v1).
- Every request bearing an **`Origin` header that does not match the request's `Host` is rejected with 403**, uniformly across all routes including `/mcp` — the drive-by guard a browser surface requires. curl and MCP clients send no `Origin` and are unaffected; `null` origins fail closed.
- No CORS headers are served: pages on other origins cannot read the API either.

## Refresh

The list polls `GET /tasks?view=all` every few seconds and derives the tree client-side; the detail panel polls its own payload. Both pause while the tab is hidden. There is no event stream — hooks/events remain deferred (spec: revisit when a real pain appears).
