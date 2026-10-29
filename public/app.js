'use strict';

const state = { dashboard: null, stats: null, model: null, alerts: [], types: {}, jsonData: {}, lastUpdate: 0 };
const grid = document.getElementById('grid');

// ---------------------------------------------------------------- helpers

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function bytes(n, digits = 1) {
  if (n == null || !Number.isFinite(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (Math.abs(n) >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : digits)} ${u[i]}`;
}
const pct = (n) => (n == null || !Number.isFinite(n) ? '–' : `${n.toFixed(0)}%`);
const fmtNum = (n) => (n == null || n === '' ? '–' : typeof n === 'number' ? n.toLocaleString() : esc(n));

function duration(sec) {
  if (sec == null) return '–';
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${sec}s`;
}

function ago(ts) {
  if (!ts) return 'never';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 5) return 'just now';
  if (s < 60) return `${Math.floor(s)}s ago`;
  return `${duration(s)} ago`;
}

function bar(percent, warnAt = 75, errAt = 90) {
  const p = Math.max(0, Math.min(100, percent || 0));
  const cls = p >= errAt ? 'err' : p >= warnAt ? 'warn' : '';
  return `<div class="bar ${cls}" role="meter" aria-valuenow="${p.toFixed(0)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${p}%"></span></div>`;
}

function sparkline(values) {
  if (!values || values.length < 2) return '';
  const w = 100, h = 40;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - (Math.max(0, Math.min(100, v)) / 100) * (h - 2) - 1]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path class="area" d="${line}L${w},${h}L0,${h}Z"/><path class="line" d="${line}"/></svg>`;
}

function rows(obj) {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  if (!entries.length) return '<div class="empty">Nothing to show.</div>';
  return `<dl class="rows">${entries.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${typeof v === 'object' && v !== null ? esc(JSON.stringify(v)) : esc(v)}</dd>`).join('')}</dl>`;
}

