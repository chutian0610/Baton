# Baton

A single-machine task management service for AI coding agents: one daemon, exposed to agents via MCP over HTTP, tracking todos and in-progress work across projects.

## Language

### Core entities

**Task**:
A unit of work with a status, belonging to at most one Project. Tasks nest into a tree and may depend on other tasks.
_Avoid_: Todo, item, ticket, issue

**Project**:
An explicitly created grouping of tasks, optionally bound to one or more local filesystem paths. When a caller presents a working directory, the bound Project is resolved as the caller's Current Project.
_Avoid_: Workspace, repo, folder

**Current Project**:
The Project resolved from the caller's working directory. List views default to it unless the caller explicitly queries across projects.
_Avoid_: Context

**Tag**:
A free-form lowercase label attached to tasks for cross-project grouping.

### Structure

**Parent / Child**:
The single-parent nesting relationship between tasks. A Parent task expresses decomposition ("these children make up this work"); it is never a scheduling or dependency relationship.
_Avoid_: Milestone (a Parent task is just a Parent task — see below)

**Milestone**:
Not a concept in Baton. A milestone is an ordinary Parent task whose completion is meaningful; no separate entity, flag, or kind exists.
_Avoid_: Epic, milestone-as-entity

**Dependency**:
A directed edge meaning "this task cannot start until its dependencies are done." Dependencies form a DAG, are orthogonal to Parent/Child, and cycles are rejected.

**Blocked**:
A derived property of a task: true when any of its dependencies is not `done` or `dropped`. Never stored as a Status, and never prevents a task from becoming `active`.

### Lifecycle

**Status**:
The stored, mutually exclusive state of a task: `pending`, `active`, `waiting`, `done`, `dropped`.
_Avoid_: deleted (dropped covers it), in-progress (active covers it)

### Measurement

**Progress**:
The derived completion ratio of a parent task: the proportion of its descendant tasks that are `done`. Never entered by hand.
_Avoid_: Percent, percentage (no manual percentage exists)

**Effort**:
An optional estimated effort attached to a task, in whatever unit the author chooses to record.

**Interval**:
A recorded span of a task being `active`, opened by entering `active` and closed by leaving it (entering `done` or `dropped` closes it automatically).

### Record-keeping

**Annotation**:
A timestamped, append-only note attached to a task; the channel through which agents report interim findings and progress.
_Avoid_: Comment, log entry, description

**Actor**:
The provenance recorded on every change: which MCP client (and agent session, when known) performed it.

**Change Log**:
The append-only record of every mutation to every entity, with its Actor.

### Time

**Due**:
The optional deadline datetime of a task.

**Hidden-until**:
The optional datetime before which a task is excluded from default list views.
_Avoid_: Wait, waiting-until (collides with the `waiting` Status)
