import type { Db } from './db.js';

/**
 * Core Project operations — the "HTTP core" of ADR-0001: the HTTP JSON API
 * and the MCP tools are both thin adapters over these functions. Domain
 * failures throw ProjectError; each surface maps `code` onto its transport
 * (HTTP status / MCP tool error) while keeping the message text identical.
 *
 * Bound paths live in canonical form: absolute, whitespace-trimmed, no
 * trailing slash (the root "/"" keeps its slash). Incoming `cwd` values are
 * canonicalized the same way before matching.
 */

/** `invalid` -> HTTP 400 / `duplicate` -> 409 / `unbound` -> 404. */
export type ProjectErrorCode = 'invalid' | 'duplicate' | 'unbound';

export class ProjectError extends Error {
  constructor(
    readonly code: ProjectErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** A Project as exposed through both API surfaces. */
export interface ProjectView {
  id: number;
  name: string;
  createdAt: string;
  /** Bound paths in canonical form, sorted for stable output. */
  paths: string[];
  /** Open (not done/dropped) task count; zero until the tasks table lands. */
  openTaskCount: number;
}

/** Result of resolving a cwd to the Current Project. */
export interface CurrentProject {
  project: ProjectView;
  /** The bound path the cwd matched — the longest one that covers it. */
  matchedPath: string;
}

interface ProjectRow {
  id: number;
  name: string;
  created_at: string;
}

interface BoundPathRow {
  projectId: number;
  path: string;
}

interface PathClashRow {
  path: string;
  project_name: string;
}

// --------------------------------------------------------------------------
// Creation
// --------------------------------------------------------------------------

/**
 * Creates a Project with a unique name and one or more bound paths.
 * Rejects (ProjectError) on: malformed input (`invalid`), a name that already
 * exists (`duplicate`), or a path already bound to a project (`duplicate`).
 */
export function createProject(db: Db, input: unknown): ProjectView {
  const { name, paths } = (typeof input === 'object' && input !== null ? input : {}) as {
    name?: unknown;
    paths?: unknown;
  };
  const parsedName = parseName(name);
  const parsedPaths = parsePaths(paths);

  const findProjectByName = db.prepare('SELECT id FROM projects WHERE name = ?');
  const findPathClashes = db.prepare(
    `SELECT pp.path AS path, p.name AS project_name
       FROM project_paths pp
       JOIN projects p ON p.id = pp.project_id
      WHERE pp.path IN (${parsedPaths.map(() => '?').join(', ')})`,
  );
  const insertProject = db.prepare('INSERT INTO projects (name) VALUES (?)');
  const insertPath = db.prepare('INSERT INTO project_paths (path, project_id) VALUES (?, ?)');

  const create = db.transaction((): ProjectView => {
    if (findProjectByName.get(parsedName) !== undefined) {
      throw new ProjectError('duplicate', `project name already exists: ${parsedName}`);
    }
    const clashes = findPathClashes.all(...parsedPaths) as PathClashRow[];
    if (clashes.length > 0) {
      const clash = clashes[0];
      throw new ProjectError('duplicate', `path already bound to project ${clash.project_name}: ${clash.path}`);
    }
    const id = Number(insertProject.run(parsedName).lastInsertRowid);
    for (const path of parsedPaths) {
      insertPath.run(path, id);
    }
    const project = projectById(db, id);
    if (project === undefined) {
      throw new Error(`project ${id} missing right after insert`);
    }
    return project;
  });
  return create();
}

// --------------------------------------------------------------------------
// Listing
// --------------------------------------------------------------------------

export function listProjects(db: Db): ProjectView[] {
  const rows = db.prepare('SELECT id, name, created_at FROM projects ORDER BY id').all() as ProjectRow[];
  return rows.map((row) => assembleProject(db, row));
}

// --------------------------------------------------------------------------
// Current Project resolution
// --------------------------------------------------------------------------

/**
 * Resolves a caller-supplied cwd to the Current Project via longest-prefix
 * matching over all bound paths (exact match counts as a prefix; prefixes
 * respect path-segment boundaries). Throws ProjectError `unbound` when no
 * bound path covers the cwd, with a message naming the fix.
 */
export function resolveCurrentProject(db: Db, cwd: unknown): CurrentProject {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new ProjectError('invalid', `cwd must be a non-empty absolute path, got: ${display(cwd)}`);
  }
  const canonicalCwd = canonicalizePath(cwd);
  if (!canonicalCwd.startsWith('/')) {
    throw new ProjectError('invalid', `cwd must be an absolute path: ${JSON.stringify(cwd)}`);
  }

  const bound = db
    .prepare(
      `SELECT pp.project_id AS projectId, pp.path AS path
         FROM project_paths pp`,
    )
    .all() as BoundPathRow[];

  let best: BoundPathRow | undefined;
  for (const row of bound) {
    if (pathCovers(canonicalCwd, row.path) && (best === undefined || row.path.length > best.path.length)) {
      best = row;
    }
  }
  if (best === undefined) {
    throw new ProjectError(
      'unbound',
      `cwd ${canonicalCwd} is not under any project's bound path. Fix: create a project binding this directory or an ancestor of it (project_create with paths including ${canonicalCwd}).`,
    );
  }

  const project = projectById(db, best.projectId);
  if (project === undefined) {
    throw new Error(`bound path ${best.path} references missing project ${best.projectId}`);
  }
  return { project, matchedPath: best.path };
}

// --------------------------------------------------------------------------
// Internals
// --------------------------------------------------------------------------

function projectById(db: Db, id: number): ProjectView | undefined {
  const row = db.prepare('SELECT id, name, created_at FROM projects WHERE id = ?').get(id) as
    | ProjectRow
    | undefined;
  return row === undefined ? undefined : assembleProject(db, row);
}

function assembleProject(db: Db, row: ProjectRow): ProjectView {
  const pathRows = db
    .prepare('SELECT path FROM project_paths WHERE project_id = ? ORDER BY path')
    .all(row.id) as { path: string }[];
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    paths: pathRows.map((pathRow) => pathRow.path),
    // The open-task count joins the tasks table once it exists (tasks
    // ticket); projects ship first, so the count starts at zero.
    openTaskCount: countOpenTasks(row.id),
  };
}

