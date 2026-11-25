import { inject } from 'vue';
import type { Change, Project, Task, TaskDetailPayload } from './types';

/**
 * The API client: plain fetch against the HTTP API (ADR-0006 — in production
 * the bundle is served by the daemon itself, so the default base is '' and
 * every URL is relative; tests point the base at a real booted daemon).
 * The browser adds Origin to POSTs/PATCHes itself — that header is what the
 * daemon classifies the web Actor from, and it cannot (and needs not) be set
 * from here: Origin is a browser forbidden header name.
 */

export interface TaskListPayload {
  tasks: Task[];
}

export interface ProjectListPayload {
  projects: Project[];
}

export interface ChangesPayload {
  changes: Change[];
  total: number;
}

export interface Api {
  listTasks(): Promise<TaskListPayload>;
  listProjects(): Promise<ProjectListPayload>;
  getTask(id: number): Promise<TaskDetailPayload>;
  getChanges(id: number, limit: number, offset: number): Promise<ChangesPayload>;
  createTask(body: Record<string, unknown>): Promise<{ task: Task }>;
  updateTask(id: number, body: Record<string, unknown>): Promise<{ task: Task }>;
  annotate(id: number, body: string): Promise<{ annotation: unknown }>;
}

export function createHttpApi(base = ''): Api {
  async function getJson<T>(path: string): Promise<T> {
    const response = await fetch(`${base}${path}`);
    if (!response.ok) {
      throw new Error(`GET ${path} failed with ${response.status}`);
    }
    return (await response.json()) as T;
  }
  async function sendJson<T>(path: string, method: 'POST' | 'PATCH', body: unknown): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`${method} ${path} failed with ${response.status}`);
    }
    return (await response.json()) as T;
  }
  return {
    listTasks: () => getJson<TaskListPayload>('/tasks?view=all'),
    listProjects: () => getJson<ProjectListPayload>('/projects'),
    getTask: (id: number) => getJson<TaskDetailPayload>(`/tasks/${id}`),
    getChanges: (id, limit, offset) => getJson<ChangesPayload>(`/tasks/${id}/changes?limit=${limit}&offset=${offset}`),
    createTask: (body) => sendJson('/tasks', 'POST', body),
    updateTask: (id, body) => sendJson(`/tasks/${id}`, 'PATCH', body),
    annotate: (id, body) => sendJson(`/tasks/${id}/annotations`, 'POST', { body }),
  };
}

/** The transport seam for components: tests inject a full Api, production self-builds same-origin. */
export function injectApi(): Api {
  return inject<Api | undefined>('api', undefined) ?? createHttpApi(inject<string>('apiBase', ''));
}
