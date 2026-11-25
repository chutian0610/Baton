import type { Project, Task, TaskDetailPayload } from './types';

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
  getTask(id: number): Promise<TaskDetailPayload>;
  createTask(body: Record<string, unknown>): Promise<{ task: Task }>;
  updateTask(id: number, body: Record<string, unknown>): Promise<{ task: Task }>;
  transitionTask(id: number, verb: 'start' | 'done'): Promise<{ task: Task }>;
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
    // Browsers add Origin on POSTs automatically; setting it explicitly keeps
    // embedded webviews and the test environment on the identical path, so
    // writes always classify as the web actor (ADR-0006).
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: window.location.origin },
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
    createTask: (body) => sendJson('/tasks', 'POST', body),
    updateTask: (id, body) => sendJson(`/tasks/${id}`, 'PATCH', body),
    transitionTask: (id, verb) => sendJson(`/tasks/${id}/${verb}`, 'POST', {}),
    annotate: (id, body) => sendJson(`/tasks/${id}/annotations`, 'POST', { body }),
  };
}

export const httpApi: Api = createHttpApi();
