# Usage examples

Scenario-driven walkthroughs against a running daemon (default port `7600`). Set a base once and go:

```sh
BASE=http://127.0.0.1:7600
```

For brevity the examples omit `-H 'content-type: application/json'` on bodies and show only the interesting part of responses. Task ids assume a fresh store — substitute the ids your instance returns. See [http-api.md](./http-api.md) for the full reference.

## 1. Capture first, organize later

The signature flow: record work the moment you think of it — no Project needed, no `cwd` consulted. Structure it immediately (Unbound tasks nest and depend among themselves), organize whenever a Project emerges.

```sh
# capture a reading thread, fully structured, still Unbound
curl -s -X POST $BASE/tasks -d '{"title":"Read the complete-induction paper"}'
curl -s -X POST $BASE/tasks -d '{"title":"Study section 3","parent":1}'
curl -s -X POST $BASE/tasks -d '{"title":"Run the reproduction","parent":1,"deps":[2]}'
#   → "Run the reproduction" is born blocked: true (section 3 is open)

# all three sit in the default listing, side by side with every other project's work
curl -s $BASE/tasks
```

Weeks later the reading thread becomes a real project — bind it in one call:

```sh
curl -s -X POST $BASE/projects -d '{"name":"papers","paths":["/path/to/papers"]}'
curl -s -X PATCH $BASE/tasks/1 -d '{"project":"papers"}'
# → the whole subtree flips to papers: one change-log row per affected task
```

## 2. Progress you can trust

Progress and blocked are **derived** — from the tree and the dependency graph, never entered by hand. There is no percent field to lie with.

```sh
# a parent with three children, ordered by dependencies
curl -s -X POST $BASE/tasks -d '{"title":"Ship v1","project":"my-app"}'
curl -s -X POST $BASE/tasks -d '{"title":"Write release notes","parent":1}'
curl -s -X POST $BASE/tasks -d '{"title":"Run regression suite","parent":1,"deps":[2]}'
curl -s -X POST $BASE/tasks -d '{"title":"Deploy","parent":1,"deps":[2,3]}'

curl -s -X POST $BASE/tasks/2/start   # start writing: opens the Interval
curl -s -X POST $BASE/tasks/2/done    # closes it; the regression suite unblocks

# "Run regression suite" just unblocked (its dependency is done);
# the parent now shows progress: 1/3 done among non-dropped descendants
curl -s $BASE/tasks/1
#   → task.progress: 0.333..., task.children: all three, task.totalActiveMs > 0
```

`totalActiveMs` accumulates automatically: entering `active` opens an Interval, leaving it (or entering `done`/`dropped`) closes it.

## 3. Work that waits on the outside world

Three tools for "tracked, but not now":

```sh
# waiting: blocked on a person or an external event — distinct from pending
curl -s -X PATCH $BASE/tasks/5 -d '{"status":"waiting"}'

# hidden_until: a someday-idea that should not clutter default views
curl -s -X POST $BASE/tasks -d '{"title":"Rewrite the parser in Rust","hidden_until":"2027-06-01T00:00:00Z"}'
curl -s $BASE/tasks                                   # the hidden task is absent here
curl -s "$BASE/tasks?filter=%7B%22status%22%3A%22pending%22%7D"   # explicit status surfaces it

# reopen: a task done too early comes back as pending, history intact
curl -s -X POST $BASE/tasks/7/done
curl -s -X PATCH $BASE/tasks/7 -d '{"status":"pending"}'
```

## 4. Two agents, one board

Every session shares the store, and every change records who made it — the Actor. MCP sessions log their `clientInfo` and session id; direct HTTP calls log `{"kind":"http"}`.

```sh
# agent A (via HTTP during a script) annotates…
curl -s -X POST $BASE/tasks/2/annotations -d '{"body":"regression suite green on staging"}'
# …agent B (an MCP session) picks the task up and finishes it

# the audit trail: full history, newest first, paged
curl -s "$BASE/tasks/2/changes?limit=100"
curl -s "$BASE/tasks/2/changes?limit=20&offset=20"
#   → each row: {field: {before, after}} diff + actor + timestamp
```

Ask any task "who did this" with `GET /tasks/:id` — `recentChanges` (last 20 rows) and `annotations` ride along with the detail.

## 5. Reorganizing a board

Binding and moving are subtree-wide by default, and the graph protects itself:

```sh
# move a whole feature subtree to another project
curl -s -X PATCH $BASE/tasks/10 -d '{"project":"archive"}'

# a move that would tear a dependency across projects is rejected with the pairs…
curl -s -X PATCH $BASE/tasks/2 -d '{"project":"archive"}'
#   → 409: "task 3 (still in project my-app) depends on task 2; resolve them first"
#     …and nothing is written — the rollback is transactional

# resolve the dependency, then the same move succeeds
curl -s -X PATCH $BASE/tasks/3 -d '{"deps":[]}'
curl -s -X PATCH $BASE/tasks/2 -d '{"project":"archive"}'

# unbind a subtree entirely: back to Unbound, visible in the default listing
curl -s -X PATCH $BASE/tasks/2 -d '{"project":null}'
```

Note what is deliberately absent: no hard delete (drop instead, via `status: "dropped"`), no single-task reassignment without the cascade, and no `hasProject` filter — Unbound tasks simply live in the default listing like everything else.

## 6. Query cookbook

Every row is one URL-encoded filter (or quick view) over `GET /tasks`:

| Want | Call |
| --- | --- |
| What's due today (or overdue)? | `/tasks?view=today` |
| What's stuck? | `/tasks?view=blocked` |
| Everything, including closed work | `/tasks?view=all` |
| One project only | `?filter={"project":"my-app"}` |
| High-priority items in a project | `?filter={"project":"my-app","priority":"H"}` |
| Anything mentioning a keyword | `?filter={"text":"induction"}` |
| All steps of a reading thread | `?filter={"tags":["reading"],"tagMode":"all"}` |
| Roots only (top of every tree) | `?filter={"hasParent":false}` |
| Newest due date first, top 5 | `?filter={"sort":[{"field":"due","direction":"desc"}],"limit":5}` |
| A task's full audit trail | `/tasks/2/changes?limit=100` |

Compose freely — fields AND together, `sort` accepts a bare field name (`"sort":"title"`) or an array of `{field, direction}`, and `id` asc is always the final tiebreaker so lists are stable.
