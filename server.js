#!/usr/bin/env node
'use strict';

// OpenClaw Dashboard: zero-dependency server.
// - Serves the dashboard UI from ./public
// - Exposes live system + model stats
// - Lets OpenClaw (or anything else) add/remove/update widgets over REST,
//   or by editing data/dashboard.json directly (the file is watched).

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

const CONFIG = {
  port: Number(process.env.PORT || 7070),
  host: process.env.HOST || '127.0.0.1',
  token: process.env.DASHBOARD_TOKEN || '',
  dataDir: path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')),
  openclawConfig: process.env.OPENCLAW_CONFIG || path.join(os.homedir(), '.openclaw', 'openclaw.json'),
  gatewayUrl: process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789',
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  modelStaleMs: Number(process.env.MODEL_STALE_MS || 10 * 60 * 1000),
  probeIntervalMs: Number(process.env.PROBE_INTERVAL_MS || 10000),
};

const DASHBOARD_FILE = path.join(CONFIG.dataDir, 'dashboard.json');
const DEFAULT_DASHBOARD_FILE = path.join(ROOT, 'data', 'dashboard.default.json');
const ALERTS_FILE = path.join(CONFIG.dataDir, 'alerts.json');
const MODEL_FILE = path.join(CONFIG.dataDir, 'model.json');

// ---------------------------------------------------------------------------
// Widget catalogue. Served at GET /api/widget-types so the agent can discover
// what it is allowed to add.
// ---------------------------------------------------------------------------

