# Derived data is never stored

Progress (a parent's completion ratio over its descendants) and Blocked (has a dependency that is neither `done` nor `dropped`) are computed at query time from the task tree and the dependency graph. Neither is a stored field, and there is deliberately **no manual percentage** anywhere in the model. This will look like a gap to fix — it is not. Agent-reported percentages are the least trustworthy signal in the system; structure (children done) and graph (dependencies closed) are the trustworthy ones. Do not "complete" this design by adding a percent field.

## Consequences

- There is no `blocked` value in the stored Status enum; clients render it as `status: pending, blocked: true`.
- Blocked is advisory only: a task may become `active` while blocked.
