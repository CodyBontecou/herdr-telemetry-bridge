# Herdr Telemetry Bridge

**Herdr Telemetry Bridge** is a local-first [Herdr](https://herdr.dev) plugin that streams terminal workspace, repository, coding-agent, model, and trace-summary telemetry to apps outside your terminal.

It is designed for tools like [`time.md`](https://github.com/codybontecou/time.md), menu bar apps, Raycast extensions, local dashboards, or any client that can read NDJSON, receive HTTP POSTs, or accept events on stdin.

> Privacy-first by default: the plugin summarizes agent traces and does **not** export raw transcript text unless you deliberately build a sink/config that does so.

## What it does

The bridge listens to Herdr lifecycle events and/or runs as a lightweight daemon pane. It emits a stable event stream describing:

- focused Herdr panes and completed focus intervals
- workspace/tab/pane ids
- foreground working directory and resolved Git repo root
- detected coding agent and agent status
- model/provider metadata when available from the agent session log
- local agent trace summaries, including message/tool counts and best-effort token counters
- optional raw Herdr host event payloads for custom integrations

Typical use cases:

- Show “coding time by repo” inside a macOS app.
- Correlate screen time with Herdr workspaces.
- Track model usage across Pi/Claude/Codex-style coding harnesses.
- Feed a local dashboard with agent state and repo activity.
- Send Herdr activity to a client process without giving that client access to the Herdr socket.

## Event types

The plugin emits newline-delimited JSON events. Current event families:

| Event | Purpose |
|---|---|
| `herdr.host_event.v1` | Herdr event-hook notification, e.g. `pane.focused` or `workspace.focused`. |
| `herdr.focus_interval.v1` | A completed focused-pane interval with repo, cwd, agent, status, provider, and model fields. |
| `herdr.agent_snapshot.v1` | Current detected Herdr agents and their pane/session metadata. |
| `herdr.agent_trace_summary.v1` | Summary of a local agent transcript/log when Herdr exposes a session path. |
| `herdr.snapshot.v1` | Summary marker for a snapshot batch. |

Example focus interval:

```json
{
  "type": "herdr.focus_interval.v1",
  "schema_version": 1,
  "started_at": "2026-06-26T00:00:00.000Z",
  "ended_at": "2026-06-26T00:05:00.000Z",
  "duration_seconds": 300,
  "workspace_id": "wJ",
  "tab_id": "wJ:t2",
  "pane_id": "wJ:p2",
  "cwd": "/Users/me/projects/time.md",
  "foreground_cwd": "/Users/me/projects/time.md",
  "repo_root": "/Users/me/projects/time.md",
  "agent": "pi",
  "agent_status": "working",
  "provider": "openai-codex",
  "model": "gpt-5.5"
}
```

Example trace summary:

```json
{
  "type": "herdr.agent_trace_summary.v1",
  "schema_version": 1,
  "repo_root": "/Users/me/projects/time.md",
  "agent": "pi",
  "provider": "openai-codex",
  "model": "gpt-5.5",
  "trace": {
    "message_count": 42,
    "user_message_count": 2,
    "assistant_message_count": 20,
    "tool_call_count": 20,
    "tool_result_count": 20,
    "tool_names": ["bash", "read", "edit"],
    "estimated_tokens": 34086,
    "explicit_tokens": {
      "total_tokens": 61852,
      "aggregation": "max_total_counter"
    }
  }
}
```

Token fields are best-effort. Some harnesses store cumulative context-window counters instead of provider billing usage. Clients should treat these as approximate unless their own harness/provider source confirms exact usage.

## Install

### From Herdr marketplace / GitHub

Once published, install with:

```bash
herdr plugin install codybontecou/herdr-telemetry-bridge --yes
```

The plugin is discoverable by Herdr’s marketplace when the GitHub repository has the `herdr-plugin` topic.

### Local development

```bash
herdr plugin link /path/to/herdr-telemetry-bridge
```

For this checkout:

```bash
herdr plugin link /Users/codybontecou/dev/herdr-telemetry-bridge
```

## Quick start

Write a default config:

```bash
herdr plugin action invoke local.herdr-telemetry-bridge.init-config
```

Emit one snapshot:

```bash
herdr plugin action invoke local.herdr-telemetry-bridge.snapshot
```

Start continuous collection in a Herdr-managed pane:

```bash
herdr plugin pane open \
  --plugin local.herdr-telemetry-bridge \
  --entrypoint daemon \
  --placement split
```

Open the simple terminal dashboard:

```bash
herdr plugin pane open \
  --plugin local.herdr-telemetry-bridge \
  --entrypoint dashboard \
  --placement overlay
```

Inspect plugin logs:

```bash
herdr plugin log list --plugin local.herdr-telemetry-bridge --limit 20
```

## Configuration

The plugin reads JSON config from:

```text
$HERDR_PLUGIN_CONFIG_DIR/config.json
```

Find that directory with:

```bash
herdr plugin config-dir local.herdr-telemetry-bridge
```

Default config:

```json
{
  "enabled": true,
  "pollFocusSeconds": 5,
  "snapshotIntervalSeconds": 30,
  "redactTraceText": true,
  "includeRawTranscripts": false,
  "includeSessionPaths": true,
  "includeRawHerdrEvents": false,
  "estimateTraceTokens": true,
  "includeThinkingInTokenEstimates": false,
  "resolveGitRepoRoots": true,
  "sinks": [
    {
      "type": "ndjson",
      "path": "$STATE_DIR/events.ndjson"
    }
  ]
}
```

### Important options

| Option | Default | Description |
|---|---:|---|
| `pollFocusSeconds` | `5` | How often the daemon checks the focused pane. |
| `snapshotIntervalSeconds` | `30` | How often the daemon emits agent snapshots and trace summaries. |
| `includeSessionPaths` | `true` | Include local session-log paths in events. Turn off if paths are sensitive. |
| `includeRawHerdrEvents` | `false` | Include raw Herdr hook payloads in `herdr.host_event.v1`. |
| `estimateTraceTokens` | `true` | Estimate tokens from message text when exact counters are unavailable. |
| `includeThinkingInTokenEstimates` | `false` | Include thinking/reasoning text in estimates when present in local logs. |
| `resolveGitRepoRoots` | `true` | Run `git rev-parse --show-toplevel` for cwd/repo grouping. |

## Sinks

A sink is a destination for emitted events. You can configure more than one sink.

### NDJSON file

Appends one event per line:

```json
{
  "type": "ndjson",
  "path": "$STATE_DIR/events.ndjson"
}
```

Paths support `~`, `$HOME`, `$STATE_DIR`, `$CONFIG_DIR`, `$HERDR_PLUGIN_STATE_DIR`, and `$HERDR_PLUGIN_CONFIG_DIR`.

### HTTP webhook

Posts batches as:

```json
{ "events": [/* event objects */] }
```

Config:

```json
{
  "type": "http",
  "url": "http://127.0.0.1:48743/herdr/events",
  "bearerTokenEnv": "HERDR_TELEMETRY_TOKEN",
  "timeoutMs": 10000
}
```

### Command sink

Runs a command and writes NDJSON to stdin:

```json
{
  "type": "command",
  "command": ["timemd", "ingest", "herdr", "--stdin"],
  "timeoutMs": 10000
}
```

This is the intended future native ingestion path for `time.md`, but any program can implement the same stdin contract.

## time.md integration

For `time.md`, initialize the time.md-oriented config:

```bash
herdr plugin action invoke local.herdr-telemetry-bridge.init-time-md-config
```

That writes events to:

```text
~/Library/Application Support/time.md/herdr-telemetry/events.ndjson
```

Recommended `time.md` app behavior:

1. User opts into **Settings → Integrations → Herdr**.
2. The app checks for `herdr` and this plugin.
3. The app links/installs the plugin if needed.
4. The app invokes `init-time-md-config`.
5. The app opens the daemon pane or instructs the user to start it.
6. The app imports `events.ndjson` into a local SQLite store.

A later `timemd ingest herdr --stdin` command can switch the plugin to a command sink so Herdr telemetry is imported even when the GUI is closed.

## Daemon vs event hooks

Herdr event hooks catch discrete Herdr lifecycle events. The daemon gives a fuller stream by:

- polling focused pane state for focus intervals
- periodically emitting agent snapshots
- periodically scanning agent session logs for trace summaries

For best results, keep the daemon pane running in Herdr.

## Dashboard

The bundled terminal dashboard reads the first NDJSON sink and aggregates completed repo focus intervals:

```bash
herdr plugin pane open --plugin local.herdr-telemetry-bridge --entrypoint dashboard --placement overlay
```

## Privacy and security

A Herdr plugin is ordinary local code running as your user. This plugin reads Herdr agent/pane metadata and, when available, local agent session logs exposed by Herdr integrations.

Potentially sensitive fields include:

- local filesystem paths
- repo names
- agent/session ids
- tool names
- model/provider names
- approximate token counters
- raw Herdr event payloads if enabled

Defaults avoid raw transcript export, but local session logs may still contain sensitive data. Review `config.json` before enabling HTTP or command sinks.

## Development

No build step is required. The plugin is a Node.js script and uses only built-in Node modules.

Requirements:

- Herdr `>= 0.7.0`
- Node.js `>= 18`
- Git, if `resolveGitRepoRoots` is enabled

Run directly:

```bash
node bin/herdr-telemetry.js help
node bin/herdr-telemetry.js snapshot
node bin/herdr-telemetry.js dashboard
```

Validate syntax:

```bash
node --check bin/herdr-telemetry.js
```

## License

MIT
