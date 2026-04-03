<p align="center">
  <strong>Claw Watch</strong>
</p>

<p align="center">
  <em>Real-time observability, risk scoring &amp; hallucination detection for autonomous AI agents.</em>
</p>

<p align="center">
  <img src="./assets/ClawWatchDemo.gif" alt="ClawWatch Demo" width="100%" />
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#plugin-integration">Plugin Integration</a> ·
  <a href="#ui-guide">UI Guide</a> ·
  <a href="#api-reference">API Reference</a> ·
  <a href="#development">Development</a>
</p>

---

## What is ClawWatch?

ClawWatch is a self-hosted observability platform purpose-built for **autonomous AI agents**. It intercepts every LLM call, tool invocation, file operation, and network request an agent makes — in real time — and presents them in a hierarchical, waterfall-style trace visualization with risk scoring and hallucination detection.

**Key capabilities:**

-  **Hierarchical Trace Visualization** — Waterfall timeline grouped by conversation turns, with duration bars and cost tracking
-  **Semantic Chunking MiniMap** — "God-mode" navigation via Intent Chapters that compress completed turns into scannable glass cards
-  **Risk Scoring Engine** — 16 built-in rules that flag dangerous operations (file deletion, env access, network exfiltration) with severity levels
-  **Hallucination Detection** — Claim-level analysis of LLM outputs scored as Supported, Unsupported, or Contradicted
-  **Multi-Agent Swarm Support** — Architecture-ready for visualizing agent delegation chains
-  **Cost Tracking** — Per-model token usage and estimated USD cost per run
-  **Loop Detection** — Identifies when agents get stuck in repetitive action cycles

---

## Quick Start

### Prerequisites

| Requirement | Version | Why |
|---|---|---|
| **Node.js** | ≥ 18.0 | UI build toolchain |
| **Python** | ≥ 3.9 | Backend server + plugin hooks |
| **pip3** | Any | Python package manager |
| **npm** | ≥ 9.0 | Node package manager |

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/AissaM7/ClawWatch.git
cd ClawWatch

# 2. Install the Python plugin (includes the backend server + CLI)
pip3 install --user -e ./clawwatch-plugin
# Note: If pip3 fails with permission errors, use:
# sudo pip3 install -e ./clawwatch-plugin

# 3. Install UI dependencies and build
cd clawwatch-ui
npm install
npm run build

