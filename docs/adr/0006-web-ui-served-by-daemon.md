# The Web UI is a writable human surface served by the daemon

v0.2 had two surfaces (HTTP JSON API, MCP), both machine-facing; the human watched the store through curl or by asking an agent. v0.3 adds a Web UI as the human's own surface — and it takes writes directly. A dedicated terminal CLI was considered and dropped: the HTTP API stays curl-friendly for scripting, so a CLI would only have added terminal ergonomics at the price of building and testing a second human surface.

Decision (2026-11): the same daemon serves the built SPA at `/ui` on the same port — ADR-0001's single daemon stands, no new process, port, or lifecycle. The localhost-only binding is retained and there is no token: same-user, single-machine posture. Requests bearing an `Origin` header that does not match the bound host are rejected; this closes the drive-by/CSRF write risk a browser surface introduces (reads were already CORS-blocked, writes were not). curl and MCP clients send no `Origin` and are unaffected.

Considered and rejected: a read-only dashboard (the human's corrections would detour through conversation with an agent — lossy and indirect, when every write endpoint already exists server-side); a separate UI process or port (new lifecycle, no gain); token auth (nothing is protected on a localhost-bound single-user daemon that the Origin check does not already cover).

## Consequences

- Web writes carry a distinct Actor — they must not masquerade as the constant direct-HTTP-caller actor.
- The Origin check only affects browser-originated requests; no existing client breaks.
- Structural editing stays out of the UI: reparenting, dependency editing, and project cascade moves are agent work over MCP — a browser DAG editor costs more than it buys.
- A browser has no cwd, so Current Project resolution does not apply; the UI scopes by explicit selection instead.
