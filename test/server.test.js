'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocdash-'));
process.env.DATA_DIR = dataDir;
process.env.PORT = '0';
process.env.OPENCLAW_CONFIG = path.join(dataDir, 'openclaw.json');
process.env.OPENCLAW_GATEWAY_URL = 'http://127.0.0.1:1';
process.env.OLLAMA_URL = 'http://127.0.0.1:1';

fs.writeFileSync(process.env.OPENCLAW_CONFIG, `{
  // JSON5 with comments, unquoted keys and trailing commas
  agents: { defaults: { model: { primary: 'anthropic/claude-opus-5-5', fallbacks: ["openai/gpt-5",], }, }, },
  url: "http://example.com/a//b",
}`);

const { start, json5ToJson } = require('../server.js');

let server, base;
test.before(async () => {
  server = await start();
  await new Promise((r) => server.listening ? r() : server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const req = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test('json5 parsing keeps strings intact', () => {
  assert.deepStrictEqual(JSON.parse(json5ToJson(`{a: 'it"s', b: "x // y", /* c */ d: [1,2,],}`)), { a: 'it"s', b: 'x // y', d: [1, 2] });
});

test('serves default layout and stats', async () => {
  const d = await req('GET', '/api/dashboard');
  assert.ok(d.body.widgets.some((w) => w.type === 'model'));
  const s = await req('GET', '/api/stats');
  assert.ok(s.body.memory.total > 0);
  assert.ok(s.body.cpu.cores > 0);
});

test('model falls back to openclaw.json, then prefers reports', async () => {
  let m = await req('GET', '/api/model');
  assert.strictEqual(m.body.active.model, 'claude-opus-5-5');
  assert.strictEqual(m.body.active.provider, 'anthropic');
  assert.strictEqual(m.body.active.source, 'config');
  assert.deepStrictEqual(m.body.config.fallbacks, ['openai/gpt-5']);

  await req('POST', '/api/model', { model: 'ollama/llama3.3', status: 'thinking' });
  m = await req('POST', '/api/model', { contextTokens: 100 });
  assert.strictEqual(m.body.active.model, 'llama3.3');
  assert.strictEqual(m.body.reported.status, 'thinking');
  assert.strictEqual(m.body.reported.contextTokens, 100);
});

test('widget CRUD', async () => {
  const add = await req('POST', '/api/widgets', { type: 'text', title: 'My Notes', options: { text: 'hi' }, position: 0 });
  assert.strictEqual(add.status, 201);
  assert.strictEqual(add.body.id, 'my-notes');
  assert.strictEqual((await req('GET', '/api/widgets')).body[0].id, 'my-notes');

  assert.strictEqual((await req('POST', '/api/widgets', { type: 'text', title: 'My Notes', options: { text: 'x' } })).body.id, 'my-notes-2');
  assert.strictEqual((await req('POST', '/api/widgets', { type: 'nope' })).status, 400);
  assert.strictEqual((await req('POST', '/api/widgets', { type: 'text' })).status, 400);
  assert.strictEqual((await req('POST', '/api/widgets', { id: 'my-notes', type: 'cpu' })).status, 409);

  const patched = await req('PATCH', '/api/widgets/my-notes', { size: 'md', options: { text: 'updated' } });
  assert.strictEqual(patched.body.options.text, 'updated');
  assert.strictEqual(patched.body.size, 'md');

  await req('POST', '/api/widgets/my-notes/move', { by: 1 });
  assert.strictEqual((await req('GET', '/api/widgets')).body[1].id, 'my-notes');

  assert.strictEqual((await req('DELETE', '/api/widgets/my-notes')).status, 200);
  assert.strictEqual((await req('DELETE', '/api/widgets/my-notes')).status, 404);

  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'dashboard.json'), 'utf8'));
  assert.ok(!onDisk.widgets.some((w) => w.id === 'my-notes'));
});

test('editing dashboard.json on disk reloads the layout', async () => {
  const file = path.join(dataDir, 'dashboard.json');
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  d.widgets.push({ id: 'from-file', type: 'cpu' });
  fs.writeFileSync(file, JSON.stringify(d));
  for (let i = 0; i < 40; i++) {
    if ((await req('GET', '/api/widgets')).body.some((w) => w.id === 'from-file')) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail('layout was not reloaded');
});

test('alerts', async () => {
  const a = await req('POST', '/api/alerts', { level: 'warning', title: 'Quota high' });
  assert.strictEqual(a.status, 201);
  let list = (await req('GET', '/api/alerts')).body;
  assert.ok(list.some((x) => x.id === a.body.id));
  assert.strictEqual((await req('POST', '/api/alerts', { level: 'bad', title: 'x' })).status, 400);
  await req('DELETE', `/api/alerts/${a.body.id}`);
  list = (await req('GET', '/api/alerts')).body;
  assert.ok(!list.some((x) => x.id === a.body.id));
});

test('static files are served and traversal blocked', async () => {
  const res = await fetch(`${base}/`);
  assert.match(await res.text(), /OpenClaw Dashboard/);
  assert.notStrictEqual((await fetch(`${base}/%2e%2e/server.js`)).status, 200);
});