# 4. Copy built assets into the plugin's static directory
cp -r dist/* ../clawwatch-plugin/clawwatch/static/

# 5. Go back and install the plugin again to pick up new static files
cd ..
pip3 install --user -e ./clawwatch-plugin
# Or: sudo pip3 install -e ./clawwatch-plugin

# 6. Launch ClawWatch
clawwatch ui
# → ClawWatch running at http://127.0.0.1:8765
```

### Verify it's Working

Open `http://127.0.0.1:8765` in your browser. You should see the ClawWatch **Agent Dashboard** with a new persistent **Sidebar** navigation to access: **Dashboard**, **Timeline**, **All Runs**, **Agents**, **Risk Review**, and **Cost**.

---

## Architecture

ClawWatch has three components:

```
┌─────────────────────────────────────────────────────────────────┐
│                         YOUR AGENT                              │
│  (OpenClaw / CrewAI / LangChain / Custom)                       │
│                                                                 │
│  ┌──────────────────────┐                                       │
│  │   ClawWatch Plugin   │ ← Hooks into agent lifecycle events   │
│  │  (openclaw-plugin/)  │                                       │
│  │  (clawwatch/plugin.py)                                       │
│  └──────────┬───────────┘                                       │
└─────────────┼───────────────────────────────────────────────────┘
              │ HTTP POST /api/v1/events
              ▼
┌──────────────────────────┐     ┌────────────────────────────────┐
│   ClawWatch Backend      │     │     ClawWatch UI               │
│  (clawwatch/server.py)   │────▶│   (clawwatch-ui/)              │
│  (clawwatch/store.py)    │     │                                │
│                          │     │  React + TypeScript + Vite     │
│  • REST API on :8765     │     │  • Hierarchical Trace Tree     │
│  • SQLite data store     │     │  • Semantic Chunking MiniMap   │
│  • Static file server    │     │  • Risk Scoring Panel          │
│  • Thread management     │     │  • Hallucination Inspector     │
└──────────────────────────┘     └────────────────────────────────┘
```

### Directory Structure

```
ClawWatch/
├── clawwatch-plugin/           # Backend + agent plugins
│   ├── clawwatch/
│   │   ├── __init__.py
│   │   ├── cli.py              # CLI commands (clawwatch ui, status, etc.)
│   │   ├── server.py           # HTTP server (REST API + static files)
│   │   ├── store.py            # SQLite data store (all CRUD operations)
│   │   ├── plugin.py           # Python plugin hooks (CrewAI/LangChain)
│   │   ├── hooks.py            # Event builder functions
│   │   ├── event.py            # Event schema definitions
│   │   ├── risk.py             # Risk scoring engine (16 rules)
│   │   ├── loop_detector.py    # Agent loop detection
│   │   └── static/             # Built UI assets (copied from clawwatch-ui/dist)
│   ├── openclaw-plugin/        # OpenClaw TypeScript plugin
│   │   ├── index.ts            # Main plugin entry point
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── setup.py
│   └── pyproject.toml
│
├── clawwatch-ui/               # Frontend dashboard
│   ├── src/
│   │   ├── main.tsx            # App entry point
│   │   ├── App.tsx             # Router + navigation
│   │   ├── index.css           # Complete design system (~5000 lines)
│   │   ├── pages/
│   │   │   ├── Home.tsx        # Dashboard overview
│   │   │   ├── AllRuns.tsx     # Run list with search/filter
│   │   │   ├── Agents.tsx      # Agent list with thread management
│   │   │   ├── RunDetail.tsx   # Main trace timeline view
│   │   │   ├── RiskReview.tsx  # Risk event review queue
│   │   │   └── Cost.tsx        # Token usage + cost analytics
│   │   ├── components/
│   │   │   ├── AgentPathMiniMap.tsx  # Semantic chunking minimap
│   │   │   └── TraceRow.tsx         # Individual trace row renderer
│   │   ├── lib/
│   │   │   ├── traceTree.ts    # Trace→tree builder + status derivation
│   │   │   ├── minimap.ts      # Chapter compression algorithm
│   │   │   └── store.ts        # Zustand state management
│   │   └── types/
│   │       └── index.ts        # TypeScript type definitions
│   ├── package.json
│   ├── vite.config.ts
│   └── tsconfig.json
│
└── README.md                   # This file
```

---

## Plugin Integration

ClawWatch intercepts agent events via **plugins** — small adapters that hook into your agent framework's lifecycle.

### OpenClaw Plugin (TypeScript)

The OpenClaw plugin is located at `clawwatch-plugin/openclaw-plugin/` and hooks into the OpenClaw agent framework.

**How it works:**

1. **Registration** — The plugin registers via OpenClaw's `api.on()` hook system
2. **Event Interception** — It listens to 6 lifecycle events:

| Hook | Event Emitted | What it captures |
|---|---|---|
| `llm_input` | `llm_call_start` | Model name, prompt preview, system prompt length, images count |
| `llm_output` | `llm_call_end` | Full LLM output (up to 8KB), token usage (input/output/cache) |
| `before_tool_call` | `tool_call_start` | Tool name, arguments, pre-execution context |
| `after_tool_call` | `tool_call_end` | Tool result, execution duration |
| `agent_start` | `agent_start` | Agent name, goal, session metadata |
| `agent_end` | `agent_end` | Final status, total duration |

3. **Session Isolation** — Each conversation gets a unique `sessionKey` to prevent cross-session event leaking in concurrent environments
4. **Transport** — Events are POSTed to `http://127.0.0.1:8765/api/v1/events` as JSON

**Key files:**

- `openclaw-plugin/index.ts` — Main plugin (~700 lines). Contains all hook handlers, session management, and the `send()` transport function
- `openclaw-plugin/package.json` — Dependencies (none beyond OpenClaw's plugin API)

### Python Plugin (CrewAI / LangChain)

The Python plugin at `clawwatch/plugin.py` provides hooks for Python-based agent frameworks.

**Supported frameworks:**
- CrewAI (via `CrewAIWatcher`)
- LangChain (via callback handler)
- Any custom Python agent (via manual event emission)

**Hook methods:**

```python
class ClawWatchPlugin:
    def on_agent_start(self, context)      # Agent begins execution
    def on_agent_end(self, context)        # Agent finishes
    def on_llm_call_start(self, context)   # LLM request sent
    def on_llm_call_end(self, context)     # LLM response received
    def on_tool_call_start(self, context)  # Tool invocation begins
    def on_tool_call_end(self, context)    # Tool invocation completes
    def on_tool_error(self, context)       # Tool execution failed
```

---

## Event Schema

Every event POSTed to ClawWatch follows this schema:

```json
{
  "event_id": "uuid-v4",
  "run_id": "uuid-v4",
  "event_type": "llm_call_start | llm_call_end | llm_error | tool_call_start | tool_call_end | tool_error | agent_start | agent_end | file_read | file_write | file_delete | network_request | network_response | subprocess_exec | env_access | loop_detected | review_note",
  "agent_name": "string",
  "goal": "string (agent's current objective)",
  "timestamp": "ISO-8601",
  "run_offset_ms": 0,
  "duration_ms": 0,
  "sequence_num": 0,

  "model": "gemini-2.5-flash (for LLM events)",
  "prompt_preview": "First 500 chars of prompt",
  "llm_output_full": "Full LLM output up to 8KB",
  "input_tokens": 0,
  "output_tokens": 0,

  "tool_name": "web_search | read | write | telegram | ...",
  "tool_args": "Serialized tool arguments",
  "tool_result": "Serialized tool result",

  "risk_score": 0,
  "risk_rules": "JSON array of triggered risk rules",
  "on_goal": true,
  "status": "completed | error | timeout"
}
```

**Supported event types:**

| Category | Event Types |
|---|---|
| **Agent Lifecycle** | `agent_start`, `agent_end` |
| **LLM Calls** | `llm_call_start`, `llm_call_end`, `llm_error` |
| **Tool Calls** | `tool_call_start`, `tool_call_end`, `tool_error` |
| **File Operations** | `file_read`, `file_write`, `file_delete` |
| **Network** | `network_request`, `network_response` |
| **System** | `subprocess_exec`, `env_access`, `loop_detected`, `review_note` |

---

## UI Guide

### Agent Dashboard & Navigation (New)

The new **Sidebar** provides a persistent navigation menu across all views. The main **Agent Dashboard** provides a high-level overview of agent performance, recent runs, health metrics, and active swarms, serving as the entry point for observing your AI fleet.

### Data Explorer Views

The **All Runs** and **Agents** pages utilize a new **high-density, searchable vertical list view**, optimized for scanning large volumes of agent logs, displaying statuses, durations, tools used, and thread names at a glance.

### Timeline View (RunDetail)

The main view. Displays a hierarchical waterfall trace of all agent events:

- **Conversation Turns** — Events are grouped by user prompt, creating clear turn boundaries
- **Waterfall Bars** — Visual duration bars showing relative timing of each operation
- **Status Indicators** — Color-coded: green (success), red (error), yellow (timeout)
- **Inspector Panel** — Click any row to open the detail panel showing raw JSON, risk rules, and metadata

### Semantic Chunking MiniMap (AgentPathMiniMap)

The sticky header providing "god-mode" navigation:

- **Archived Chapters** — Past conversation turns compressed into glassmorphism cards showing:
  - Title (truncated prompt text)
  - Health dot (green ≥ 0.8, yellow ≥ 0.5, red < 0.5)
  - Duration + step count
  - Error badge (if errors > 0)
  - Ghost preview trail on hover (faint icon sequence)
- **Active Chapter** — Current turn expanded as a full node-link graph with connectors and pulse animations
- **Click Navigation** — Click any card or node to scroll the timeline to that event

**Health Score Formula:**

```
H = (Σ successes − Σ errors × 2) / total_steps
```

| Score | Label | Color |
|---|---|---|
| H ≥ 0.8 | Healthy | 🟢 Green |
| 0.5 ≤ H < 0.8 | Flaky | 🟡 Yellow |
| H < 0.5 | Failed | 🔴 Red |

### Trace Tree Builder (traceTree.ts)

The core data transformation engine. Converts flat `TraceEvent[]` into a hierarchical `TraceNode[]` tree:

1. **Enrichment** — Raw events are enriched with `run_offset_ms` calculations
2. **Prompt Detection** — `llm_call_start` events with channel tool names (telegram, discord, terminal) are identified as user prompts, creating turn boundaries
3. **LLM Matching** — Each `llm_call_start` is paired with its `llm_call_end` by model name; unmatched starts → timeout status
4. **System Grouping** — Infrastructure events (bootstrap, preprocess) are collapsed into "System Initialization" groups
5. **Status Derivation** — `deriveAgentEndStatus()` computes the final status for each scope using a non-sticky state machine that respects retry recovery

### Risk Review

Flagged events are surfaced for human review. The 16 built-in risk rules include:

| Rule | Severity | Trigger |
|---|---|---|
| `file_delete` | Critical | Agent deletes a file |
| `env_access` | High | Agent reads environment variables |
| `subprocess_exec` | High | Agent executes shell commands |
| `network_exfil` | Critical | Large outbound data transfers |
| `sensitive_path` | High | Access to `~/.ssh`, `~/.aws`, etc. |
| `loop_detected` | Medium | Agent repeats same action pattern |

### Cost Analytics

Token usage tracking with per-model cost estimation:

| Model | Input ($/1M tokens) | Output ($/1M tokens) |
|---|---|---|
| gemini-2.5-pro | $1.25 | $10.00 |
| gemini-2.5-flash | $0.075 | $0.30 |
| gpt-4o | $2.50 | $10.00 |

---

## Data Storage

ClawWatch uses **SQLite** for zero-configuration persistence.

- **Location:** `~/.clawwatch/clawwatch.db`
- **Tables:** `runs`, `events`, `agents`, `threads`
- **Managed by:** `clawwatch/store.py`

The database is created automatically on first run. No migrations or setup required.

---

## API Reference

All endpoints are served at `http://127.0.0.1:8765`.

### Runs

```
GET    /api/v1/runs              # List all runs (newest first)
GET    /api/v1/runs/:run_id      # Get all events for a specific run
DELETE /api/v1/runs/:run_id      # Delete a run and its events
```

### Agents

```
GET    /api/v1/agents            # List all known agents
```

### Threads

```
PATCH  /api/v1/threads/:id       # Update thread metadata (name, etc.)
```

### Events (Plugin → Backend)

```
POST   /api/v1/events            # Ingest a new event (used by plugins)
```

### Static Assets

```
GET    /                         # Serves index.html (SPA entry point)
GET    /assets/*                 # Serves built JS/CSS bundles
GET    /*                        # SPA fallback → index.html
```

---

## Development

### UI Development (Hot Reload)

```bash
cd clawwatch-ui
npm install
npm run dev -- --port 5174
# → http://localhost:5174
```

The Vite dev server proxies API calls to `http://127.0.0.1:8765` (configured in `vite.config.ts`).

**Important:** The backend must be running separately:
```bash
clawwatch ui   # in another terminal
```

### Building for Production

```bash
cd clawwatch-ui
npm run build                    # TypeScript check + Vite production build
# Output: dist/index.html, dist/assets/

# Deploy to backend:
cp -r dist/* ../clawwatch-plugin/clawwatch/static/
cd .. && pip3 install --user -e ./clawwatch-plugin
```

### Tech Stack

| Layer | Technology |
|---|---|
| **UI Framework** | React 19 + TypeScript |
| **Build Tool** | Vite 8 |
| **State Management** | Zustand |
| **Animations** | Framer Motion |
| **Icons** | Lucide React |
| **Styling** | Vanilla CSS (glassmorphism design system) |
| **Backend** | Python `http.server` + SQLite |
| **Plugin Transport** | HTTP POST (JSON) |

### Design System

The UI uses a custom dark-mode glassmorphism design system defined entirely in `src/index.css`, recently modernized for a more premium professional aesthetic:

- **Color tokens:** `--color-safe`, `--color-critical`, `--color-llm`, `--color-live`, plus sophisticated navy-to-blue gradient branding.
- **Typography:** Inter (sans) for a clean tech look + JetBrains Mono (code).
- **Effects:** `backdrop-filter: blur()`, gradient borders, pulse animations, and high-density layouts for maximum observability.
- **Component classes:** `.mm-*` (minimap), `.wf-*` (waterfall), `.event-row-*` (trace rows).

---

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `CLAWWATCH_PORT` | `8765` | Backend server port |
| `CLAWWATCH_DB_PATH` | `~/.clawwatch/clawwatch.db` | SQLite database location |
| `CLAWWATCH_LOG_LEVEL` | `info` | Logging verbosity |

---

## Troubleshooting

### Port already in use

```bash
lsof -ti :8765 | xargs kill -9
clawwatch ui
```

### pip3 permission denied

```bash
# Option 1: Use --user flag
pip3 install --user -e ./clawwatch-plugin

# Option 2: Use sudo (not recommended)
sudo pip3 install -e ./clawwatch-plugin

# Option 3: Use pipx (recommended for isolation)
pipx install ./clawwatch-plugin
```

### UI shows stale data after code changes

```bash
cd clawwatch-ui && npm run build
cp -r dist/* ../clawwatch-plugin/clawwatch/static/
pip3 install --user -e ../clawwatch-plugin
# Restart: clawwatch ui
```

### "command not found: pip"

On macOS, use `pip3` instead of `pip`. The system Python 3 ships with `pip3`.

---

## License

MIT

---

<p align="center">
  Built for the agentic era. 🐾
</p>
