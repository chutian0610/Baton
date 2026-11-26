# The Web UI is a writable human surface served by the daemon

v0.2 had two surfaces (HTTP JSON API, MCP), both machine-facing; the human watched the store through curl or by asking an agent. v0.3 adds a Web UI as the human's own surface — and it takes writes directly. A dedicated terminal CLI was considered and dropped: the HTTP API stays curl-friendly for scripting, so a CLI would only have added terminal ergonomics at the price of building and testing a second human surface.

Decision (2026-11): the same daemon serves the built SPA at `/ui` on the same port — ADR-0001's single daemon stands, no new process, port, or lifecycle. The localhost-only binding is retained and there is no token: same-user, single-machine posture. Requests bearing an `Origin` header whose authority differs from the request's own `Host` header are rejected (comparing against the request's Host, not the bound address, is what lets the same origin pass however the user reaches the daemon — `localhost` or `127.0.0.1`); this closes the drive-by/CSRF write risk a browser surface introduces (reads were already CORS-blocked, writes were not). curl and MCP clients send no `Origin` and are unaffected.

Considered and rejected: a read-only dashboard (the human's corrections would detour through conversation with an agent — lossy and indirect, when every write endpoint already exists server-side); a separate UI process or port (new lifecycle, no gain); token auth (nothing is protected on a localhost-bound single-user daemon that the Origin check does not already cover).

Amendment (2026-11, first real use): the boundary moved from "no structural editing" to **capture-with-structure is UI work, re-organization stays agent work**. The UI may create a subtask under an existing parent and expand/collapse the tree — recording a plan's shape as it is captured.

Second amendment (2026-11, same day): **project management joins the UI** — creating projects (name + bound paths) and binding a task to a project (the explicit `PATCH {project}`, cascade included, whether first-bind or a move). The organizing pain turned out to be the human's, not only the agents': projects are how the human reads the board. Still deliberately absent from the UI: reparenting existing tasks (including drag-and-drop) and dependency editing — tree shape after capture and the DAG remain agent work, and a browser DAG editor costs more than it buys.

## Consequences

- Web writes carry a distinct Actor — they must not masquerade as the constant direct-HTTP-caller actor.
- The Origin check only affects browser-originated requests; no existing client breaks.
- Subtask creation may name a parent at create time; re-parenting afterwards is not expressible in the UI.
- Project binding through the UI uses the same PATCH {project} as every other surface: one action, whole-subtree cascade, one change-log row per affected task.
- A browser has no cwd, so Current Project resolution does not apply; the UI scopes by explicit selection instead.