function miniMarkdown(text) {
  return esc(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
}

// ------------------------------------------------------------- renderers

const STATUS_CLASS = { idle: 'ok', ready: 'ok', online: 'ok', thinking: 'info', running: 'info', streaming: 'info', busy: 'warn', error: 'err', offline: 'err' };

const renderers = {
  model() {
    const m = state.model;
    if (!m) return '<div class="empty">Waiting for data…</div>';
    const r = m.reported || {};
    const a = m.active;
    const status = m.stale ? 'stale' : r.status || (m.gateway?.online ? 'online' : 'unknown');
    const gw = m.gateway;
    const tiles = [];
    const tile = (label, value) => tiles.push(`<div class="tile"><div class="label">${esc(label)}</div><div class="value">${value}</div></div>`);
    if (r.contextTokens != null) {
      const p = r.contextWindow ? (r.contextTokens / r.contextWindow) * 100 : null;
      tile('Context', `${fmtNum(r.contextTokens)}${r.contextWindow ? ` <small class="muted">/ ${fmtNum(r.contextWindow)}</small>` : ''}${p != null ? bar(p, 70, 90) : ''}`);
    }
    if (r.inputTokens != null) tile('Input tokens', fmtNum(r.inputTokens));
    if (r.outputTokens != null) tile('Output tokens', fmtNum(r.outputTokens));
    if (r.totalTokens != null) tile('Total tokens', fmtNum(r.totalTokens));
    if (r.tokensPerSec != null) tile('Tokens / s', fmtNum(r.tokensPerSec));
    if (r.latencyMs != null) tile('Latency', `${fmtNum(r.latencyMs)} ms`);
    if (r.costUsd != null) tile('Cost', `$${Number(r.costUsd).toFixed(4)}`);
    if (r.session) tile('Session', esc(r.session));
    if (r.channel) tile('Channel', esc(r.channel));
    tile('Gateway', gw ? `<span class="pill ${gw.online ? 'ok' : 'err'}">${gw.online ? `online · ${gw.latencyMs} ms` : 'offline'}</span>` : '–');

    const known = new Set(['model', 'provider', 'status', 'contextTokens', 'contextWindow', 'inputTokens', 'outputTokens', 'totalTokens', 'tokensPerSec', 'latencyMs', 'costUsd', 'session', 'channel', 'task']);
    const extra = Object.fromEntries(Object.entries(r).filter(([k]) => !known.has(k)));
    const fallbacks = m.config?.fallbacks?.length ? `<div class="muted small">Fallbacks: ${m.config.fallbacks.map(esc).join(', ')}</div>` : '';
    const sourceLabel = { openclaw: `reported by OpenClaw ${ago(m.reportedAt)}`, config: 'from openclaw.json', ollama: 'loaded in Ollama' }[a?.source] || '';

    return `
      <div class="model-head">
        <div class="model-name">${a ? esc(a.model) : 'No active model'}</div>
        <span class="pill ${STATUS_CLASS[String(status).toLowerCase()] || (status === 'stale' ? 'warn' : '')}">${esc(status)}</span>
      </div>
      <div class="muted small">${a?.provider ? `${esc(a.provider)} · ` : ''}${esc(sourceLabel)}${m.stale ? ' (last report is stale)' : ''}</div>
      ${r.task ? `<div class="small" style="margin-top:6px">Current task: ${esc(r.task)}</div>` : ''}
      ${fallbacks}
      <div class="model-grid">${tiles.join('')}</div>
      ${Object.keys(extra).length ? `<div style="margin-top:12px">${rows(extra)}</div>` : ''}
      ${!a ? '<p class="muted small">Point OpenClaw at <code class="mono">POST /api/model</code> or set <code class="mono">OPENCLAW_CONFIG</code>.</p>' : ''}`;
  },

  alerts(w) {
    const o = w.options || {};
    let list = state.alerts || [];
    if (Array.isArray(o.levels)) list = list.filter((a) => o.levels.includes(a.level));
    list = list.slice(0, Number(o.limit) || 10);
    if (!list.length) return '<div class="empty">All clear — nothing important right now.</div>';
    return `<ul class="alerts">${list.map((a) => `
      <li class="alert lvl-${esc(a.level)}">
        <span class="stripe"></span>
        <div><strong>${esc(a.title)}</strong>${a.message ? `<p>${esc(a.message)}</p>` : ''}<span class="muted small">${esc(a.source)}</span></div>
        <div style="text-align:right"><time>${ago(a.ts)}</time>${a.system ? '' : `<br><button class="icon-btn small" data-dismiss="${esc(a.id)}" title="Dismiss">✕</button>`}</div>
      </li>`).join('')}</ul>`;
  },

  cpu() {
    const c = state.stats?.cpu;
    if (!c) return '<div class="empty">Waiting…</div>';
    return `<div class="big num">${c.usage.toFixed(0)}<small>%</small></div>
      ${bar(c.usage)}
      <div class="muted small">${c.cores} cores · load ${c.load.map((l) => l.toFixed(2)).join(' / ')}</div>
      ${sparkline(state.stats.history.cpu)}`;
  },

  memory() {
    const m = state.stats?.memory;
    if (!m) return '<div class="empty">Waiting…</div>';
    return `<div class="big num">${m.percent.toFixed(0)}<small>%</small></div>
      ${bar(m.percent)}
      <div class="muted small">${bytes(m.used)} of ${bytes(m.total)}${m.swapTotal ? ` · swap ${bytes(m.swapUsed)} / ${bytes(m.swapTotal)}` : ''}</div>
      ${sparkline(state.stats.history.memory)}`;
  },

  disk(w) {
    const want = w.options?.path;
    const disks = state.stats?.disks || [];
    const d = disks.find((x) => x.path === want) || (!want && disks[0]);
    if (!d) return '<div class="empty">Measuring…</div>';
    if (d.error) return `<div class="error small">${esc(d.path)}: ${esc(d.error)}</div>`;
    return `<div class="big num">${d.percent.toFixed(0)}<small>%</small></div>
      ${bar(d.percent)}
      <div class="muted small">${bytes(d.free)} free of ${bytes(d.total)} · <span class="mono">${esc(d.path)}</span></div>`;
  },

  gpu() {
    const gpus = state.stats?.gpus || [];
    if (!gpus.length) return '<div class="empty">No NVIDIA GPU detected (nvidia-smi not available).</div>';
    return gpus.map((g) => {
      const memPct = g.memoryTotal ? (g.memoryUsed / g.memoryTotal) * 100 : 0;
      return `<div style="margin-bottom:10px">
        <div class="small"><strong>${esc(g.name)}</strong></div>
        <div class="big num">${pct(g.utilization)}</div>
        ${bar(g.utilization)}
        <div class="muted small">VRAM ${bytes(g.memoryUsed)} / ${bytes(g.memoryTotal)} (${pct(memPct)})${g.temperature != null ? ` · ${g.temperature}°C` : ''}${g.powerW != null ? ` · ${g.powerW.toFixed(0)} W` : ''}</div>
      </div>`;
    }).join('');
  },

  network() {
    const n = state.stats?.network;
    if (!n) return '<div class="empty">Waiting…</div>';
    return `${n.rxRate != null ? `<div class="big num" style="font-size:20px">↓ ${bytes(n.rxRate)}/s</div><div class="big num" style="font-size:20px">↑ ${bytes(n.txRate)}/s</div>` : ''}
      <div class="muted small" style="margin-top:6px">${n.addresses.map((a) => `${esc(a.iface)} <span class="mono">${esc(a.address)}</span>`).join('<br>') || 'No external interfaces'}</div>`;
  },

  system() {
    const s = state.stats?.system;
    if (!s) return '<div class="empty">Waiting…</div>';
    return rows({
      Host: s.hostname,
      OS: `${s.platform} (${s.arch})`,
      Uptime: duration(s.uptime),
      CPU: state.stats.cpu?.model,
      Temperature: s.temperature != null ? `${s.temperature.toFixed(0)}°C` : undefined,
      Node: s.node,
      'Dashboard up': duration(s.dashboardUptime),
    });
  },

  'local-models'() {
    const o = state.model?.ollama;
    if (!o) return '<div class="empty">Checking…</div>';
    if (!o.online) return `<div class="empty">Ollama not reachable at <span class="mono">${esc(o.url)}</span>.</div>`;
    if (!o.models.length) return '<div class="empty">Ollama is running, no models loaded.</div>';
    return `<table class="list"><thead><tr><th>Model</th><th>Size</th><th>VRAM</th><th>Unloads</th></tr></thead><tbody>
      ${o.models.map((m) => `<tr><td><strong>${esc(m.name)}</strong><br><span class="muted small">${[m.params, m.quant].filter(Boolean).map(esc).join(' · ')}</span></td><td>${bytes(m.size)}</td><td>${bytes(m.sizeVram)}</td><td>${m.expiresAt ? esc(new Date(m.expiresAt).toLocaleTimeString()) : '–'}</td></tr>`).join('')}
    </tbody></table>`;
  },

  text(w) {
    return `<div class="text-body">${miniMarkdown(w.options?.text || '')}</div>`;
  },

  kv(w) {
    return rows(w.options?.items || {});
  },

  json(w) {
    const d = state.jsonData[w.id];
    if (!d) return '<div class="empty">Loading…</div>';
    if (d.error) return `<div class="error small">${esc(d.error)}</div>`;
    const v = d.value;
    const shown = v !== null && typeof v === 'object' ? `<pre class="mono" style="margin:0;white-space:pre-wrap">${esc(JSON.stringify(v, null, 2))}</pre>` : `<div class="big num">${fmtNum(v)}${w.options?.unit ? `<small>${esc(w.options.unit)}</small>` : ''}</div>`;
    return `${shown}<div class="muted small">updated ${ago(d.fetchedAt)}</div>`;
  },

  iframe(w) {
    const h = Number(w.options?.height) || 300;
    return `<iframe class="embed" style="height:${h}px" src="${esc(w.options?.url)}" sandbox="allow-scripts allow-forms allow-popups" referrerpolicy="no-referrer" loading="lazy"></iframe>`;
  },
};

// These only change when the layout changes; re-rendering them each tick would reset them.
const STATIC_TYPES = new Set(['iframe', 'text', 'kv']);

// --------------------------------------------------------------- layout

function renderLayout() {
  const d = state.dashboard;
  if (!d) return;
  document.title = d.title;
  document.getElementById('title').textContent = d.title;
  grid.innerHTML = d.widgets.map((w, i) => `
    <article class="w ${esc(w.size || 'sm')}" data-id="${esc(w.id)}" data-type="${esc(w.type)}">
      <div class="w-head">
        <h2 class="w-title">${esc(w.title || w.type)}</h2>
        <div class="w-tools">
          <button class="icon-btn" data-move="-1" ${i === 0 ? 'disabled' : ''} title="Move earlier" aria-label="Move earlier">←</button>
          <button class="icon-btn" data-move="1" ${i === d.widgets.length - 1 ? 'disabled' : ''} title="Move later" aria-label="Move later">→</button>
          <button class="icon-btn" data-remove title="Remove widget" aria-label="Remove widget">✕</button>
        </div>
      </div>
      <div class="w-body"></div>
    </article>`).join('') || '<div class="empty">No widgets. Click Edit to add one, or ask OpenClaw to.</div>';
  renderBodies(true);
  scheduleJsonFetches();
}

function renderBodies(includeStatic = false) {
  for (const w of state.dashboard?.widgets || []) {
    if (!includeStatic && STATIC_TYPES.has(w.type)) continue;
    const body = grid.querySelector(`.w[data-id="${CSS.escape(w.id)}"] .w-body`);
    if (!body) continue;
    const fn = renderers[w.type];
    body.innerHTML = fn ? fn(w) : `<div class="error small">Unknown widget type ${esc(w.type)}</div>`;
  }
}

// ----------------------------------------------------------- json widgets

const jsonTimers = new Map();
function scheduleJsonFetches() {
  for (const t of jsonTimers.values()) clearInterval(t);
  jsonTimers.clear();
  for (const w of state.dashboard.widgets.filter((x) => x.type === 'json')) {
    const load = async () => {
      try {
        const res = await fetch(`api/widgets/${encodeURIComponent(w.id)}/data`);
        const body = await res.json();
        state.jsonData[w.id] = res.ok ? body : { error: body.error || res.statusText };
      } catch (err) {
        state.jsonData[w.id] = { error: err.message };
      }
      renderBodies();
    };
    load();
    jsonTimers.set(w.id, setInterval(load, Math.max(2000, Number(w.options?.intervalMs) || 10000)));
  }
}

// ----------------------------------------------------------------- API

async function api(method, url, body) {
  const headers = { 'content-type': 'application/json' };
  const token = (() => { try { return localStorage.getItem('dashboardToken'); } catch { return null; } })();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) {
    const t = prompt('This dashboard requires a token for edits (DASHBOARD_TOKEN):');
    if (t) {
      try { localStorage.setItem('dashboardToken', t); } catch { /* ignore */ }
      return api(method, url, body);
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// --------------------------------------------------------------- events

function connect() {
  const dot = document.getElementById('conn-dot');
  const es = new EventSource('api/events');
  es.onopen = () => { dot.classList.add('live'); dot.title = 'Live'; };
  es.onerror = () => { dot.classList.remove('live'); dot.title = 'Reconnecting…'; };
  es.addEventListener('dashboard', (e) => { state.dashboard = JSON.parse(e.data); renderLayout(); });
  es.addEventListener('stats', (e) => { state.stats = JSON.parse(e.data); state.lastUpdate = Date.now(); renderBodies(); });
  es.addEventListener('model', (e) => { state.model = JSON.parse(e.data); renderBodies(); });
  es.addEventListener('alerts', (e) => { state.alerts = JSON.parse(e.data); renderBodies(); });
}

setInterval(() => {
  document.getElementById('updated').textContent = state.lastUpdate ? `Updated ${ago(state.lastUpdate)}` : '';
}, 1000);

// --------------------------------------------------------------- editing

const editToggle = document.getElementById('edit-toggle');
const editor = document.getElementById('editor');
const addType = document.getElementById('add-type');
const addHelp = document.getElementById('add-help');
const addError = document.getElementById('add-error');

editToggle.addEventListener('click', () => {
  const on = editToggle.getAttribute('aria-pressed') !== 'true';
  editToggle.setAttribute('aria-pressed', String(on));
  editToggle.textContent = on ? 'Done' : 'Edit';
  editor.hidden = !on;
  document.body.classList.toggle('editing', on);
});

function showTypeHelp() {
  const t = state.types[addType.value];
  if (!t) return;
  const opts = Object.entries(t.options).map(([k, v]) => `${k}: ${v}`).join('; ');
  addHelp.textContent = `${t.description}${opts ? ` Options: ${opts}` : ''}`;
}
addType.addEventListener('change', showTypeHelp);

document.getElementById('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  addError.textContent = '';
  const f = new FormData(e.target);
  let options = {};
  const raw = String(f.get('options') || '').trim();
  if (raw) {
    try { options = JSON.parse(raw); } catch { addError.textContent = 'Options must be valid JSON, e.g. {"path":"/home"}'; return; }
  }
  const widget = { type: f.get('type'), size: f.get('size'), options };
  if (f.get('title')) widget.title = String(f.get('title'));
  try {
    await api('POST', 'api/widgets', widget);
    e.target.reset();
    showTypeHelp();
  } catch (err) { addError.textContent = err.message; }
});

grid.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = btn.closest('.w')?.dataset.id;
  try {
    if (btn.dataset.dismiss) await api('DELETE', `api/alerts/${encodeURIComponent(btn.dataset.dismiss)}`);
    else if (btn.hasAttribute('data-remove') && id) await api('DELETE', `api/widgets/${encodeURIComponent(id)}`);
    else if (btn.dataset.move && id) await api('POST', `api/widgets/${encodeURIComponent(id)}/move`, { by: Number(btn.dataset.move) });
  } catch (err) { alert(err.message); }
});

(async function init() {
  try {
    const { types } = await (await fetch('api/widget-types')).json();
    state.types = types;
    addType.innerHTML = Object.keys(types).map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    showTypeHelp();
  } catch { /* the editor just won't have a type list */ }
  connect();
})();
