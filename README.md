# Baton

Baton gives every AI coding-agent session on one machine a shared, durable task store. A single daemon, bound to `127.0.0.1` only, serves a plain HTTP JSON API as its core and a thin MCP adapter (streamable HTTP) on top, so several agent sessions — and a terminal with `curl` — all read and write the same store. Capture-first: every task starts Unbound, and binding it to a Project is an explicit, subtree-wide act. Tasks nest as a single-parent tree (across Projects freely), ordering is a dependency DAG within a Project's scope, and every change is recorded in an append-only change log with the client that made it. All state lives in one SQLite database under `~/.baton/`.

- **Domain glossary (normative)**: `CONTEXT.md`
- **Architecture decisions**: `docs/adr/`
- **Specs**: GitHub issues #1 (v1) and #12 (v0.2 capture-first)

## Install

Requirements: Node.js >= 22 (native module build needs a working toolchain; prebuilt binaries cover common platforms).

From the npm registry:

```sh
npm install -g @chutian0610/baton   # exposes the `baton` command globally
baton --help                        # prints a usage line — confirms the command is wired up
```

From a checkout of this repository:

```sh
npm install        # also builds dist/ (prepare script)
npm install -g .   # exposes the `baton` command globally
baton --help       # prints a usage line — confirms the command is wired up
```

`npm link` works too and keeps the command pointing at your checkout.

## Quickstart

Start the daemon in the foreground:

```sh
baton daemon
# {"event":"listening","address":"127.0.0.1","port":7600}
```

It listens on `127.0.0.1:7600` and serves both surfaces:

- HTTP JSON API: `http://127.0.0.1:7600/`
- MCP (streamable HTTP): `http://127.0.0.1:7600/mcp`

Sanity check:

```sh
curl -s http://127.0.0.1:7600/healthz
# {"status":"ok"}
```