function countOpenTasks(_projectId: number): number {
  // Placeholder for the tasks ticket: SELECT COUNT(*) FROM tasks WHERE
  // project_id = ? AND status NOT IN ('done', 'dropped').
  return 0;
}

/** Canonical bound-path form: trimmed, no trailing slash ("/" stays "/"). */
function canonicalizePath(input: string): string {
  let path = input.trim();
  while (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  return path;
}

/** True when `bound` equals `cwd` or is an ancestor directory of it. */
function pathCovers(cwd: string, bound: string): boolean {
  if (bound === '/') return true; // the root covers every absolute path
  return cwd === bound || cwd.startsWith(`${bound}/`);
}

function parseName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ProjectError('invalid', `project name must be a non-empty string, got: ${display(raw)}`);
  }
  const name = raw.trim();
  if (name === '') {
    throw new ProjectError('invalid', 'project name must be a non-empty string, got: ""');
  }
  return name;
}

function parsePaths(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ProjectError('invalid', `paths must be a non-empty array of absolute filesystem paths, got: ${display(raw)}`);
  }
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw new ProjectError('invalid', `each bound path must be a string, got: ${display(entry)}`);
    }
    const path = canonicalizePath(entry);
    if (!path.startsWith('/')) {
      throw new ProjectError('invalid', `project paths must be absolute: ${JSON.stringify(entry)}`);
    }
    if (seen.has(path)) {
      throw new ProjectError('duplicate', `duplicate path in request: ${path}`);
    }
    seen.add(path);
    canonical.push(path);
  }
  return canonical;
}

function display(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}
