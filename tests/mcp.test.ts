import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { startDaemon, type DaemonHandle } from './helpers/daemon.js';

/**
 * MCP surface tests: the official client SDK against /mcp on the real daemon.
 * The project and task tools must behave identically to the HTTP API — same
 * JSON payloads on success, same message text on errors (surfaced as tool
 * errors).
 */
let daemon: DaemonHandle;

beforeAll(async () => {
  daemon = await startDaemon();
});

afterAll(async () => {
  await daemon.stop();
});

async function connectClient(): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${daemon.baseUrl}/mcp`));
  await client.connect(transport); // performs the initialize handshake
  return client;
}

function textOf(result: CallToolResult): string {
  const block = result.content[0];
  expect(block?.type).toBe('text');
  return (block as { text: string }).text;
}

function jsonOf(result: CallToolResult): unknown {
  return JSON.parse(textOf(result));
}

test('official MCP client initializes at /mcp and sees the project and task tools', async () => {
  const client = await connectClient();
  try {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'project_create',
      'project_current',
      'project_list',
      'task_create',
      'task_get',
      'task_update',
    ]);
  } finally {
    await client.close();
  }
});

test('project_create and project_list mirror the HTTP API', async () => {
  const client = await connectClient();
  try {
    const created = await client.callTool({
      name: 'project_create',
      arguments: { name: 'gamma', paths: ['/workspace/gamma/main/', '/workspace/gamma/checkout'] },
    });
    expect(created.isError).toBeFalsy();
    expect(jsonOf(created)).toMatchObject({
      project: {
        name: 'gamma',
        paths: ['/workspace/gamma/checkout', '/workspace/gamma/main'], // canonical, sorted
        openTaskCount: 0,
      },
    });

    const listed = await client.callTool({ name: 'project_list', arguments: {} });
    expect(listed.isError).toBeFalsy();
    const payload = jsonOf(listed) as { projects: { name: string; paths: string[]; openTaskCount: number }[] };
    const gamma = payload.projects.find((project) => project.name === 'gamma');
    expect(gamma?.paths).toEqual(['/workspace/gamma/checkout', '/workspace/gamma/main']);
    expect(gamma?.openTaskCount).toBe(0);
  } finally {
    await client.close();
  }
});

test('project_current resolves nested cwds to the most specific project', async () => {
  const client = await connectClient();
  try {
    await client.callTool({
      name: 'project_create',
      arguments: { name: 'mcp-outer', paths: ['/workspace/mcp-nest'] },
    });
    await client.callTool({
      name: 'project_create',
      arguments: { name: 'mcp-inner', paths: ['/workspace/mcp-nest/deep'] },
    });

    const deep = await client.callTool({ name: 'project_current', arguments: { cwd: '/workspace/mcp-nest/deep/x' } });
    expect(deep.isError).toBeFalsy();
    const deepPayload = jsonOf(deep) as { project: { name: string }; matchedPath: string };
    expect(deepPayload.project.name).toBe('mcp-inner');
    expect(deepPayload.matchedPath).toBe('/workspace/mcp-nest/deep');

    const shallow = await client.callTool({ name: 'project_current', arguments: { cwd: '/workspace/mcp-nest/y' } });
    expect(shallow.isError).toBeFalsy();
    expect((jsonOf(shallow) as { project: { name: string } }).project.name).toBe('mcp-outer');
  } finally {
    await client.close();
  }
});

test('project_current resolves a multi-path project from every bound path', async () => {
  const client = await connectClient();
  try {
    await client.callTool({
      name: 'project_create',
      arguments: { name: 'mcp-dual', paths: ['/workspace/mcp-dual/a', '/workspace/mcp-dual/b'] },
    });

    for (const cwd of ['/workspace/mcp-dual/a/one', '/workspace/mcp-dual/b/two']) {
      const result = await client.callTool({ name: 'project_current', arguments: { cwd } });
      expect(result.isError).toBeFalsy();
      expect((jsonOf(result) as { project: { name: string } }).project.name).toBe('mcp-dual');
    }
  } finally {
    await client.close();
  }
});

test('project_current with an unbound cwd returns a tool error naming the fix', async () => {
  const client = await connectClient();
  try {
    const result = await client.callTool({ name: 'project_current', arguments: { cwd: '/mcp/nowhere' } });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('/mcp/nowhere');
    expect(text).toContain('project_create'); // the fix is named
  } finally {
    await client.close();
  }
});

test('duplicate name and duplicate path surface as tool errors with the same messages as HTTP', async () => {
  const client = await connectClient();
  try {
    await client.callTool({
      name: 'project_create',
      arguments: { name: 'mcp-dupe', paths: ['/workspace/mcp-owned'] },
    });

    const dupeName = await client.callTool({
      name: 'project_create',
      arguments: { name: 'mcp-dupe', paths: ['/workspace/mcp-other'] },
    });
    expect(dupeName.isError).toBe(true);
    expect(textOf(dupeName)).toContain('project name already exists: mcp-dupe');

    const dupePath = await client.callTool({
      name: 'project_create',
      arguments: { name: 'mcp-squatter', paths: ['/workspace/mcp-owned'] },
    });
    expect(dupePath.isError).toBe(true);
    expect(textOf(dupePath)).toContain('path already bound to project mcp-dupe: /workspace/mcp-owned');

    // The HTTP API reports the identical message text for the same situation.
    const response = await fetch(`${daemon.baseUrl}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'mcp-squatter', paths: ['/workspace/mcp-owned'] }),
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain(
      'path already bound to project mcp-dupe: /workspace/mcp-owned',
    );
  } finally {
    await client.close();
  }
});

