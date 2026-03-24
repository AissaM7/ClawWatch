# @clawwatch/openclaw-plugin

Deep observability plugin for [OpenClaw](https://openclaw.ai) — streams LLM calls, tool executions, and cost diagnostics to the [ClawWatch](https://github.com/clawwatch/clawwatch) dashboard.

## What it captures

| Hook | Data | ClawWatch Feature |
|---|---|---|
| `llm_input` | Full prompt history, model, provider | Prompt preview, hallucination detection |
| `llm_output` | Raw completion, token counts | Cost dashboard, response analysis |
| `before_tool_call` | Tool name, arguments | Risk scoring, timeline |
| `tool_result_received` | Tool output, duration, errors | Error tracking, timeline |
| `model.usage` | Tokens, cost, latency | Cost dashboard |
| `command:*` | Session lifecycle | Run tracking |
| `message:*` | Inbound/outbound messages | Message timeline |
| `session:compact` | Compaction events | Session monitoring |

## Install

```bash
# From local path (for development)
openclaw plugins install /path/to/openclaw-plugin --link

# From npm (once published)
openclaw plugins install @clawwatch/openclaw-plugin
```

Then restart your OpenClaw gateway.

## Prerequisites

ClawWatch must be running to receive events:

```bash
pip install clawwatch
clawwatch ui
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CLAWWATCH_PORT` | `8765` | Port where ClawWatch is listening |

## Architecture

```
OpenClaw Gateway
    │
    ├─ llm_input / llm_output      ←── Agent execution loop
    ├─ before_tool_call             ←── Tool policy pipeline
    ├─ tool_result_received         ←── Tool completion
    ├─ model.usage                  ←── Diagnostic events
    ├─ command:new/stop/reset       ←── Session lifecycle
    └─ message:received/sent        ←── Channel traffic
    │
    ▼
  HTTP POST → 127.0.0.1:8765/api/v1/ingest
    │
    ▼
  ClawWatch (Python)
    ├── SQLite storage
    ├── Risk scoring engine
    ├── Hallucination detection
    └── Web dashboard
```

## License

MIT
