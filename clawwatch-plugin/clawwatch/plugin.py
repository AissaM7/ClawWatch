"""Main ClawWatch plugin — registers with OpenClaw and orchestrates hooks."""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Any

from clawwatch.event import ClawEvent, build_loop_detected
from clawwatch.hooks import HookHandlers
from clawwatch.loop_detector import LoopDetector
from clawwatch.server import ClawWatchServer
from clawwatch.store import EventStore, LOG_FILE, CONFIG_FILE

logger = logging.getLogger("clawwatch")

# Configure file logging so exceptions never surface to the agent
LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
_log_handler = logging.FileHandler(str(LOG_FILE), mode="a")
_log_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
logger.addHandler(_log_handler)
logger.setLevel(logging.WARNING)


def _load_config() -> dict:
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text())
        except Exception:
            return {}
    return {}


class ClawWatchPlugin:
    """OpenClaw plugin that observes every lifecycle event and stores it locally."""

    # Plugin manifest — read by OpenClaw at discovery time
    name = "clawwatch"
    version = "0.1.0"
    hooks = [
        "agent_start", "agent_end",
        "tool_call_start", "tool_call_end", "tool_error",
        "llm_call_start", "llm_call_end", "llm_error",
        "file_read", "file_write", "file_delete",
        "network_request", "network_response",
        "subprocess_exec", "env_access",
    ]
    # ── Global State across plugin instances ──────────────────────
    _global_run_id: str = ""
    _global_agent_name: str = ""
    _global_goal: str = ""
    _global_start_ts: float = 0.0
    _global_active_agents: int = 0

    def __init__(self) -> None:
        config = _load_config()
        self._port = int(os.environ.get("CLAWWATCH_PORT", config.get("port", 8765)))
        self._loop_threshold = config.get("loop_threshold", 5)

        self._store = EventStore()
        self._server = ClawWatchServer(self._port)
        self._loop_detector = LoopDetector(self._loop_threshold)
        self._handlers = HookHandlers()
        
        self._server.start()

    # ── Internal helpers ──────────────────────────────────────────

    def _emit(self, event: ClawEvent) -> None:
        """Store and broadcast an event. Never raises."""
        try:
            event = self._store.append(event)
            self._server.broadcast_event(json.dumps(event.to_dict(), default=str))
        except Exception:
            logger.exception("Failed to emit event")

    def _safe(self, fn, *args, **kwargs):
        """Wrap any handler so it can never crash the agent."""
        try:
            return fn(*args, **kwargs)
        except Exception:
            logger.exception(f"Hook handler error in {fn.__name__}")

    # ── OpenClaw hook interface ───────────────────────────────────

    def on_agent_start(self, context: Any) -> None:
        self._safe(self._handle_agent_start, context)

    def on_agent_end(self, context: Any) -> None:
        self._safe(self._handle_agent_end, context)

    def on_tool_call_start(self, context: Any) -> None:
        self._safe(self._handle_tool_call_start, context)

    def on_tool_call_end(self, context: Any) -> None:
        self._safe(self._handle_tool_call_end, context)

    def on_tool_error(self, context: Any) -> None:
        self._safe(self._handle_tool_error, context)

    def on_llm_call_start(self, context: Any) -> None:
        self._safe(self._handle_llm_call_start, context)

    def on_llm_call_end(self, context: Any) -> None:
        self._safe(self._handle_llm_call_end, context)

    def on_llm_error(self, context: Any) -> None:
        self._safe(self._handle_llm_error, context)

    def on_file_read(self, context: Any) -> None:
        self._safe(self._handle_file_read, context)

    def on_file_write(self, context: Any) -> None:
        self._safe(self._handle_file_write, context)

    def on_file_delete(self, context: Any) -> None:
        self._safe(self._handle_file_delete, context)

    def on_network_request(self, context: Any) -> None:
        self._safe(self._handle_network_request, context)

    def on_network_response(self, context: Any) -> None:
        self._safe(self._handle_network_response, context)

    def on_subprocess(self, context: Any) -> None:
        self._safe(self._handle_subprocess, context)

    def on_env_access(self, context: Any) -> None:
        self._safe(self._handle_env_access, context)

    # ── Handler implementations ───────────────────────────────────

    def _handle_agent_start(self, ctx: Any) -> None:
        if ClawWatchPlugin._global_active_agents == 0:
            ClawWatchPlugin._global_run_id = str(uuid.uuid4())
            ClawWatchPlugin._global_start_ts = time.time()
            ClawWatchPlugin._global_agent_name = getattr(ctx, "agent_name", "unknown")
            ClawWatchPlugin._global_goal = getattr(ctx, "goal", "")

            self._store.open_run(ClawWatchPlugin._global_run_id, ClawWatchPlugin._global_agent_name, ClawWatchPlugin._global_goal)
            
            event = self._handlers.agent_start(ctx, ClawWatchPlugin._global_run_id, ClawWatchPlugin._global_start_ts)
            self._emit(event)

        ClawWatchPlugin._global_active_agents += 1

    def _handle_agent_end(self, ctx: Any) -> None:
        ClawWatchPlugin._global_active_agents = max(0, ClawWatchPlugin._global_active_agents - 1)
        if ClawWatchPlugin._global_active_agents == 0:
            event = self._handlers.agent_end(
                ctx, ClawWatchPlugin._global_run_id, ClawWatchPlugin._global_agent_name, ClawWatchPlugin._global_goal, ClawWatchPlugin._global_start_ts
            )
            self._emit(event)
            
            status = getattr(ctx, "status", "completed")
            self._store.close_run(status)
            ClawWatchPlugin._global_run_id = ""

    def _handle_tool_call_start(self, ctx: Any) -> None:
        event = self._handlers.tool_call_start(
            ctx, ClawWatchPlugin._global_run_id, ClawWatchPlugin._global_agent_name, ClawWatchPlugin._global_goal, ClawWatchPlugin._global_start_ts
        )
        self._emit(event)

        # Loop detection
        tool_name = getattr(ctx, "tool_name", "unknown")
        tool_args = json.dumps(getattr(ctx, "arguments", {}), default=str)
        result = self._loop_detector.record_call(tool_name, tool_args)
        if result:
            arg_hash, count = result
            loop_event = build_loop_detected(
                ClawWatchPlugin._global_run_id, ClawWatchPlugin._global_agent_name, ClawWatchPlugin._global_goal,
                tool_name, arg_hash, count, ClawWatchPlugin._global_start_ts,
            )
            self._emit(loop_event)

    def _handle_tool_call_end(self, ctx: Any) -> None:
        event = self._handlers.tool_call_end(
            ctx, ClawWatchPlugin._global_run_id, ClawWatchPlugin._global_agent_name, ClawWatchPlugin._global_goal, ClawWatchPlugin._global_start_ts
        )
        self._emit(event)

    def _handle_tool_error(self, ctx: Any) -> None:
        event = self._handlers.tool_error(
            ctx, ClawWatchPlugin._global_run_id, ClawWatchPlugin._global_agent_name, ClawWatchPlugin._global_goal, ClawWatchPlugin._global_start_ts
        )
        self._emit(event)

    def _handle_llm_call_start(self, ctx: Any) -> None:
        event = self._handlers.llm_call_start(
            ctx, ClawWatchPlugin._global_run_id, ClawWatchPlugin._global_agent_name, ClawWatchPlugin._global_goal, ClawWatchPlugin._global_start_ts
        )
        self._emit(event)

    def _handle_llm_call_end(self, ctx: Any) -> None:
        event = self._handlers.llm_call_end(
            ctx, ClawWatchPlugin._global_run_id, ClawWatchPlugin._global_agent_name, ClawWatchPlugin._global_goal, ClawWatchPlugin._global_start_ts
        )
        self._emit(event)

    def _handle_llm_error(self, ctx: Any) -> None:
        event = self._handlers.llm_error(
            ctx, ClawWatchPlugin._global_run_id, ClawWatchPlugin._global_agent_name, ClawWatchPlugin._global_goal, ClawWatchPlugin._global_start_ts
        )
        self._emit(event)

    def _handle_file_read(self, ctx: Any) -> None:
        event = self._handlers.file_read(
            ctx, ClawWatchPlugin._global_run_id, ClawWatchPlugin._global_agent_name, ClawWatchPlugin._global_goal, ClawWatchPlugin._global_start_ts
        )
        self._emit(event)

    def _handle_file_write(self, ctx: Any) -> None:
        event = self._handlers.file_write(
            ctx, ClawWatchPlugin._global_run_id, ClawWatchPlugin._global_agent_name, ClawWatchPlugin._global_goal, ClawWatchPlugin._global_start_ts
        )
        self._emit(event)

    def _handle_file_delete(self, ctx: Any) -> None:
        event = self._handlers.file_delete(
            ctx, ClawWatchPlugin._global_run_id, ClawWatchPlugin._global_agent_name, ClawWatchPlugin._global_goal, ClawWatchPlugin._global_start_ts
        )
        self._emit(event)

    def _handle_network_request(self, ctx: Any) -> None:
        event = self._handlers.network_request(
            ctx, ClawWatchPlugin._global_run_id, ClawWatchPlugin._global_agent_name, ClawWatchPlugin._global_goal, ClawWatchPlugin._global_start_ts
        )
        self._emit(event)

    def _handle_network_response(self, ctx: Any) -> None:
        event = self._handlers.network_response(
            ctx, ClawWatchPlugin._global_run_id, ClawWatchPlugin._global_agent_name, ClawWatchPlugin._global_goal, ClawWatchPlugin._global_start_ts
        )
        self._emit(event)

    def _handle_subprocess(self, ctx: Any) -> None:
        event = self._handlers.subprocess_exec(
            ctx, ClawWatchPlugin._global_run_id, ClawWatchPlugin._global_agent_name, ClawWatchPlugin._global_goal, ClawWatchPlugin._global_start_ts
        )
        self._emit(event)

    def _handle_env_access(self, ctx: Any) -> None:
        event = self._handlers.env_access(
            ctx, ClawWatchPlugin._global_run_id, ClawWatchPlugin._global_agent_name, ClawWatchPlugin._global_goal, ClawWatchPlugin._global_start_ts
        )
        self._emit(event)