// ---------------------------------------------------------------------------
// Task tools — must mirror the HTTP API: same JSON payloads on success, same
// message text on errors (surfaced as tool errors).
// ---------------------------------------------------------------------------

async function mcpCreateTask(client: Client, body: Record<string, unknown>): Promise<Record<string, any>> {
  const result = await client.callTool({ name: 'task_create', arguments: body });
  expect(result.isError).toBeFalsy();
  return jsonOf(result) as Record<string, any>;
}

test('task_create with an explicit project mirrors the HTTP API, normalizing tags', async () => {
  const client = await connectClient();
  try {
    await client.callTool({
      name: 'project_create',
      arguments: { name: 'mcp-tasks', paths: ['/workspace/mcp-tasks'] },
    });

    const created = await mcpCreateTask(client, {
      title: 'MCP task',
      project: 'mcp-tasks',
      tags: ['Agent', 'agent', ' Ops '],
      priority: 'M',
      due: '2026-12-31T00:00:00Z',
      effort: '1h',
      hidden_until: '2026-12-01T00:00:00Z',
    });

    expect(created.task).toMatchObject({
      id: expect.any(Number),
      title: 'MCP task',
      status: 'pending',
      projectName: 'mcp-tasks',
      parentId: null,
      tags: ['agent', 'ops'],
      priority: 'M',
      due: '2026-12-31T00:00:00Z',
      effort: '1h',
      hiddenUntil: '2026-12-01T00:00:00Z',
    });

    // Same story over HTTP: the created task is readable at its id.
    const response = await fetch(`${daemon.baseUrl}/tasks/${created.task.id}`);
    expect(response.status).toBe(200);
    const detail = (await response.json()) as { task: { title: string; tags: string[] } };
    expect(detail.task.title).toBe('MCP task');
    expect(detail.task.tags).toEqual(['agent', 'ops']);
  } finally {
    await client.close();
  }
});

test('task_create resolves the project from cwd', async () => {
  const client = await connectClient();
  try {
    await client.callTool({
      name: 'project_create',
      arguments: { name: 'mcp-cwd', paths: ['/workspace/mcp-cwd/nested'] },
    });

    const task = await mcpCreateTask(client, { title: 'From cwd', cwd: '/workspace/mcp-cwd/nested/deep/file.ts' });
    expect(task.task.projectName).toBe('mcp-cwd');
  } finally {
    await client.close();
  }
});

