# Project is a task attribute, not a container

v1 bound every Task to exactly one Project (`project_id NOT NULL`, creating without a resolvable project was an error), confined trees to a single project, and auto-assigned the cwd-resolved Current Project at create time. Real use wanted capture-first: record todos before the project exists, organize later.

Decision (2026-11): every Task starts Unbound (nullable project); `task_create` never consults cwd — cwd resolves reads only (`view=current`, `project_current`); binding is an explicit `task_update {project}` that cascades to the Task's whole subtree by default; trees may span Projects freely. One project constraint survives: **dependencies must connect tasks of the same Project — or two Unbound tasks** — and a move that would leave a cross-project dependency is rejected with the offending pairs listed. The default listing is global open tasks, narrowed by an optional project filter; there is no Inbox entity or view.

The asymmetry is deliberate and is the owner's call: a tree expresses decomposition (project-independent by nature), while a dependency expresses ordering within a board's scope. Considered and rejected: keeping the v1 container model plus project moves only (capture still required a project to exist), and an auto-created Inbox project (silently lands tasks — violates the explicitness principle this tool is built on). Consistent with ADR-0004: demoting Project to an attribute leaves exactly one hierarchy — the task tree.

## Consequences

- A cascade move writes one change-log row per affected task (each task's history shows when it joined the project), all in the same transaction under one Actor.
- Mixed-project trees arise only through creation order (bind a parent, then create Unbound children under it); re-assigning a bound parent re-cascades over its descendants. Single-task reassignment without cascade is not expressible.
- The v1 `unbound` create error and the create-time cwd resolution are removed; reads keep the cwd fallback note on `view=current`.
