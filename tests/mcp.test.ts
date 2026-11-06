import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { startDaemon, type DaemonHandle } from './helpers/daemon.js';

/**
 * MCP surface tests: the official client SDK against /mcp on the real daemon.
 * The project tools must behave identically to the HTTP API — same JSON
 * payloads on success, same message text on errors (surfaced as tool errors).
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

test('official MCP client initializes at /mcp and sees the project tools', async () => {
  const client = await connectClient();
  try {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['project_create', 'project_current', 'project_list']);
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
