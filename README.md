# Baton

[![CI](https://github.com/chutian0610/Baton/actions/workflows/ci.yml/badge.svg)](https://github.com/chutian0610/Baton/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@chutian0610/baton)](https://www.npmjs.com/package/@chutian0610/baton)
![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

Baton gives every AI coding-agent session on one machine a shared, durable task store. A single daemon, bound to `127.0.0.1` only, serves a plain HTTP JSON API as its core and a thin MCP adapter (streamable HTTP) on top, so several agent sessions — and a terminal with `curl` — all read and write the same store. Capture-first: every task starts Unbound, and binding it to a Project is an explicit, subtree-wide act. Tasks nest as a single-parent tree (across Projects freely), ordering is a dependency DAG within a Project's scope, and every change is recorded in an append-only change log with the client that made it. All state lives in one SQLite database under `~/.baton/`.

- **Domain glossary (normative)**: `CONTEXT.md`
- **Architecture decisions**: `docs/adr/`
- **Specs**: GitHub issues #1 (v1) and #12 (v0.2 capture-first)
- **Package**: [@chutian0610/baton](https://www.npmjs.com/package/@chutian0610/baton)

**Documentation**: [MCP client setup](docs/mcp-clients.md) · [HTTP API reference](docs/http-api.md) · [Web UI](docs/web-ui.md) · [Usage examples](docs/examples.md) · [Auto-start with launchd](docs/launchd.md)

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

It listens on `127.0.0.1:7600` and serves all three surfaces:

- HTTP JSON API: `http://127.0.0.1:7600/`
- MCP (streamable HTTP): `http://127.0.0.1:7600/mcp`
- Web UI (the human's dashboard): [http://127.0.0.1:7600/ui](http://127.0.0.1:7600/ui)

Sanity check:

```sh
curl -s http://127.0.0.1:7600/healthz
# {"status":"ok"}
```

Stop it with Ctrl-C. There is no built-in service installation; for auto-start see [docs/launchd.md](docs/launchd.md).

The MCP endpoint speaks streamable HTTP — client configuration for common hosts, the 11-tool surface, the full HTTP API reference, and a cookbook of query recipes live in the docs linked above. Start with [docs/examples.md](docs/examples.md) for the capture-first flow, progress/blocked semantics, agent provenance, and a query cookbook. The Web UI at `/ui` is the human's window: [docs/web-ui.md](docs/web-ui.md).

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

## Backup

All state is one SQLite file: `~/.baton/data.db` (or `<data_dir>/data.db` if configured). To back up:

1. Stop the daemon (Ctrl-C, or `launchctl bootout …`) so the WAL is checkpointed into the main file.
2. Copy that one file.

Restoring is putting the file back and starting the daemon.

## Concepts

Short version — `CONTEXT.md` is the normative glossary:

- **Surface** — one of the three doors into the store: MCP (agents), the HTTP JSON API (curl/scripts), the Web UI (the human); a write is equally valid from any Surface and records its Actor
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
npm install   # installs dev deps, builds dist/ (daemon via tsc, ui via vite) via prepare
npm run build # tsc + vue-tsc + vite build (daemon + ui bundle)
npm test      # the full process-level suite; spawns the real daemon (build first)
```

Tests are process-level by design: every suite boots the **built** daemon as a subprocess on a random port with a temp data directory, then asserts only external behavior — HTTP responses via `fetch`, MCP via the official client SDK. No mocks anywhere.

The end-to-end journey (`tests/integration.test.ts`) can also verify a **live instance**:

```sh
baton daemon --port 7601 --data /tmp/baton-accept
BATON_ACCEPTANCE_URL=http://127.0.0.1:7601 npx vitest run tests/integration.test.ts
```

It mutates that store by design (created tasks are dropped in cleanup; the timestamped `acc-*` projects remain — there is no hard delete) and skips its restart-durability step so it never touches your daemon's lifecycle.

### CI/CD

| Workflow | Trigger | Does |
| --- | --- | --- |
| `ci.yml` | push to `main`, every pull request | build + the full suite (superseded runs are cancelled) |
| `npm-publish.yml` | `v*` tag | full suite → npm publish via Trusted Publishing (OIDC) → GitHub release with generated notes |

### Releasing

```sh
npm version minor       # or patch / major: bumps package.json, commits, tags v0.x.y
git push --follow-tags  # main + tag out; CI tests, publishes to npm, creates the release
```

Nothing else — the tag-triggered workflow is the only publishing path, and it gates on the full suite.