const WIDGET_TYPES = {
  model: { description: 'Active model card: model, provider, status, token/context usage, gateway health.', options: {} },
  alerts: { description: 'Important information feed (posted alerts + automatic system warnings).', options: { limit: 'number, max items shown (default 10)', levels: 'array of levels to show, e.g. ["warning","error"]' } },
  cpu: { description: 'CPU usage % with history sparkline, load average, core count.', options: {} },
  memory: { description: 'RAM usage with history sparkline, plus swap.', options: {} },
  disk: { description: 'Disk usage for a mount path.', options: { path: 'string, filesystem path to measure (default "/")' } },
  gpu: { description: 'NVIDIA GPU utilisation, VRAM and temperature (needs nvidia-smi).', options: {} },
  network: { description: 'Network throughput (Linux) and local addresses.', options: {} },
  system: { description: 'Host info: hostname, OS, uptime, Node version, temperature.', options: {} },
  'local-models': { description: 'Models currently loaded in Ollama (name, size, VRAM, expiry).', options: {} },
  text: { description: 'Free text / notes. Supports **bold**, `code`, and line breaks.', options: { text: 'string (required)' } },
  kv: { description: 'Key/value table for arbitrary facts.', options: { items: 'object of key -> value (required)' } },
  json: { description: 'Value pulled from a JSON HTTP endpoint (fetched server-side).', options: { url: 'http(s) URL (required)', path: 'dot path into the JSON, e.g. "data.0.price"', unit: 'string suffix', intervalMs: 'refresh interval, default 10000' } },
  iframe: { description: 'Embed another web page (sandboxed).', options: { url: 'http(s) URL (required)', height: 'pixels, default 300' } },
};
const SIZES = ['sm', 'md', 'lg', 'full'];
const ALERT_LEVELS = ['info', 'success', 'warning', 'error'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function isHttpUrl(s) {
  try { return ['http:', 'https:'].includes(new URL(s).protocol); } catch { return false; }
}

function validateWidget(w, { partial = false } = {}) {
  if (!isPlainObject(w)) throw new HttpError(400, 'widget must be an object');
  const out = {};
  if (!partial || w.id !== undefined) {
    if (typeof w.id !== 'string' || !ID_RE.test(w.id)) throw new HttpError(400, `invalid widget id ${JSON.stringify(w.id)} (letters, digits, - and _, max 64)`);
    out.id = w.id;
  }
  if (!partial || w.type !== undefined) {
    if (!Object.hasOwn(WIDGET_TYPES, w.type)) throw new HttpError(400, `unknown widget type ${JSON.stringify(w.type)}; see GET /api/widget-types`);
    out.type = w.type;
  }
  if (w.title !== undefined) {
    if (typeof w.title !== 'string' || w.title.length > 80) throw new HttpError(400, 'title must be a string of at most 80 chars');
    out.title = w.title;
  }
  if (w.size !== undefined) {
    if (!SIZES.includes(w.size)) throw new HttpError(400, `size must be one of ${SIZES.join(', ')}`);
    out.size = w.size;
  }
  if (w.options !== undefined) {
    if (!isPlainObject(w.options)) throw new HttpError(400, 'options must be an object');
    if (JSON.stringify(w.options).length > 20000) throw new HttpError(400, 'options too large');
    out.options = w.options;
  }
  return out;
}

function checkWidgetOptions(w) {
  const o = w.options || {};
  if (w.type === 'text' && typeof o.text !== 'string') throw new HttpError(400, 'text widget needs options.text');
  if (w.type === 'kv' && !isPlainObject(o.items)) throw new HttpError(400, 'kv widget needs options.items object');
  if ((w.type === 'json' || w.type === 'iframe') && !isHttpUrl(o.url)) throw new HttpError(400, `${w.type} widget needs an http(s) options.url`);
  if (w.type === 'disk' && o.path !== undefined && typeof o.path !== 'string') throw new HttpError(400, 'disk options.path must be a string');
}

function validateDashboard(d) {
  if (!isPlainObject(d)) throw new HttpError(400, 'dashboard must be an object');
  if (!Array.isArray(d.widgets)) throw new HttpError(400, 'dashboard.widgets must be an array');
  const ids = new Set();
  const widgets = d.widgets.map((raw) => {
    const w = validateWidget(raw);
    checkWidgetOptions(w);
    if (ids.has(w.id)) throw new HttpError(400, `duplicate widget id ${w.id}`);
    ids.add(w.id);
    return { size: 'sm', ...w };
  });
  const out = {
    title: typeof d.title === 'string' ? d.title.slice(0, 120) : 'OpenClaw Dashboard',
    refreshMs: Math.min(60000, Math.max(1000, Number(d.refreshMs) || 2000)),
    widgets,
  };
  if (isPlainObject(d.thresholds)) out.thresholds = d.thresholds;
  return out;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}

// ---------------------------------------------------------------------------
// SSE broadcasting
// ---------------------------------------------------------------------------

const sseClients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

// ---------------------------------------------------------------------------
// Dashboard config state
// ---------------------------------------------------------------------------

let dashboard = null;
let lastDashboardText = '';

async function loadDashboard() {
  await fsp.mkdir(CONFIG.dataDir, { recursive: true });
  let text;
  try {
    text = await fsp.readFile(DASHBOARD_FILE, 'utf8');
  } catch {
    text = await fsp.readFile(DEFAULT_DASHBOARD_FILE, 'utf8');
    await writeAtomic(DASHBOARD_FILE, text);
  }
  dashboard = validateDashboard(JSON.parse(text));
  lastDashboardText = text;
}

async function saveDashboard(next) {
  dashboard = validateDashboard(next);
  lastDashboardText = JSON.stringify(dashboard, null, 2) + '\n';
  await writeAtomic(DASHBOARD_FILE, lastDashboardText);
  broadcast('dashboard', dashboard);
  return dashboard;
}

let watchTimer = null;
function watchDashboardFile() {
  // Watch the directory rather than the file so atomic renames are picked up.
  const watcher = fs.watch(CONFIG.dataDir, (_evt, filename) => {
    if (filename && filename !== 'dashboard.json') return;
    clearTimeout(watchTimer);
    watchTimer = setTimeout(async () => {
      let text;
      try { text = await fsp.readFile(DASHBOARD_FILE, 'utf8'); } catch { return; }
      if (text === lastDashboardText) return;
      lastDashboardText = text;
      try {
        dashboard = validateDashboard(JSON.parse(text));
        broadcast('dashboard', dashboard);
        console.log('[dashboard] reloaded dashboard.json from disk');
      } catch (err) {
        await addAlert({ level: 'error', title: 'dashboard.json is invalid', message: `${err.message}. Keeping the last valid layout.`, source: 'dashboard' });
      }
    }, 150);
  });
  watcher.unref();
}

// ---------------------------------------------------------------------------
// Alerts ("important information")
// ---------------------------------------------------------------------------

let alerts = [];

async function addAlert(input) {
  if (!isPlainObject(input)) throw new HttpError(400, 'alert must be an object');
  const level = input.level || 'info';
  if (!ALERT_LEVELS.includes(level)) throw new HttpError(400, `level must be one of ${ALERT_LEVELS.join(', ')}`);
  if (typeof input.title !== 'string' || !input.title.trim()) throw new HttpError(400, 'alert needs a title');
  const alert = {
    id: crypto.randomUUID().slice(0, 8),
    level,
    title: input.title.slice(0, 200),
    message: typeof input.message === 'string' ? input.message.slice(0, 4000) : '',
    source: typeof input.source === 'string' ? input.source.slice(0, 60) : 'openclaw',
    ts: Date.now(),
  };
  const ttl = Number(input.ttlMs);
  if (ttl > 0) alert.expiresAt = alert.ts + ttl;
  alerts.unshift(alert);
  alerts = alerts.slice(0, 200);
  await persistAlerts();
  return alert;
}

async function persistAlerts() {
  await writeAtomic(ALERTS_FILE, JSON.stringify(alerts, null, 2));
  broadcast('alerts', currentAlerts());
}

function pruneExpiredAlerts() {
  const now = Date.now();
  const before = alerts.length;
  alerts = alerts.filter((a) => !a.expiresAt || a.expiresAt > now);
  return alerts.length !== before;
}

// Automatic warnings derived from live stats; never stored.
function systemAlerts() {
  const t = { cpu: 90, memory: 90, disk: 90, gpuTemp: 85, ...(dashboard?.thresholds || {}) };
  const out = [];
  const push = (id, level, title, message) => out.push({ id: `sys-${id}`, level, title, message, source: 'system', ts: Date.now(), system: true });
  if (stats.cpu && stats.cpu.usage >= t.cpu) push('cpu', 'warning', `CPU at ${stats.cpu.usage.toFixed(0)}%`, `Above the ${t.cpu}% threshold.`);
  if (stats.memory && stats.memory.percent >= t.memory) push('mem', 'warning', `Memory at ${stats.memory.percent.toFixed(0)}%`, `Above the ${t.memory}% threshold.`);
  for (const d of stats.disks || []) {
    if (d.percent >= t.disk) push(`disk-${d.path}`, 'warning', `Disk ${d.path} at ${d.percent.toFixed(0)}%`, `Above the ${t.disk}% threshold.`);
  }
  for (const g of stats.gpus || []) {
    if (g.temperature >= t.gpuTemp) push(`gpu-${g.index}`, 'warning', `GPU ${g.index} at ${g.temperature}°C`, `Above the ${t.gpuTemp}°C threshold.`);
  }
  if (modelState.gateway && modelState.gateway.online === false) {
    push('gateway', 'error', 'OpenClaw gateway unreachable', `No response from ${modelState.gateway.url}.`);
  }
  return out;
}

function currentAlerts() {
  return [...systemAlerts(), ...alerts];
}

// ---------------------------------------------------------------------------
// System stats
// ---------------------------------------------------------------------------

const HISTORY_LEN = 60;
const stats = { ts: 0, cpu: null, memory: null, disks: [], gpus: [], network: null, system: null, history: { cpu: [], memory: [] } };
let prevCpu = null;
let prevNet = null;
let gpuDisabledUntil = 0;

function cpuTimes() {
  return os.cpus().map((c) => {
    const t = c.times;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
  });
}

function sampleCpu() {
  const now = cpuTimes();
  let usage = 0;
  if (prevCpu && prevCpu.length === now.length) {
    let idle = 0, total = 0;
    now.forEach((c, i) => { idle += c.idle - prevCpu[i].idle; total += c.total - prevCpu[i].total; });
    usage = total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0;
  }
  prevCpu = now;
  const cpus = os.cpus();
  return { usage, cores: cpus.length, model: cpus[0]?.model?.trim() || 'unknown', speedMHz: cpus[0]?.speed || 0, load: os.loadavg() };
}

async function sampleMemory() {
  const total = os.totalmem();
  let available = os.freemem();
  let swapTotal = 0, swapFree = 0;
  if (process.platform === 'linux') {
    try {
      const info = await fsp.readFile('/proc/meminfo', 'utf8');
      const kb = (k) => { const m = info.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')); return m ? Number(m[1]) * 1024 : null; };
      available = kb('MemAvailable') ?? available;
      swapTotal = kb('SwapTotal') ?? 0;
      swapFree = kb('SwapFree') ?? 0;
    } catch { /* fall back to os.freemem */ }
  }
  const used = total - available;
  return { total, used, available, percent: (used / total) * 100, swapTotal, swapUsed: swapTotal - swapFree };
}

function diskPaths() {
  const paths = new Set();
  for (const w of dashboard?.widgets || []) {
    if (w.type === 'disk') paths.add(w.options?.path || defaultDiskPath());
  }
  if (!paths.size) paths.add(defaultDiskPath());
  return [...paths];
}

function defaultDiskPath() {
  return process.platform === 'win32' ? path.parse(process.cwd()).root : '/';
}

async function sampleDisks() {
  const out = [];
  for (const p of diskPaths()) {
    try {
      const s = await fsp.statfs(p);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      const used = total - s.bfree * s.bsize;
      out.push({ path: p, total, used, free, percent: total ? (used / (used + free)) * 100 : 0 });
    } catch (err) {
      out.push({ path: p, error: err.code || err.message });
    }
  }
  return out;
}

function run(cmd, args, timeout = 3000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

async function sampleGpus() {
  if (Date.now() < gpuDisabledUntil) return [];
  try {
    const out = await run('nvidia-smi', ['--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw', '--format=csv,noheader,nounits']);
    return out.trim().split('\n').filter(Boolean).map((line) => {
      const [index, name, util, memUsed, memTotal, temp, power] = line.split(',').map((s) => s.trim());
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
      return { index: num(index), name, utilization: num(util), memoryUsed: num(memUsed) * 1024 * 1024, memoryTotal: num(memTotal) * 1024 * 1024, temperature: num(temp), powerW: num(power) };
    });
  } catch {
    gpuDisabledUntil = Date.now() + 60000; // don't spawn a failing process every tick
    return [];
  }
}

async function sampleNetwork() {
  const addresses = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (!a.internal && a.family === 'IPv4') addresses.push({ iface: name, address: a.address });
  }
  if (process.platform !== 'linux') return { addresses, rxRate: null, txRate: null };
  try {
    const text = await fsp.readFile('/proc/net/dev', 'utf8');
    let rx = 0, tx = 0;
    for (const line of text.split('\n').slice(2)) {
      const [iface, rest] = line.split(':');
      if (!rest || iface.trim() === 'lo') continue;
      const f = rest.trim().split(/\s+/).map(Number);
      rx += f[0]; tx += f[8];
    }
    const now = Date.now();
    let rxRate = null, txRate = null;
    if (prevNet) {
      const dt = (now - prevNet.ts) / 1000;
      if (dt > 0) { rxRate = Math.max(0, (rx - prevNet.rx) / dt); txRate = Math.max(0, (tx - prevNet.tx) / dt); }
    }
    prevNet = { rx, tx, ts: now };
    return { addresses, rxRate, txRate, rxTotal: rx, txTotal: tx };
  } catch {
    return { addresses, rxRate: null, txRate: null };
  }
}

async function readTemperature() {
  if (process.platform !== 'linux') return null;
  try {
    const zones = (await fsp.readdir('/sys/class/thermal')).filter((z) => z.startsWith('thermal_zone'));
    let max = null;
    for (const z of zones) {
      const v = Number(await fsp.readFile(`/sys/class/thermal/${z}/temp`, 'utf8').catch(() => NaN)) / 1000;
      if (Number.isFinite(v) && v > 0 && (max === null || v > max)) max = v;
    }
    return max;
  } catch { return null; }
}

async function sampleSystem() {
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    uptime: os.uptime(),
    node: process.version,
    temperature: await readTemperature(),
    dashboardUptime: process.uptime(),
  };
}

async function sampleStats() {
  const [memory, disks, gpus, network, system] = await Promise.all([sampleMemory(), sampleDisks(), sampleGpus(), sampleNetwork(), sampleSystem()]);
  stats.cpu = sampleCpu();
  Object.assign(stats, { ts: Date.now(), memory, disks, gpus, network, system });
  stats.history.cpu = [...stats.history.cpu, stats.cpu.usage].slice(-HISTORY_LEN);
  stats.history.memory = [...stats.history.memory, memory.percent].slice(-HISTORY_LEN);
  broadcast('stats', stats);
}

// ---------------------------------------------------------------------------
// Model state: what OpenClaw reports + what we can discover on our own.
// ---------------------------------------------------------------------------

const modelState = { pushed: null, pushedAt: 0, config: null, gateway: null, ollama: null };

// OpenClaw's config is JSON5. Convert the common subset (comments, trailing
// commas, unquoted keys, single-quoted strings) to strict JSON.
function json5ToJson(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      let s = '';
      i++;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === '\\') { s += src[i] + src[i + 1]; i += 2; continue; }
        s += ch === "'" && src[i] === '"' ? '\\"' : src[i];
        i++;
      }
      out += `"${s}"`;
      i++;
    } else if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (ch === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2);
      i = i === -1 ? src.length : i + 2;
    } else if (/[A-Za-z_$]/.test(ch)) {
      let id = '';
      while (i < src.length && /[\w$]/.test(src[i])) id += src[i++];
      const rest = src.slice(i).match(/^\s*:/);
      out += rest ? `"${id}"` : id;
    } else {
      out += ch;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

async function readOpenClawConfig() {
  let text;
  try { text = await fsp.readFile(CONFIG.openclawConfig, 'utf8'); } catch { return null; }
  try {
    const cfg = JSON.parse(json5ToJson(text));
    const m = cfg?.agents?.defaults?.model ?? cfg?.agent?.model ?? null;
    const primary = typeof m === 'string' ? m : m?.primary ?? null;
    const fallbacks = Array.isArray(m?.fallbacks) ? m.fallbacks : [];
    return { path: CONFIG.openclawConfig, primary, fallbacks };
  } catch (err) {
    return { path: CONFIG.openclawConfig, error: `could not parse: ${err.message}` };
  }
}

async function probe(url, timeoutMs = 2000) {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: true, status: res.status, latencyMs: Date.now() - started, res };
  } catch (err) {
    return { ok: false, error: err.cause?.code || err.name || err.message };
  }
}

