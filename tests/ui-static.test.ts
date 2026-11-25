import { afterAll, beforeAll, expect, test } from 'vitest';
import { startDaemon, type DaemonHandle } from './helpers/daemon.js';

/**
 * Process-level tests for the /ui static surface (v0.3 T2, ADR-0006/0007):
 * the daemon serves the built SPA at /ui with SPA fallback and correct
 * content types, deep sub-paths fall back to index.html (client-side routing
 * owns unknown paths), traversal escapes are refused, and writes are 405.
 *
 * Assertions are discovery-based where possible: the built asset filenames
 * are content-hashed, so the JS bundle URL is parsed out of the served HTML
 * rather than hardcoded.
 */

let daemon: DaemonHandle;

beforeAll(async () => {
  daemon = await startDaemon();
});

afterAll(async () => {
  await daemon.stop();
});

test('GET /ui serves the SPA shell as HTML; bare /ui redirects nothing special', async () => {
  for (const path of ['/ui', '/ui/']) {
    const response = await fetch(`${daemon.baseUrl}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('<div id="app">');
    expect(html).toMatch(/\/ui\/assets\/.+\.js/); // the built bundle is referenced at its mounted base
  }
});

test('the hashed asset referenced by the shell is served with a JS content type', async () => {
  const html = await (await fetch(`${daemon.baseUrl}/ui/`)).text();
  const src = html.match(/src="(\/ui\/assets\/[^"]+\.js)"/)?.[1];
  expect(src).toBeTruthy();

  const asset = await fetch(`${daemon.baseUrl}${src}`);
  expect(asset.status).toBe(200);
  expect(asset.headers.get('content-type')).toMatch(/javascript|ecmascript/);
});

test('deep SPA sub-paths fall back to the shell (client-side routing owns them)', async () => {
  for (const path of ['/ui/tasks/42', '/ui/projects', '/ui/definitely-not-a-page']) {
    const response = await fetch(`${daemon.baseUrl}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<div id="app">');
  }
});

test('path traversal out of the static root is refused', async () => {
  // fetch itself normalizes literal ../ segments, so the wire form is percent-encoded
  const response = await fetch(`${daemon.baseUrl}/ui/%2e%2e/%2e%2e/package.json`);
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain('"name"');
});

test('writes to /ui are 405', async () => {
  const response = await fetch(`${daemon.baseUrl}/ui/`, { method: 'POST' });
  expect(response.status).toBe(405);
});
