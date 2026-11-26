# HTTP API reference

The same core the MCP tools wrap, curl-friendly. Base: `http://127.0.0.1:7600`.

| Method & path | Purpose |
| --- | --- |
| `GET /healthz` | liveness probe |
| `POST /projects` | create a Project (name required; description and bound paths optional — a pathless Project never resolves as the Current Project) |
| `GET /projects` | list Projects with paths and open-task counts |
| `GET /projects/current?cwd=…` | resolve a working directory to the Current Project |
| `POST /tasks` | create a Task (capture-first: no project needed; `project` optional, absent/null = Unbound) |
| `GET /tasks` | default listing: global open tasks (`{tasks}`) |
| `GET /tasks?view=…` | quick view (`current`, `today`, `blocked`, `all`); `current` also takes `?cwd=` |
| `GET /tasks?filter=…` | structured JSON filter (URL-encoded; see below) |
| `GET /tasks/:id` | full detail: task + children + intervals + annotations + changes |
| `PATCH /tasks/:id` | update fields, reparent, set deps, change status, bind/unbind the Project (cascades to the subtree) |
| `POST /tasks/:id/start` | start verb (`pending\|waiting → active`) |
| `POST /tasks/:id/done` | done verb (any non-done → `done`) |
| `POST /tasks/:id/annotations` | append an Annotation |
| `GET /tasks/:id/annotations` | list Annotations, newest first |
| `GET /tasks/:id/changes` | full change history, newest first (`?limit=` default 100, `?offset=`) |

Errors are `{"error": "<message>"}` with 400 (malformed), 404 (unknown id / unresolvable project), 409 (conflict: illegal transition, cycle, cross-project dependency, rejected move).

## The filter object

`?filter=` takes one URL-encoded JSON object; fields AND together:

| Field | Meaning |
| --- | --- |
| `status` | single value or array of `pending/active/waiting/done/dropped` (overrides default exclusions) |
| `project` | Project name or id |
| `tags` | array of tags, with `tagMode: "any"` (default) or `"all"` |
| `parent` | parent id; `hasParent: false` means roots only |
| `blocked` | boolean (derived at read time) |
| `dueBefore` / `dueAfter` | ISO-8601 datetimes, inclusive; tasks without `due` never match |
| `priority` | single value or array of `H/M/L` |
| `text` | case-insensitive title substring |
| `sort` | field name, or array of `{field, direction}`; default: `due` asc → `priority` (H>M>L) → `id` asc |
| `limit` | truncate after sorting |

Default views (no explicit `status`) exclude `done`, `dropped`, and tasks whose `hidden_until` is in the future.

## Walkthrough

Create a Project — name required; description and bound paths optional (a pathless Project never resolves as the Current Project):

```sh
curl -s -X POST http://127.0.0.1:7600/projects \
  -H 'content-type: application/json' \
  -d '{"name":"my-app","description":"the board for my-app","paths":["/path/to/my-app"]}'
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

Scenario-driven walkthroughs live in [examples.md](./examples.md).