Stop it with Ctrl-C. There is no built-in service installation; for auto-start see [launchd](#auto-start-with-launchd-macos) below.

## MCP clients

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

## HTTP API

The same core the MCP tools wrap, curl-friendly:

| Method & path | Purpose |
| --- | --- |
| `GET /healthz` | liveness probe |
| `POST /projects` | create a Project (name + bound paths) |
| `GET /projects` | list Projects with paths and open-task counts |
| `GET /projects/current?cwd=…` | resolve a working directory to the Current Project |
| `POST /tasks` | create a Task (capture-first: no project needed; `project` optional, absent/null = Unbound) |
| `GET /tasks` | default listing: global open tasks (`{tasks}`) |
| `GET /tasks?view=…` | quick view (`current`, `today`, `blocked`, `all`); `current` also takes `?cwd=` |
| `GET /tasks?filter=…` | structured JSON filter (URL-encoded; `project` narrows to one Project) |
| `GET /tasks/:id` | full detail: task + children + intervals + annotations + changes |
| `PATCH /tasks/:id` | update fields, reparent, set deps, change status, bind/unbind the Project (cascades to the subtree) |
| `POST /tasks/:id/start` | start verb (`pending|waiting → active`) |
| `POST /tasks/:id/done` | done verb (any non-done → `done`) |
| `POST /tasks/:id/annotations` | append an Annotation |
| `GET /tasks/:id/annotations` | list Annotations, newest first |
| `GET /tasks/:id/changes` | full change history, newest first (`?limit=` default 100, `?offset=`) |

Create a Project bound to a local path:

```sh
curl -s -X POST http://127.0.0.1:7600/projects \
  -H 'content-type: application/json' \
  -d '{"name":"my-app","paths":["/path/to/my-app"]}'
```

Capture a task from anywhere — no Project needed (every task starts Unbound, and `cwd` is never consulted at create):

```sh
curl -s -X POST http://127.0.0.1:7600/tasks \
  -H 'content-type: application/json' \
  -d '{"title":"Ship the release"}'
```

Capture can also nest (trees may span Projects), and assignment is a conscious act when the user names a Project:

```sh
curl -s -X POST http://127.0.0.1:7600/tasks \
  -H 'content-type: application/json' \
  -d '{"title":"Draft the changelog","parent":1}'
curl -s -X POST http://127.0.0.1:7600/tasks \
  -H 'content-type: application/json' \
  -d '{"title":"Repo-only chore","project":"my-app"}'
```

Bind later in one call: `PATCH {project}` assigns the task AND its whole subtree (one change-log row per affected task). `{"project": null}` unbinds the subtree:

```sh
curl -s -X PATCH http://127.0.0.1:7600/tasks/1 \
  -H 'content-type: application/json' \
  -d '{"project":"my-app"}'
```

The default listing is global open tasks — captured Unbound work is always visible:

```sh
curl -s http://127.0.0.1:7600/tasks
```

Work one Project at a time via the `project` filter (name or id), or keep repo-scoped reading with `view=current`:

```sh
curl -s 'http://127.0.0.1:7600/tasks?filter=%7B%22project%22%3A%22my-app%22%7D'
curl -s 'http://127.0.0.1:7600/tasks?view=current&cwd=/path/to/my-app'
```

Start it, finish it, note an interim finding:

```sh
curl -s -X POST http://127.0.0.1:7600/tasks/1/start
curl -s -X POST http://127.0.0.1:7600/tasks/1/annotations \
  -H 'content-type: application/json' \
  -d '{"body":"release notes drafted, waiting on CI"}'
curl -s -X POST http://127.0.0.1:7600/tasks/1/done
```

## Configuration

The daemon reads `~/.baton/config.toml` when that file exists. Two keys, both optional:

```toml
port = 7601                       # integer 0-65535 (0 = random port)
data_dir = "/path/to/baton-data"  # absolute path; data.db lives here
```

Resolution order per setting — the first source that provides a value wins:

| Setting | 1 (highest) | 2 | 3 | 4 (default) |
| --- | --- | --- | --- | --- |
| port | `--port` CLI arg | `BATON_PORT` env | `port` in config.toml | `7600` |
| data dir | `--data` CLI arg | `BATON_DATA_DIR` env | `data_dir` in config.toml | `~/.baton` |

A missing or empty config file is fine (defaults apply). Anything invalid fails startup with an error naming the offender: unknown keys, a non-integer `port`, or a relative `data_dir` (the daemon may be started from any directory, so paths must be absolute).

## Auto-start with launchd (macOS)

The daemon runs in the foreground; for auto-start, install a launchd agent. A template also ships at `extras/com.baton.daemon.plist`.

1. Find the installed binary: `command -v baton`
2. Copy the template to `~/Library/LaunchAgents/com.baton.daemon.plist` and replace the placeholders — `{{PATH_TO_BATON}}` with the binary path from step 1, `{{HOME}}` with your home directory.
3. Load and start it:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.baton.daemon.plist
```

Stop and unload:

```sh
launchctl bootout gui/$(id -u)/com.baton.daemon
```

Template (`RunAtLoad` starts it at login; `KeepAlive` restarts it after a crash):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.baton.daemon</string>

    <key>ProgramArguments</key>
    <array>
        <string>{{PATH_TO_BATON}}</string>
        <string>daemon</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ProcessType</key>
    <string>Background</string>

    <key>StandardOutPath</key>
    <string>{{HOME}}/Library/Logs/baton.log</string>
    <key>StandardErrorPath</key>
    <string>{{HOME}}/Library/Logs/baton.log</string>
</dict>
</plist>
```

## Backup

All state is one SQLite file: `~/.baton/data.db` (or `<data_dir>/data.db` if configured). To back up:

1. Stop the daemon (Ctrl-C, or `launchctl bootout …`) so the WAL is checkpointed into the main file.
2. Copy that one file.

Restoring is putting the file back and starting the daemon.

## Concepts

Short version — `CONTEXT.md` is the normative glossary:

- **Task** — a unit of work with a Status; nests into a single-parent tree (a milestone is just a parent Task)
- **Unbound** — the state every Task starts in: its Project attribute is unset (`projectId: null`). `task_create` never consults `cwd` and never fails on project grounds — capture now, organize later. Unbound tasks nest and depend among themselves like any other tasks
- **Project** — an attribute of a Task, not a container: at most one Project per Task, assigned explicitly (by name or id at create) or bound later with `PATCH {project}`. Assigning a Project to a Task assigns it to that Task's **whole subtree** — the default cascade; there is no single-task reassignment without the cascade. Trees may span Projects (decomposition is project-independent). A Project may also be bound to one or more local paths for `view=current` and `project_current` resolution
- **Current Project** — the Project resolved from the caller's working directory; `view=current` keeps this repo-scoped read (with a whole-store fallback note when the cwd resolves to nothing). Writes never resolve `cwd`
- **Dependency** — a directed "cannot start until done" edge, orthogonal to Parent/Child. One project constraint survives: dependencies connect tasks of the **same Project — or two Unbound tasks**; a move that would leave a cross-project dependency is rejected with the offending pairs listed
- **Parent / Child** — the single-parent nesting relationship; may span Projects freely
- **Tag** — a free-form lowercase label for cross-project grouping
- **Status** — `pending / active / waiting / done / dropped`, with validated transitions
- **Interval** — an automatically recorded span of a Task being active
- **Annotation** — a timestamped, append-only note on a Task
- **blocked** — derived at read time (a dependency is not done/dropped); advisory, never a Status
- **progress** — a parent's derived ratio of done descendants; never entered by hand

## Development

```sh
npm install   # installs dev deps, builds dist/ via prepare
npm run build # tsc
npm test      # vitest; boots the real daemon as a subprocess (build first)
```