async function probeGateway() {
  const p = await probe(CONFIG.gatewayUrl);
  return { url: CONFIG.gatewayUrl, online: p.ok, latencyMs: p.latencyMs ?? null, error: p.error ?? null, checkedAt: Date.now() };
}

async function probeOllama() {
  const p = await probe(`${CONFIG.ollamaUrl.replace(/\/$/, '')}/api/ps`);
  if (!p.ok) return { url: CONFIG.ollamaUrl, online: false, models: [] };
  let body = {};
  try { body = await p.res.json(); } catch { /* not ollama */ }
  const models = (body.models || []).map((m) => ({
    name: m.name || m.model,
    size: m.size ?? null,
    sizeVram: m.size_vram ?? null,
    expiresAt: m.expires_at ?? null,
    params: m.details?.parameter_size ?? null,
    quant: m.details?.quantization_level ?? null,
    family: m.details?.family ?? null,
  }));
  return { url: CONFIG.ollamaUrl, online: true, models };
}

function splitModelRef(ref) {
  if (typeof ref !== 'string') return { provider: null, model: null };
  const i = ref.indexOf('/');
  return i > 0 ? { provider: ref.slice(0, i), model: ref.slice(i + 1) } : { provider: null, model: ref };
}

function modelSnapshot() {
  const fresh = modelState.pushed && Date.now() - modelState.pushedAt < CONFIG.modelStaleMs;
  let active = null;
  if (fresh && modelState.pushed.model) {
    const split = splitModelRef(modelState.pushed.model);
    active = { provider: modelState.pushed.provider || split.provider, model: split.model, source: 'openclaw' };
  } else if (modelState.config?.primary) {
    active = { ...splitModelRef(modelState.config.primary), source: 'config' };
  } else if (modelState.ollama?.models?.length) {
    active = { provider: 'ollama', model: modelState.ollama.models[0].name, source: 'ollama' };
  }
  return { active, reported: modelState.pushed, reportedAt: modelState.pushedAt || null, stale: !!modelState.pushed && !fresh, ...modelState, pushed: undefined, pushedAt: undefined };
}

