#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { spawnSync } = require('node:child_process');

const PLUGIN_VERSION = '0.1.0';
const DEFAULT_POLL_FOCUS_SECONDS = 5;
const DEFAULT_SNAPSHOT_INTERVAL_SECONDS = 30;

function nowISO() {
  return new Date().toISOString();
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function envPath(name, fallback) {
  const value = process.env[name];
  return value && value.trim() ? value : fallback;
}

function pluginStateDir() {
  return envPath('HERDR_PLUGIN_STATE_DIR', path.join(os.homedir(), '.local', 'state', 'herdr-telemetry-bridge'));
}

function pluginConfigDir() {
  return envPath('HERDR_PLUGIN_CONFIG_DIR', path.join(os.homedir(), '.config', 'herdr-telemetry-bridge'));
}

function expandPath(raw) {
  if (!raw) return raw;
  let expanded = raw;
  if (expanded === '~' || expanded.startsWith('~/')) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  const replacements = {
    HOME: os.homedir(),
    STATE_DIR: pluginStateDir(),
    CONFIG_DIR: pluginConfigDir(),
    HERDR_PLUGIN_STATE_DIR: pluginStateDir(),
    HERDR_PLUGIN_CONFIG_DIR: pluginConfigDir(),
  };
  expanded = expanded.replace(/\$\{?([A-Z0-9_]+)\}?/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(replacements, key)) return replacements[key];
    if (process.env[key]) return process.env[key];
    return match;
  });
  return expanded;
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJSON(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJSONAtomic(filePath, value) {
  mkdirp(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath);
}

function defaultConfig() {
  return {
    enabled: true,
    pollFocusSeconds: DEFAULT_POLL_FOCUS_SECONDS,
    snapshotIntervalSeconds: DEFAULT_SNAPSHOT_INTERVAL_SECONDS,
    redactTraceText: true,
    includeRawTranscripts: false,
    includeSessionPaths: true,
    includeRawHerdrEvents: false,
    estimateTraceTokens: true,
    includeThinkingInTokenEstimates: false,
    resolveGitRepoRoots: true,
    sinks: [
      { type: 'ndjson', path: '$STATE_DIR/events.ndjson' },
    ],
  };
}

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (Array.isArray(value)) out[key] = value;
    else if (value && typeof value === 'object' && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function loadConfig() {
  const configPath = envPath('HERDR_TELEMETRY_CONFIG', path.join(pluginConfigDir(), 'config.json'));
  const userConfig = readJSON(configPath, null);
  const config = deepMerge(defaultConfig(), userConfig || {});
  config.__path = configPath;
  config.pollFocusSeconds = Number(config.pollFocusSeconds || DEFAULT_POLL_FOCUS_SECONDS);
  config.snapshotIntervalSeconds = Number(config.snapshotIntervalSeconds || DEFAULT_SNAPSHOT_INTERVAL_SECONDS);
  if (!Array.isArray(config.sinks)) config.sinks = [];
  return config;
}

function herdrBin() {
  return envPath('HERDR_BIN_PATH', 'herdr');
}

function herdrJSON(args) {
  const result = spawnSync(herdrBin(), args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 12000,
    env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`herdr ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

function commandOutput(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout || 4000,
    cwd: options.cwd,
    env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
  });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || '').trim();
}

const repoRootCache = new Map();
function repoRootFor(cwd, config) {
  if (!cwd) return null;
  if (!config.resolveGitRepoRoots) return cwd;
  if (repoRootCache.has(cwd)) return repoRootCache.get(cwd);
  const root = commandOutput('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 2500 });
  const resolved = root || cwd;
  repoRootCache.set(cwd, resolved);
  return resolved;
}

function sanitizePane(pane, config) {
  if (!pane) return null;
  const cwd = pane.foreground_cwd || pane.cwd || null;
  const repoRoot = repoRootFor(cwd, config);
  const model = pane.agent_session && pane.agent_session.value
    ? latestModelFromSession(pane.agent_session.value)
    : null;
  return {
    workspace_id: pane.workspace_id || null,
    tab_id: pane.tab_id || null,
    pane_id: pane.pane_id || null,
    terminal_id: pane.terminal_id || null,
    focused: Boolean(pane.focused),
    cwd: pane.cwd || null,
    foreground_cwd: pane.foreground_cwd || null,
    repo_root: repoRoot,
    agent: pane.agent || null,
    agent_status: pane.agent_status || null,
    agent_session: pane.agent_session ? sanitizeAgentSession(pane.agent_session, config) : null,
    provider: model ? model.provider : null,
    model: model ? model.modelId : null,
  };
}

function sanitizeAgentSession(session, config) {
  if (!session) return null;
  const value = config.includeSessionPaths === false ? undefined : session.value;
  return {
    source: session.source || null,
    agent: session.agent || null,
    kind: session.kind || null,
    ...(value ? { value } : {}),
  };
}

function baseEvent(type, data = {}) {
  return {
    type,
    schema_version: 1,
    id: `${type}:${Date.now()}:${randomId()}`,
    emitted_at: nowISO(),
    source: {
      plugin_id: process.env.HERDR_PLUGIN_ID || 'local.herdr-telemetry-bridge',
      plugin_version: PLUGIN_VERSION,
      herdr_session: process.env.HERDR_SESSION || null,
    },
    ...data,
  };
}

async function emitEvents(events, config) {
  if (!config.enabled || events.length === 0) return;
  const normalized = events.map((event) => event.type ? event : baseEvent('herdr.unknown.v1', { event }));
  for (const sink of config.sinks) {
    if (!sink || sink.enabled === false) continue;
    try {
      if (sink.type === 'ndjson') writeNDJSONSink(sink, normalized);
      else if (sink.type === 'http') await writeHTTPSink(sink, normalized);
      else if (sink.type === 'command') writeCommandSink(sink, normalized);
      else warn(`unknown sink type: ${sink.type}`);
    } catch (error) {
      warn(`sink ${sink.type || 'unknown'} failed: ${error.message}`);
    }
  }
}

function writeNDJSONSink(sink, events) {
  const outPath = expandPath(sink.path || '$STATE_DIR/events.ndjson');
  mkdirp(path.dirname(outPath));
  const payload = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
  fs.appendFileSync(outPath, payload);
}

function writeCommandSink(sink, events) {
  if (!Array.isArray(sink.command) || sink.command.length === 0) {
    throw new Error('command sink requires command array');
  }
  const [cmd, ...args] = sink.command;
  const payload = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
  const result = spawnSync(cmd, args, {
    input: payload,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: Number(sink.timeoutMs || 10000),
    env: { ...process.env, ...(sink.env || {}) },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${cmd} exited ${result.status}: ${result.stderr || result.stdout}`);
  }
}

function writeHTTPSink(sink, events) {
  return new Promise((resolve, reject) => {
    if (!sink.url) return reject(new Error('http sink requires url'));
    const url = new URL(sink.url);
    const body = JSON.stringify({ events });
    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      ...(sink.headers || {}),
    };
    const token = sink.bearerToken || (sink.bearerTokenEnv ? process.env[sink.bearerTokenEnv] : null);
    if (token) headers.authorization = `Bearer ${token}`;
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request({
      method: sink.method || 'POST',
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      headers,
      timeout: Number(sink.timeoutMs || 10000),
    }, (res) => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`HTTP ${res.statusCode}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('HTTP timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

function warn(message) {
  process.stderr.write(`[herdr-telemetry] ${message}\n`);
}

function statePath() {
  return path.join(pluginStateDir(), 'state.json');
}

function loadState() {
  return readJSON(statePath(), { active_focus: null, last_snapshot_at: null });
}

function saveState(state) {
  writeJSONAtomic(statePath(), state);
}

function getFocusedPane(config) {
  const response = herdrJSON(['pane', 'list']);
  const panes = response.result && response.result.panes ? response.result.panes : response.panes || [];
  const focused = panes.find((pane) => pane.focused) || null;
  return focused ? sanitizePane(focused, config) : null;
}

function sameFocus(a, b) {
  if (!a || !b) return false;
  return a.pane_id === b.pane_id && a.workspace_id === b.workspace_id;
}

function durationSeconds(startedAt, endedAt) {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, (end - start) / 1000);
}

function focusIntervalEvent(active, endedAt, reason) {
  return baseEvent('herdr.focus_interval.v1', {
    started_at: active.started_at,
    ended_at: endedAt,
    duration_seconds: durationSeconds(active.started_at, endedAt),
    reason,
    workspace_id: active.workspace_id,
    tab_id: active.tab_id,
    pane_id: active.pane_id,
    terminal_id: active.terminal_id,
    cwd: active.cwd,
    foreground_cwd: active.foreground_cwd,
    repo_root: active.repo_root,
    agent: active.agent,
    agent_status: active.agent_status,
    provider: active.provider,
    model: active.model,
  });
}

async function updateFocus(config, reason = 'poll') {
  const state = loadState();
  const focused = getFocusedPane(config);
  const at = nowISO();
  const events = [];

  if (state.active_focus && (!focused || !sameFocus(state.active_focus, focused))) {
    events.push(focusIntervalEvent(state.active_focus, at, reason));
  }

  if (focused) {
    if (!state.active_focus || !sameFocus(state.active_focus, focused)) {
      state.active_focus = { ...focused, started_at: at };
    } else {
      state.active_focus = { ...state.active_focus, ...focused };
    }
  } else {
    state.active_focus = null;
  }
  saveState(state);
  await emitEvents(events, config);
  return events.length;
}

async function closeActiveFocus(config, reason = 'shutdown') {
  const state = loadState();
  if (!state.active_focus) return;
  const event = focusIntervalEvent(state.active_focus, nowISO(), reason);
  state.active_focus = null;
  saveState(state);
  await emitEvents([event], config);
}

function latestModelFromSession(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const readSize = Math.min(stat.size, 1024 * 1024);
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);
    const lines = buffer.toString('utf8').split('\n');
    let model = null;
    for (const line of lines) {
      if (!line.includes('model_change')) continue;
      try {
        const object = JSON.parse(line);
        if (object.type === 'model_change') model = { provider: object.provider || null, modelId: object.modelId || null };
      } catch (_) {}
    }
    return model;
  } catch (_) {
    return null;
  }
}

function scanSession(filePath, config) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const stats = {
    session_path: config.includeSessionPaths === false ? undefined : filePath,
    exists: true,
    first_timestamp: null,
    last_timestamp: null,
    provider: null,
    model: null,
    line_count: 0,
    message_count: 0,
    user_message_count: 0,
    assistant_message_count: 0,
    tool_call_count: 0,
    tool_result_count: 0,
    tool_names: [],
    explicit_tokens: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      raw_sums: {},
      raw_max: {},
      note: 'Best-effort parse of token counters present in the harness log. Some harnesses store cumulative/context counters, so clients should prefer provider-reported usage when available.',
    },
    estimated_tokens: config.estimateTraceTokens ? 0 : null,
    byte_size: fs.statSync(filePath).size,
  };
  const toolNames = new Set();
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  for (const line of lines) {
    stats.line_count += 1;
    let object;
    try { object = JSON.parse(line); } catch (_) { continue; }
    if (object.timestamp) {
      if (!stats.first_timestamp) stats.first_timestamp = object.timestamp;
      stats.last_timestamp = object.timestamp;
    }
    if (object.type === 'model_change') {
      stats.provider = object.provider || stats.provider;
      stats.model = object.modelId || stats.model;
    }
    collectExplicitTokens(object, stats.explicit_tokens);
    if (object.type === 'message' && object.message) {
      stats.message_count += 1;
      const role = object.message.role;
      if (role === 'user') stats.user_message_count += 1;
      if (role === 'assistant') stats.assistant_message_count += 1;
      if (role === 'toolResult') stats.tool_result_count += 1;
      const content = Array.isArray(object.message.content) ? object.message.content : [];
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'toolCall') {
          stats.tool_call_count += 1;
          if (part.name) toolNames.add(part.name);
        }
        if (config.estimateTraceTokens && shouldEstimatePart(part, config)) {
          stats.estimated_tokens += estimateTokensFromText(part.text || part.thinking || '');
        }
      }
    }
  }
  stats.tool_names = Array.from(toolNames).sort();
  normalizeExplicitTokenTotals(stats.explicit_tokens);
  return stats;
}

function normalizeExplicitTokenTotals(explicit) {
  const totalCounterMax = Object.entries(explicit.raw_max || {}).reduce((max, [key, value]) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    return normalized.includes('total') ? Math.max(max, Number(value) || 0) : max;
  }, 0);

  if (explicit.input_tokens === 0 && explicit.output_tokens === 0 && totalCounterMax > 0) {
    explicit.total_tokens_sum = explicit.total_tokens;
    explicit.total_tokens = totalCounterMax;
    explicit.aggregation = 'max_total_counter';
    return;
  }

  if (explicit.total_tokens === 0) {
    explicit.total_tokens = explicit.input_tokens + explicit.output_tokens;
  }
  explicit.aggregation = 'sum_usage_counters';
}

function shouldEstimatePart(part, config) {
  if (part.type === 'text' && typeof part.text === 'string') return true;
  if (part.type === 'thinking' && config.includeThinkingInTokenEstimates && typeof part.thinking === 'string') return true;
  return false;
}

function estimateTokensFromText(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function collectExplicitTokens(value, totals) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectExplicitTokens(item, totals);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (typeof child === 'number' && isTokenUsageKey(normalized)) {
      totals.raw_sums[key] = (totals.raw_sums[key] || 0) + child;
      totals.raw_max[key] = Math.max(totals.raw_max[key] || 0, child);
      if (normalized.includes('input') || normalized.includes('prompt')) totals.input_tokens += child;
      else if (normalized.includes('output') || normalized.includes('completion')) totals.output_tokens += child;
      else if (normalized.includes('total')) totals.total_tokens += child;
    } else if (child && typeof child === 'object') {
      collectExplicitTokens(child, totals);
    }
  }
}

function isTokenUsageKey(normalized) {
  if (!normalized.includes('token')) return false;
  // Exclude context-window and budgeting fields; they are not usage.
  if (
    normalized.includes('max') ||
    normalized.includes('budget') ||
    normalized.includes('remaining') ||
    normalized.includes('before') ||
    normalized.includes('after') ||
    normalized.includes('limit')
  ) return false;
  return [
    'inputtokens',
    'outputtokens',
    'totaltokens',
    'prompttokens',
    'completiontokens',
    'cachedinputtokens',
    'cachecreationinputtokens',
    'cachereadinputtokens',
    'reasoningtokens',
  ].some((known) => normalized === known || normalized.endsWith(known));
}

function collectAgents(config) {
  const response = herdrJSON(['agent', 'list']);
  const agents = response.result && response.result.agents ? response.result.agents : response.agents || [];
  const events = [];
  for (const agent of agents) {
    const pane = sanitizePane(agent, config);
    events.push(baseEvent('herdr.agent_snapshot.v1', {
      workspace_id: pane.workspace_id,
      tab_id: pane.tab_id,
      pane_id: pane.pane_id,
      terminal_id: pane.terminal_id,
      focused: pane.focused,
      cwd: pane.cwd,
      foreground_cwd: pane.foreground_cwd,
      repo_root: pane.repo_root,
      agent: pane.agent,
      agent_status: pane.agent_status,
      provider: pane.provider,
      model: pane.model,
      agent_session: pane.agent_session,
    }));

    const sessionPath = agent.agent_session && agent.agent_session.kind === 'path' ? agent.agent_session.value : null;
    const trace = sessionPath ? scanSession(sessionPath, config) : null;
    if (trace) {
      events.push(baseEvent('herdr.agent_trace_summary.v1', {
        workspace_id: pane.workspace_id,
        tab_id: pane.tab_id,
        pane_id: pane.pane_id,
        cwd: pane.cwd,
        foreground_cwd: pane.foreground_cwd,
        repo_root: pane.repo_root,
        agent: pane.agent,
        agent_status: pane.agent_status,
        provider: trace.provider || pane.provider,
        model: trace.model || pane.model,
        trace,
      }));
    }
  }
  events.push(baseEvent('herdr.snapshot.v1', {
    agent_count: agents.length,
    focused_agent_count: agents.filter((agent) => agent.focused).length,
  }));
  return events;
}

async function runEvent() {
  const config = loadConfig();
  const rawEvent = process.env.HERDR_PLUGIN_EVENT_JSON ? readJSONFromString(process.env.HERDR_PLUGIN_EVENT_JSON) : null;
  const hostEventName = process.env.HERDR_PLUGIN_EVENT || (rawEvent && rawEvent.type) || null;
  const events = [baseEvent('herdr.host_event.v1', {
    host_event_name: hostEventName,
    ...(config.includeRawHerdrEvents ? { host_event: rawEvent } : {}),
  })];
  await emitEvents(events, config);
  await updateFocus(config, hostEventName || 'event');
}

function readJSONFromString(value) {
  try { return JSON.parse(value); } catch (_) { return null; }
}

async function runSnapshot() {
  const config = loadConfig();
  await updateFocus(config, 'snapshot');
  const events = collectAgents(config);
  await emitEvents(events, config);
  process.stdout.write(JSON.stringify({ ok: true, events: events.length, config: config.__path }, null, 2) + '\n');
}

async function runDaemon() {
  const config = loadConfig();
  mkdirp(pluginStateDir());
  process.stdout.write(`[herdr-telemetry] daemon started\n`);
  process.stdout.write(`[herdr-telemetry] config: ${config.__path}\n`);
  process.stdout.write(`[herdr-telemetry] sinks: ${config.sinks.map((s) => s.type).join(', ') || 'none'}\n`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(focusTimer);
    clearInterval(snapshotTimer);
    await closeActiveFocus(config, 'daemon_shutdown');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await updateFocus(config, 'daemon_start');
  await emitEvents(collectAgents(config), config);

  const focusTimer = setInterval(() => {
    updateFocus(config, 'poll').catch((error) => warn(error.message));
  }, Math.max(1, config.pollFocusSeconds) * 1000);

  const snapshotTimer = setInterval(() => {
    Promise.resolve()
      .then(() => emitEvents(collectAgents(config), config))
      .catch((error) => warn(error.message));
  }, Math.max(5, config.snapshotIntervalSeconds) * 1000);
}

function aggregateEvents(filePath) {
  const rows = [];
  try {
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean).slice(-5000);
    for (const line of lines) {
      try { rows.push(JSON.parse(line)); } catch (_) {}
    }
  } catch (_) {}
  const byRepo = new Map();
  let snapshots = 0;
  let traces = 0;
  for (const row of rows) {
    if (row.type === 'herdr.focus_interval.v1' && row.repo_root) {
      const rec = byRepo.get(row.repo_root) || { seconds: 0, intervals: 0 };
      rec.seconds += Number(row.duration_seconds || 0);
      rec.intervals += 1;
      byRepo.set(row.repo_root, rec);
    }
    if (row.type === 'herdr.agent_snapshot.v1') snapshots += 1;
    if (row.type === 'herdr.agent_trace_summary.v1') traces += 1;
  }
  return { rows: rows.length, snapshots, traces, byRepo };
}

function renderDashboard(config) {
  const ndjsonSink = config.sinks.find((sink) => sink.type === 'ndjson');
  const filePath = expandPath((ndjsonSink && ndjsonSink.path) || '$STATE_DIR/events.ndjson');
  const agg = aggregateEvents(filePath);
  console.clear();
  console.log('Herdr Telemetry Bridge');
  console.log('======================');
  console.log(`events: ${agg.rows}`);
  console.log(`agent snapshots: ${agg.snapshots}`);
  console.log(`trace summaries: ${agg.traces}`);
  console.log(`file: ${filePath}`);
  console.log('');
  console.log('Repo focus time:');
  const repos = Array.from(agg.byRepo.entries()).sort((a, b) => b[1].seconds - a[1].seconds).slice(0, 20);
  if (repos.length === 0) console.log('  No completed focus intervals yet.');
  for (const [repo, rec] of repos) {
    console.log(`  ${formatDuration(rec.seconds).padStart(9)}  ${repo} (${rec.intervals} intervals)`);
  }
}

async function runDashboard(args) {
  const config = loadConfig();
  const watch = args.includes('--watch');
  renderDashboard(config);
  if (watch) {
    setInterval(() => renderDashboard(config), 5000);
  }
}

function formatDuration(seconds) {
  seconds = Math.round(seconds || 0);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function configTemplate(timeMd = false) {
  const config = defaultConfig();
  if (timeMd) {
    config.sinks = [{
      type: 'ndjson',
      path: '~/Library/Application Support/time.md/herdr-telemetry/events.ndjson',
    }];
  }
  return config;
}

function runInitConfig(args) {
  const timeMd = args.includes('--time-md');
  const outPath = path.join(pluginConfigDir(), 'config.json');
  if (fs.existsSync(outPath) && !args.includes('--force')) {
    process.stdout.write(`Config already exists: ${outPath}\nUse --force to overwrite.\n`);
    return;
  }
  writeJSONAtomic(outPath, configTemplate(timeMd));
  process.stdout.write(`Wrote ${timeMd ? 'time.md ' : ''}config: ${outPath}\n`);
}

function runStatus() {
  const config = loadConfig();
  const state = loadState();
  const sinks = config.sinks.map((sink) => ({ ...sink, path: sink.path ? expandPath(sink.path) : undefined }));
  process.stdout.write(JSON.stringify({
    ok: true,
    plugin_version: PLUGIN_VERSION,
    config_path: config.__path,
    state_path: statePath(),
    state,
    sinks,
  }, null, 2) + '\n');
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  switch (command) {
    case 'event': return runEvent();
    case 'snapshot': return runSnapshot();
    case 'daemon': return runDaemon();
    case 'dashboard': return runDashboard(args);
    case 'init-config': return runInitConfig(args);
    case 'status': return runStatus();
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(`Usage: herdr-telemetry <command>\n\nCommands:\n  event          Handle a Herdr plugin event hook\n  snapshot       Emit current agent + trace summaries\n  daemon         Poll focus and periodically emit snapshots\n  dashboard      Show a small terminal dashboard\n  init-config    Write config.json into HERDR_PLUGIN_CONFIG_DIR\n  status         Print config/state paths and current state\n\n`);
      return;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

main().catch((error) => {
  warn(error.stack || error.message);
  process.exitCode = 1;
});