test('task_create without project or cwd returns the same message as the HTTP API', async () => {
  const client = await connectClient();
  try {
    const result = await client.callTool({ name: 'task_create', arguments: { title: 'No scope' } });
    expect(result.isError).toBe(true);
    const message = textOf(result);
    expect(message).toContain('project_create'); // the fix is named

    // Identical message text over HTTP for the same situation.
    const response = await fetch(`${daemon.baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'No scope either' }),
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe(message);
  } finally {
    await client.close();
  }
});

test('task_get returns the task plus a children summary', async () => {
  const client = await connectClient();
  try {
    const parent = await mcpCreateTask(client, { title: 'MCP parent', project: 'mcp-tasks' });
    const child = await mcpCreateTask(client, { title: 'MCP child', project: 'mcp-tasks', parent: parent.task.id });

    const detail = (await client.callTool({
      name: 'task_get',
      arguments: { id: parent.task.id },
    })) as CallToolResult;
    expect(detail.isError).toBeFalsy();

    const payload = jsonOf(detail) as { task: { id: number; parentId: number | null }; children: { id: number; title: string; status: string }[] };
    expect(payload.task.id).toBe(parent.task.id);
    expect(payload.children).toEqual([{ id: child.task.id, title: 'MCP child', status: 'pending' }]);
  } finally {
    await client.close();
  }
});

test('task_update reparents and replaces tags', async () => {
  const client = await connectClient();
  try {
    const root = await mcpCreateTask(client, { title: 'New root', project: 'mcp-tasks' });
    const moving = await mcpCreateTask(client, { title: 'Moving task', project: 'mcp-tasks' });

    const updated = await client.callTool({
      name: 'task_update',
      arguments: { id: moving.task.id, parent: root.task.id, tags: ['Fresh', 'fresh'], title: 'Moved task' },
    });
    expect(updated.isError).toBeFalsy();
    expect(jsonOf(updated)).toMatchObject({
      task: { parentId: root.task.id, title: 'Moved task', tags: ['fresh'] },
    });
  } finally {
    await client.close();
  }
});

test('task_update rejects an ancestor cycle with the cycle path in the message', async () => {
  const client = await connectClient();
  try {
    const top = await mcpCreateTask(client, { title: 'Cycle top', project: 'mcp-tasks' });
    const middle = await mcpCreateTask(client, { title: 'Cycle middle', project: 'mcp-tasks', parent: top.task.id });
    const bottom = await mcpCreateTask(client, { title: 'Cycle bottom', project: 'mcp-tasks', parent: middle.task.id });

    const result = await client.callTool({
      name: 'task_update',
      arguments: { id: top.task.id, parent: bottom.task.id },
    });
    expect(result.isError).toBe(true);
    const message = textOf(result);
    expect(message).toContain('cycle');
    expect(message).toContain(`${top.task.id} -> ${bottom.task.id} -> ${middle.task.id} -> ${top.task.id}`);
  } finally {
    await client.close();
  }
});

test('task_update rejects status changes, project moves, and deps', async () => {
  const client = await connectClient();
  try {
    const task = await mcpCreateTask(client, { title: 'Restricted', project: 'mcp-tasks' });

    for (const arguments_ of [
      { id: task.task.id, status: 'active' },
      { id: task.task.id, project: 'mcp-cwd' },
      { id: task.task.id, deps: [task.task.id + 100] },
    ]) {
      const result = await client.callTool({ name: 'task_update', arguments: arguments_ });
      expect(result.isError).toBe(true);
    }

    const atCreate = await client.callTool({
      name: 'task_create',
      arguments: { title: 'No status at create', project: 'mcp-tasks', status: 'pending' },
    });
    expect(atCreate.isError).toBe(true);
    expect(textOf(atCreate)).toContain('status');
  } finally {
    await client.close();
  }
});

test('task tools report unknown ids as tool errors', async () => {
  const client = await connectClient();
  try {
    const got = await client.callTool({ name: 'task_get', arguments: { id: 999999 } });
    expect(got.isError).toBe(true);
    expect(textOf(got)).toContain('unknown task id');

    const updated = await client.callTool({ name: 'task_update', arguments: { id: 999999, title: 'Nope' } });
    expect(updated.isError).toBe(true);
    expect(textOf(updated)).toContain('unknown task id');
  } finally {
    await client.close();
  }
});