async function refreshModel() {
  const [config, gateway, ollama] = await Promise.all([readOpenClawConfig(), probeGateway(), probeOllama()]);
  Object.assign(modelState, { config, gateway, ollama });
  if (pruneExpiredAlerts()) await persistAlerts();
  broadcast('model', modelSnapshot());
  broadcast('alerts', currentAlerts());
}

async function reportModel(body) {
  if (!isPlainObject(body)) throw new HttpError(400, 'body must be an object');
  if (JSON.stringify(body).length > 20000) throw new HttpError(400, 'report too large');
  const { reset, ...fields } = body;
  modelState.pushed = reset || !modelState.pushed ? fields : { ...modelState.pushed, ...fields };
  modelState.pushedAt = Date.now();
  await writeAtomic(MODEL_FILE, JSON.stringify({ pushed: modelState.pushed, pushedAt: modelState.pushedAt }, null, 2));
  const snap = modelSnapshot();
  broadcast('model', snap);
  return snap;
}

// ---------------------------------------------------------------------------
// json widget: fetch a remote JSON value server-side (avoids CORS).
// ---------------------------------------------------------------------------

async function fetchWidgetData(widget) {
  const o = widget.options || {};
  if (!isHttpUrl(o.url)) throw new HttpError(400, 'widget has no http(s) url');
  const res = await fetch(o.url, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new HttpError(502, `upstream returned ${res.status}`);
  let value = await res.json();
  for (const key of String(o.path || '').split('.').filter(Boolean)) value = value?.[key];
  return { value: value ?? null, fetchedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'body is not valid JSON'); }
}

