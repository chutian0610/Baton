import type { Project, Task } from './types';

/**
 * The API client: plain fetch against the HTTP API (ADR-0006 — in production
 * the bundle is served by the daemon itself, so the default base is '' and
 * every URL is relative; tests point the base at a real booted daemon).
 * Read spine for T3; the write methods arrive with T6.
 */

export interface TaskListPayload {
  tasks: Task[];
}

export interface ProjectListPayload {
  projects: Project[];
}

export interface Api {
  listTasks(): Promise<TaskListPayload>;
  listProjects(): Promise<ProjectListPayload>;
}

export function createHttpApi(base = ''): Api {
  async function getJson<T>(path: string): Promise<T> {
    const response = await fetch(`${base}${path}`);
    if (!response.ok) {
      throw new Error(`GET ${path} failed with ${response.status}`);
    }
    return (await response.json()) as T;
  }
  return {
    listTasks: () => getJson<TaskListPayload>('/tasks?view=all'),
    listProjects: () => getJson<ProjectListPayload>('/projects'),
  };
}

export const httpApi: Api = createHttpApi();
