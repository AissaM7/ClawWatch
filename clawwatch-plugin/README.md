# ClawWatch

Local-first observability, risk scoring, and hallucination detection for OpenClaw agents.

ClawWatch captures every lifecycle event emitted by an OpenClaw agent run -- tool calls, LLM completions, file operations, network requests, subprocess executions, and environment variable accesses -- and writes them to a per-run SQLite database on disk. A background HTTP server exposes this data over a versioned REST API and a Server-Sent Events stream. A bundled React dashboard renders a virtualized timeline, a deterministic risk engine, a hallucination detector, a goal-alignment scorer, and a cost estimator.

No external dependencies. No cloud services. No configuration required to get started.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Architecture](#architecture)
3. [Plugin Internals](#plugin-internals)
4. [Data Model](#data-model)
5. [HTTP API and SSE](#http-api-and-sse)
6. [Frontend Scoring Engines](#frontend-scoring-engines)
7. [Configuration](#configuration)
8. [CLI Reference](#cli-reference)
9. [Troubleshooting](#troubleshooting)
10. [Contributing](#contributing)
11. [Project Structure](#project-structure)

---

## Quick Start

```bash
pip install clawwatch
clawwatch ui
```

Open `http://localhost:8765` in your browser. Run any OpenClaw agent -- ClawWatch activates automatically via entry-point discovery.

### Install from source

```bash
pip install -e ./clawwatch-plugin
clawwatch ui
```

The React dashboard is pre-compiled and bundled inside the Python package. Node.js is not required.

### Manual plugin registration

If your OpenClaw installation does not use entry-point discovery, register the plugin explicitly:

```python
from clawwatch.plugin import ClawWatchPlugin

plugin = ClawWatchPlugin()

agent = OpenClawAgent(
    goal="Analyze the Q4 financial report and produce a summary",
    plugins=[plugin],
)
agent.run()
```

The plugin starts its HTTP server on `agent_start` and stops it on `agent_end`. No manual lifecycle management is needed.

---

## Architecture

```
OpenClaw Agent
    |
    |  lifecycle hooks (agent_start, tool_call_start, llm_call_end, ...)
    v
ClawWatchPlugin  (plugin.py)
    |
    |--- HookHandlers  (hooks.py)     Stateless context-to-event mappers
    |--- LoopDetector  (loop_detector.py)  Rolling-window duplicate detection
    |--- EventStore    (store.py)     SQLite write layer
    |--- ClawWatchServer (server.py)  HTTP + SSE server (stdlib only)
    |         |
    |         |--- GET  /api/v1/runs           List all runs from index.db
    |         |--- GET  /api/v1/runs/:id       Fetch events for a run
    |         |--- GET  /api/v1/events/stream  SSE stream of live events
    |         |--- POST /api/v1/runs/:id/review  Submit a review note
    |         |--- GET  /health                Server health check
    |         |
    v         v
  ~/.clawwatch/                   (override with CLAWWATCH_DIR)
      index.db              Global run registry
      runs/
        {run_id}.db          Per-run event database (one SQLite file per run)
      plugin.log             Error log (never surfaces to the agent)
      config.json            Optional configuration overrides

Bundled React Dashboard  (served from clawwatch/static/)
    |
    |--- api.ts              Fetch client + SSE subscription
    |--- risk.ts             Deterministic risk scoring (40+ rules)
    |--- goalAlignment.ts    Token-based goal drift measurement
    |--- hallucination.ts    Claim extraction and evidence matching
    |--- cost.ts             Per-model token cost estimation
    |
    Pages:
    |--- RunList             Grid of all recorded runs
    |--- RunDetail           Virtualized timeline + inspector drawer + insights
    |--- RiskReview          Queue of events requiring human review
    |--- CostDashboard       Token usage and cost breakdown
```

### Data flow

1. OpenClaw emits a lifecycle hook (e.g., `on_tool_call_start`).
2. `ClawWatchPlugin._safe()` wraps the handler so it never throws back to the agent.
3. `HookHandlers` maps the OpenClaw context object to a `ClawEvent` dataclass using `getattr` for maximum compatibility across OpenClaw versions.
4. The event is assigned a monotonically increasing `sequence_num` and inserted into the per-run SQLite database via `EventStore.append()`.
5. The JSON representation of the event is broadcast to all connected SSE clients via `_SSEBroadcaster`.
6. The React dashboard receives the event over SSE, enriches it with risk scores, goal alignment, and hallucination checks, and renders it in the timeline.

---

## Plugin Internals

### Hook Registration

The plugin declares an `openclaw.plugins` entry point in `pyproject.toml`:

```toml
[project.entry-points."openclaw.plugins"]
clawwatch = "clawwatch:ClawWatchPlugin"
```

OpenClaw discovers the plugin at startup and calls the matching `on_*` methods when lifecycle events occur. The full list of intercepted hooks:

| Hook | Trigger |
|---|---|
| `on_agent_start` | Agent begins execution. Opens a new run database. Starts the HTTP server. |
| `on_agent_end` | Agent finishes. Closes the run. Records final status. |
| `on_tool_call_start` | A tool invocation begins. Also feeds the loop detector. |
| `on_tool_call_end` | A tool invocation completes successfully. |
| `on_tool_error` | A tool invocation throws an exception. |
| `on_llm_call_start` | An LLM request is sent. Records model, token estimate, prompt preview. |
| `on_llm_call_end` | An LLM response is received. Captures full output text (up to 8 KB) for hallucination analysis. |
| `on_llm_error` | An LLM request fails. Records error type, message, HTTP status. |
| `on_file_read` | The agent reads a file. |
| `on_file_write` | The agent writes a file. |
| `on_file_delete` | The agent deletes a file. |
| `on_network_request` | An outbound HTTP request is initiated. |
| `on_network_response` | An HTTP response is received. |
| `on_subprocess` | The agent executes a shell command. Captures command tokens, exit code, stdout/stderr previews. |
| `on_env_access` | The agent reads an environment variable. |

### Loop Detection

`LoopDetector` maintains a rolling count of consecutive identical tool calls. On each `tool_call_start`, it computes an MD5 hash of `{tool_name, tool_args}`. If the same hash appears `threshold` times consecutively (default: 5), it emits a `loop_detected` event. This is a strong signal that the agent is stuck in a retry loop.

### Error Isolation

Every hook handler is wrapped in `_safe()`, which catches all exceptions and logs them to `~/.clawwatch/plugin.log`. The plugin never raises an exception back to the OpenClaw runtime. This is a hard design constraint: observability must never interfere with agent execution.

---

## Data Model

Every event captured by ClawWatch is a `ClawEvent` dataclass. The base fields are always present; payload fields are populated based on the event type.

### Base Fields (all events)

| Field | Type | Description |
|---|---|---|
| `event_id` | `TEXT PK` | UUID v4, generated per event |
| `run_id` | `TEXT` | UUID v4, generated per agent run |
| `agent_name` | `TEXT` | Name of the OpenClaw agent |
| `goal` | `TEXT` | The goal string passed to the agent |
| `wall_ts` | `REAL` | Unix timestamp (seconds) of event creation |
| `run_offset_ms` | `INTEGER` | Milliseconds elapsed since `agent_start` |
| `event_type` | `TEXT` | One of the 17 recognized event types |
| `sequence_num` | `INTEGER` | Monotonically increasing per-run counter |

### Event Types

`agent_start`, `agent_end`, `tool_call_start`, `tool_call_end`, `tool_error`, `llm_call_start`, `llm_call_end`, `llm_error`, `file_read`, `file_write`, `file_delete`, `network_request`, `network_response`, `subprocess_exec`, `env_access`, `loop_detected`, `review_note`

### Payload Fields by Category

**Tool call**: `tool_name`, `tool_args` (JSON, max 2 KB), `tool_result` (JSON, max 4 KB), `call_id`, `duration_ms`, `error_type`, `error_message`, `error_traceback`

**LLM call**: `model`, `input_tokens`, `output_tokens`, `prompt_preview` (first 200 chars), `llm_output_full` (up to 8 KB, used for hallucination detection)

**File operation**: `file_path`, `file_size_bytes`, `is_new_file` (INTEGER 0/1), `is_inside_workdir` (INTEGER 0/1)

**Network**: `url`, `method`, `request_body_bytes`, `response_status`, `response_body_bytes`

**Subprocess**: `command_tokens` (JSON array), `exit_code`, `stdout_preview` (first 500 chars), `stderr_preview` (first 500 chars)

**Environment**: `env_var_name`

**Loop detection**: `arg_hash`, `repeat_count`

**Agent lifecycle**: `status`, `tools_list` (JSON array), `workdir`

### Storage Layout

```
~/.clawwatch/
  index.db                   -- Single table: runs (run metadata + pointers)
  runs/
    {run_id}.db              -- Single table: events (all columns above)
```

Both databases use WAL journaling mode for concurrent read/write safety. The `index.db` stores one row per run with `run_id`, `agent_name`, `goal`, `started_at`, `ended_at`, `status`, `event_count`, and `db_path`. The per-run database stores the full event payload.

Old runs are cleaned up automatically based on the `retention_days` setting (default: 30 days). Pinned runs are excluded from cleanup.

---

## HTTP API and SSE

The plugin spawns a background HTTP server using Python's `http.server` module (no dependencies). It binds to `127.0.0.1` only and is not accessible from the network.

All API endpoints are versioned under `/api/v1/`. Requests to the unversioned `/api/` prefix are automatically forwarded to `/api/v1/` for backward compatibility.

### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Returns `{"status": "ok", "ts": <unix_timestamp>}` |
| `GET` | `/api/v1/runs` | JSON array of all runs from `index.db`, ordered by `started_at` descending |
| `GET` | `/api/v1/runs/:run_id` | JSON array of all events for the given run, ordered by `sequence_num` ascending |
| `GET` | `/api/v1/events/stream` | SSE stream. Each message is a JSON-serialized `ClawEvent`. Keepalive every 15s. |
| `POST` | `/api/v1/runs/:run_id/review` | Accepts `{"event_id": "...", "note": "..."}` and inserts a `review_note` event |

### CORS

All responses include `Access-Control-Allow-Origin: *`.

### SSE Broadcasting

The `_SSEBroadcaster` class maintains a list of per-client `queue.Queue` objects. When a new event is emitted by the plugin, it is pushed to all queues. If a client's queue is full (max 1000 events), the client is dropped. The SSE handler sends keepalive comments every 15 seconds to prevent connection timeouts.

### Static File Serving

When the server receives a request that does not match any API route, it serves files from the bundled `clawwatch/static/` directory. Unmatched paths fall back to `index.html` to support client-side routing. Hashed assets under `/assets/` are served with `Cache-Control: public, max-age=31536000, immutable`.

---

## Frontend Scoring Engines

All scoring is deterministic, runs entirely in the browser, and requires no server-side computation.

### Risk Scoring

The risk engine evaluates every event against 40+ rules organized by event type. Each rule produces a severity level (`safe`, `low`, `medium`, `high`, `critical`) and a numeric score (0-95). The highest severity across all matched rules determines the event's overall risk level. Events scoring above 70 are flagged as requiring human review.

**File operation rules** (examples):
- `critical_path`: operation on `/.ssh/`, `/.aws/`, `/.env`, `/etc/passwd`, etc.
- `shallow_delete`: deleting a path with fewer than 4 segments from root
- `executable_outside_workdir`: writing `.sh`, `.exe`, `.bin` outside the working directory
- `outside_workdir`: any file operation outside the declared working directory
- `delete_uncreated`: deleting a file the agent did not create during this run
- `credential_read`: reading `.pem`, `.key`, `.pfx`, `.p12` files

**Network rules** (examples):
- `private_ip_request`: request to RFC 1918 addresses or `::1`
- `metadata_endpoint`: request to cloud metadata services (`169.254.169.254`, `metadata.google.internal`)
- `exfil_domain`: request to known file-sharing/paste services (pastebin, transfer.sh, anonfiles, etc.)
- `large_post_body`: POST/PUT with body exceeding 100 KB

**Subprocess rules** (examples):
- `pipe_to_shell`: command pipes output to `bash`, `sh`, `python`, or `node`
- `dangerous_command`: use of `eval`, `exec(`, `base64 -d`, `xxd -r`
- `network_tool`: invocation of `nc` or `netcat`
- `privilege_escalation`: use of `sudo` or `chmod 777`

**LLM rules**: `huge_context` (>100k input tokens), `large_context` (>50k tokens)

### Goal Alignment

The goal alignment scorer tokenizes the original goal text and each event's description, then computes a weighted overlap ratio. Events that contain tokens matching the goal receive a higher alignment score. The aggregated drift percentage is displayed in the insights pane as a visual bar chart showing on-goal vs. off-goal segments over time.

### Hallucination Detection

The hallucination detector operates on `llm_call_end` events that contain `llm_output_full` text. It:

1. Extracts factual claims from the LLM output (e.g., "I have written the file", "I have fetched 500 records").
2. Builds an evidence map from all preceding events in the run (file writes, network responses, tool results).
3. Matches each claim against the evidence map, classifying it as `supported`, `unsupported`, or `contradicted`.
4. Produces a `HallucinationReport` with per-claim verdicts, explanations, and confidence levels.

A claim like "I have saved report.csv" is marked as `supported` only if there is a corresponding `file_write` event with a matching path. If there is no evidence, it is `unsupported`. If evidence contradicts the claim (e.g., the tool returned an error), it is `contradicted`.

### Cost Estimation

Token costs are estimated per model using published pricing tables (per million tokens). Supported models and their input/output rates:

| Model | Input ($/1M) | Output ($/1M) |
|---|---|---|
| claude-opus-4-5 | $15.00 | $75.00 |
| claude-sonnet-4-6 | $3.00 | $15.00 |
| claude-3-haiku | $0.25 | $1.25 |
| gpt-4 | $30.00 | $60.00 |
| gpt-4-turbo | $10.00 | $30.00 |
| gpt-4o | $5.00 | $15.00 |
| gpt-4o-mini | $0.15 | $0.60 |
| gpt-3.5-turbo | $0.50 | $1.50 |
| gemini-1.5-pro | $3.50 | $10.50 |
| gemini-1.5-flash | $0.35 | $1.05 |
| gemini-2.0-flash | $0.10 | $0.40 |

Unrecognized models fall back to $5.00 input / $15.00 output per million tokens.

---

## Configuration

ClawWatch works with zero configuration. All settings are optional and can be specified in `~/.clawwatch/config.json` or via environment variables.

```json
{
  "port": 8765,
  "loop_threshold": 5,
  "retention_days": 30,
  "pinned_runs": []
}
```

| Setting | Default | Env Var | Description |
|---|---|---|---|
| Data directory | `~/.clawwatch` | `CLAWWATCH_DIR` | Root directory for all databases, logs, and config |
| `port` | `8765` | `CLAWWATCH_PORT` | HTTP server listen port |
| `loop_threshold` | `5` | -- | Consecutive identical tool calls before emitting `loop_detected` |
| `retention_days` | `30` | -- | Automatically delete run databases older than this many days |
| `pinned_runs` | `[]` | -- | Array of `run_id` strings to exclude from automatic cleanup |

---

## CLI Reference

### `clawwatch ui`

Start the dashboard server and serve the bundled React UI.

```bash
clawwatch ui              # default port 8765
clawwatch ui --port 9000  # custom port
```

### `clawwatch doctor`

Run diagnostic checks against your environment. Reports plugin discoverability, port availability, data directory state, existing run count, bundled UI presence, and configuration.

```bash
clawwatch doctor
```

Example output:

```
  ✓ ClawWatch version 0.1.0
  ✓ Plugin registered as openclaw.plugins entry point
  ✓ Data directory exists: /Users/you/.clawwatch
  ✓ Index database: 5 run(s) recorded
  - No config file (using defaults)
  - CLAWWATCH_DIR not set (using ~/.clawwatch)
  ✓ Port 8765 is available
  ✓ Bundled UI assets found

  All checks passed. You're ready to go.
```

---

## Troubleshooting

### Port conflict: `OSError: [Errno 48] Address already in use`

Another process is already listening on port 8765. Either stop it or use a different port:

```bash
# Find what's using the port
lsof -ti :8765

# Use a different port
clawwatch ui --port 9000
```

### SQLite lock: `database is locked`

This can happen if two processes write to the same run database simultaneously. ClawWatch uses WAL mode to minimize this, but if you see this error, check for orphaned processes:

```bash
# Find any lingering ClawWatch or agent processes
ps aux | grep clawwatch
```

### Dashboard shows no runs

Run `clawwatch doctor` to verify the data directory and index database exist. If you see "No runs recorded yet", the plugin has not been activated by an agent yet. Run a test agent to generate data.

### Plugin not discovered by OpenClaw

Ensure ClawWatch is installed in the same Python environment as OpenClaw:

```bash
pip list | grep clawwatch
```

If missing, reinstall. If present but not discovered, use manual registration (see Quick Start).

---

## Contributing

### Building the UI from source

A `Makefile` is provided in `clawwatch-plugin/` for contributors who modify the React frontend:

```bash
make build    # Compile React app and copy assets into clawwatch/static/
make install  # pip install -e .
make dev      # build + install in one step
make clean    # Remove build artifacts
```

### Versioning

ClawWatch follows [Semantic Versioning](https://semver.org/). The version is pinned in `clawwatch/__init__.py` and `pyproject.toml`. See `CHANGELOG.md` for the full release history.

---

## Project Structure

```
clawwatch-plugin/
  pyproject.toml              Package metadata, entry points, and CLI registration
  Makefile                    Build automation for contributors
  CHANGELOG.md                Release history
  clawwatch/
    __init__.py               Exports ClawWatchPlugin, __version__
    plugin.py                 Main plugin class. Hook dispatch and orchestration.
    hooks.py                  Stateless handlers. Maps OpenClaw context to ClawEvent.
    event.py                  ClawEvent dataclass and builder functions.
    store.py                  SQLite read/write layer. Per-run databases + index.
    server.py                 HTTP + SSE server + static file serving (stdlib only).
    cli.py                    CLI entry point (clawwatch ui, clawwatch doctor).
    loop_detector.py          Rolling-window duplicate tool call detection.
    risk.py                   Reserved for future server-side risk checks.
    static/                   Pre-compiled React dashboard (bundled into the wheel).

clawwatch-ui/                 (source for the React dashboard — not needed at runtime)
  vite.config.ts              Dev server config with /api/v1 proxy to 127.0.0.1:8765
  src/
    App.tsx                   Root layout and routing (react-router-dom)
    index.css                 Global design system (dark mode, glassmorphism)
    lib/
      types.ts                TypeScript interfaces mirroring the Python event schema
      api.ts                  REST client and SSE subscription (api/v1/)
      risk.ts                 Deterministic risk scoring engine (40+ rules)
      goalAlignment.ts        Token-based goal drift scorer
      hallucination.ts        Claim extraction and evidence matching
      cost.ts                 Per-model token cost estimation
    pages/
      RunList.tsx             Grid of all recorded agent runs
      RunDetail.tsx           Timeline, inspector drawer, insights pane
      RiskReview.tsx          Queue of events requiring review
      CostDashboard.tsx       Token usage and cost breakdown
```