function authorized(req) {
  if (!CONFIG.token) return true;
  const header = req.headers.authorization || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-dashboard-token'] || '';
  const a = Buffer.from(String(given));
  const b = Buffer.from(CONFIG.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'forbidden' });
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'content-type': `${MIME[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

function findWidget(id) {
  const index = dashboard.widgets.findIndex((w) => w.id === id);
  if (index === -1) throw new HttpError(404, `no widget with id ${id}`);
  return index;
}

function uniqueId(base) {
  let id = base || 'widget';
  for (let n = 2; dashboard.widgets.some((w) => w.id === id); n++) id = `${base}-${n}`;
  return id;
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const method = req.method;
  const isWrite = !['GET', 'HEAD'].includes(method);
  if (isWrite && !authorized(req)) throw new HttpError(401, 'missing or invalid token');
  const [resource, id, action] = parts;

  if (resource === 'health' && method === 'GET') return send(res, 200, { ok: true, uptime: process.uptime() });

  if (resource === 'events' && method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    res.write(`event: dashboard\ndata: ${JSON.stringify(dashboard)}\n\n`);
    res.write(`event: stats\ndata: ${JSON.stringify(stats)}\n\n`);
    res.write(`event: model\ndata: ${JSON.stringify(modelSnapshot())}\n\n`);
    res.write(`event: alerts\ndata: ${JSON.stringify(currentAlerts())}\n\n`);
    return;
  }

  if (resource === 'widget-types' && method === 'GET') return send(res, 200, { sizes: SIZES, types: WIDGET_TYPES });

  if (resource === 'dashboard') {
    if (method === 'GET') return send(res, 200, dashboard);
    if (method === 'PUT') return send(res, 200, await saveDashboard(await readBody(req)));
    if (method === 'PATCH') {
      const body = await readBody(req);
      const next = { ...dashboard };
      for (const k of ['title', 'refreshMs', 'thresholds']) if (body[k] !== undefined) next[k] = body[k];
      return send(res, 200, await saveDashboard(next));
    }
  }

  if (resource === 'widgets') {
    if (!id && method === 'GET') return send(res, 200, dashboard.widgets);
    if (!id && method === 'POST') {
      const body = await readBody(req);
      const { position, ...raw } = body;
      if (raw.id === undefined) raw.id = uniqueId(slugify(raw.title) || raw.type);
      const w = { size: 'sm', ...validateWidget(raw) };
      checkWidgetOptions(w);
      if (dashboard.widgets.some((x) => x.id === w.id)) throw new HttpError(409, `widget id ${w.id} already exists`);
      const widgets = [...dashboard.widgets];
      const pos = Number.isInteger(position) ? Math.max(0, Math.min(position, widgets.length)) : widgets.length;
      widgets.splice(pos, 0, w);
      await saveDashboard({ ...dashboard, widgets });
      return send(res, 201, w);
    }
    if (id && !action) {
      const index = findWidget(id);
      if (method === 'GET') return send(res, 200, dashboard.widgets[index]);
      if (method === 'DELETE') {
        const widgets = dashboard.widgets.filter((w) => w.id !== id);
        await saveDashboard({ ...dashboard, widgets });
        return send(res, 200, { deleted: id });
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        const patch = validateWidget(body, { partial: true });
        const current = dashboard.widgets[index];
        const merged = { ...current, ...patch, id: current.id };
        if (patch.options && !body.replaceOptions) merged.options = { ...(current.options || {}), ...patch.options };
        checkWidgetOptions(merged);
        const widgets = [...dashboard.widgets];
        widgets[index] = merged;
        await saveDashboard({ ...dashboard, widgets });
        return send(res, 200, merged);
      }
    }
    if (id && action === 'move' && method === 'POST') {
      const index = findWidget(id);
      const body = await readBody(req);
      const widgets = [...dashboard.widgets];
      const [w] = widgets.splice(index, 1);
      let to = Number.isInteger(body.position) ? body.position : index + (Number(body.by) || 0);
      to = Math.max(0, Math.min(to, widgets.length));
      widgets.splice(to, 0, w);
      await saveDashboard({ ...dashboard, widgets });
      return send(res, 200, { id, position: to });
    }
    if (id && action === 'data' && method === 'GET') {
      const w = dashboard.widgets[findWidget(id)];
      if (w.type !== 'json') throw new HttpError(400, 'only json widgets have remote data');
      try { return send(res, 200, await fetchWidgetData(w)); } catch (err) {
        throw err instanceof HttpError ? err : new HttpError(502, `fetch failed: ${err.cause?.code || err.message}`);
      }
    }
  }

  if (resource === 'stats' && method === 'GET') return send(res, 200, stats);

  if (resource === 'model') {
    if (method === 'GET') return send(res, 200, modelSnapshot());
    if (method === 'POST') return send(res, 200, await reportModel(await readBody(req)));
    if (method === 'DELETE') {
      modelState.pushed = null;
      modelState.pushedAt = 0;
      await fsp.rm(MODEL_FILE, { force: true });
      broadcast('model', modelSnapshot());
      return send(res, 200, modelSnapshot());
    }
  }

  if (resource === 'alerts') {
    if (!id && method === 'GET') return send(res, 200, currentAlerts());
    if (!id && method === 'POST') return send(res, 201, await addAlert(await readBody(req)));
    if (!id && method === 'DELETE') { alerts = []; await persistAlerts(); return send(res, 200, { cleared: true }); }
    if (id && method === 'DELETE') {
      const before = alerts.length;
      alerts = alerts.filter((a) => a.id !== id);
      if (alerts.length === before) throw new HttpError(404, `no alert with id ${id}`);
      await persistAlerts();
      return send(res, 200, { deleted: id });
    }
  }

  throw new HttpError(404, `no route for ${method} ${url.pathname}`);
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else if (req.method === 'GET') await serveStatic(req, res, url.pathname);
      else send(res, 405, { error: 'method not allowed' });
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: err.message });
      else res.end();
    }
  });
}

async function start() {
  await loadDashboard();
  alerts = await readJson(ALERTS_FILE, []);
  const savedModel = await readJson(MODEL_FILE, null);
  if (savedModel?.pushed) Object.assign(modelState, { pushed: savedModel.pushed, pushedAt: savedModel.pushedAt || 0 });
  watchDashboardFile();

  await sampleStats();
  await refreshModel();
  const statsLoop = async () => {
    await sampleStats().catch((err) => console.error('[stats]', err));
    setTimeout(statsLoop, dashboard.refreshMs).unref();
  };
  setTimeout(statsLoop, dashboard.refreshMs).unref();
  setInterval(() => refreshModel().catch((err) => console.error('[model]', err)), CONFIG.probeIntervalMs).unref();
  setInterval(() => { for (const res of sseClients) res.write(': ping\n\n'); }, 25000).unref();

  const server = createServer();
  server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`OpenClaw Dashboard on http://${CONFIG.host}:${server.address().port}`);
    console.log(`  layout file: ${DASHBOARD_FILE}`);
    if (!CONFIG.token) console.log('  writes are unauthenticated (set DASHBOARD_TOKEN to require a token)');
  });
  return server;
}

if (require.main === module) {
  start().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { start, json5ToJson, validateDashboard, CONFIG };
