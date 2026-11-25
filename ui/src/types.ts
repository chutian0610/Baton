/**
 * The API payloads the Web UI consumes, mirrored from the daemon's surfaces
 * (src/tasks.ts TaskView, src/projects.ts ProjectView). The daemon is the
 * source of truth for these shapes; nothing here re-derives domain meaning
 * beyond what the API already returns (blocked and progress arrive derived).
 */

export type TaskStatus = 'pending' | 'active' | 'waiting' | 'done' | 'dropped';

export type Priority = 'H' | 'M' | 'L';

/** A task as returned by GET /tasks and GET /tasks/:id. */
export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
  projectId: number | null;
  projectName: string | null;
  parentId: number | null;
  tags: string[];
  deps: number[];
  blocked: boolean;
  /** Derived done-descendant ratio for parents; null on leaves. */
  progress: number | null;
  due: string | null;
  priority: Priority | null;
  effort: string | null;
  hiddenUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A project as returned by GET /projects. */
export interface Project {
  id: number;
  name: string;
  createdAt: string;
  /** Bound paths in canonical form. */
  paths: string[];
  openTaskCount: number;
}

/** The Actor union, mirrored from the daemon (src/actors.ts). */
export type Actor = HttpActor | McpActor | WebActor;

export interface HttpActor {
  kind: 'http';
}

export interface WebActor {
  kind: 'web';
}

export interface McpActor {
  kind: 'mcp';
  clientName: string;
  clientVersion?: string;
  sessionId?: string;
}

/** An append-only annotation as returned inside GET /tasks/:id. */
export interface Annotation {
  id: number;
  taskId: number;
  body: string;
  actor: Actor;
  createdAt: string;
}

/** A change-log row as returned by GET /tasks/:id/changes. */
export interface Change {
  id: number;
  entity: string;
  entityId: number;
  actor: Actor;
  createdAt: string;
  diff: Record<string, { before: unknown; after: unknown }>;
}

/** A recorded span of a task being active, as returned inside GET /tasks/:id. */
export interface Interval {
  id: number;
  startedAt: string;
  /** null while the Interval is open (the task is active). */
  endedAt: string | null;
}

/** A child summary as returned inside GET /tasks/:id. */
export interface ChildSummary {
  id: number;
  title: string;
  status: TaskStatus;
}

/** The composite payload of GET /tasks/:id. */
export interface TaskDetailPayload {
  task: Task;
  children: ChildSummary[];
  intervals: Interval[];
  totalActiveMs: number;
  annotations: Annotation[];
  recentChanges: Change[];
}
