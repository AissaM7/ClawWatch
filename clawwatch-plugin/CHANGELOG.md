# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-03-23

### Added

- Core plugin that intercepts all 15 OpenClaw lifecycle hooks.
- Per-run SQLite storage under `~/.clawwatch/runs/` with WAL journaling.
- Global run index database (`~/.clawwatch/index.db`).
- Background HTTP server (stdlib only, no dependencies) on `127.0.0.1:8765`.
- REST API: `GET /api/v1/runs`, `GET /api/v1/runs/:id`, `POST /api/v1/runs/:id/review`.
- Server-Sent Events stream at `GET /api/v1/events/stream`.
- Rolling-window loop detection with configurable threshold.
- Bundled React dashboard served as static assets from the Python package.
- CLI entry point: `clawwatch ui [--port PORT]` and `clawwatch doctor`.
- Frontend risk scoring engine with 40+ deterministic rules.
- Frontend hallucination detection via claim extraction and evidence matching.
- Frontend goal alignment scoring via token overlap.
- Frontend cost estimation for 11 LLM models.
- Automatic run retention cleanup (default: 30 days).
- Configuration via `~/.clawwatch/config.json` or environment variables.

### Data Model

- 17 event types: `agent_start`, `agent_end`, `tool_call_start`, `tool_call_end`,
  `tool_error`, `llm_call_start`, `llm_call_end`, `llm_error`, `file_read`,
  `file_write`, `file_delete`, `network_request`, `network_response`,
  `subprocess_exec`, `env_access`, `loop_detected`, `review_note`.

### API

- All endpoints are prefixed with `/api/v1/`.
- SSE keepalive interval: 15 seconds.
- CORS: `Access-Control-Allow-Origin: *`.
