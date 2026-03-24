"""One handler per OpenClaw lifecycle hook."""

from __future__ import annotations

import json
import logging
from typing import Any

from clawwatch.event import (
    build_agent_start, build_agent_end,
    build_tool_call_start, build_tool_call_end, build_tool_error,
    build_llm_call_start, build_llm_call_end, build_llm_error,
    build_file_event, build_network_request, build_network_response,
    build_subprocess, build_env_access, build_loop_detected,
)

logger = logging.getLogger("clawwatch")


class HookHandlers:
    """Stateless hook handlers — each returns a ClawEvent."""

    @staticmethod
    def agent_start(ctx: Any, run_id: str, start_ts: float):
        return build_agent_start(
            run_id=run_id,
            agent_name=getattr(ctx, "agent_name", "unknown"),
            goal=getattr(ctx, "goal", ""),
            workdir=getattr(ctx, "working_directory", ""),
            tools=getattr(ctx, "tools", []),
            start_ts=start_ts,
        )

    @staticmethod
    def agent_end(ctx: Any, run_id: str, agent_name: str, goal: str, start_ts: float):
        return build_agent_end(
            run_id=run_id,
            agent_name=agent_name,
            goal=goal,
            status=getattr(ctx, "status", "completed"),
            start_ts=start_ts,
            error_message=getattr(ctx, "error", None),
        )

    @staticmethod
    def tool_call_start(ctx: Any, run_id: str, agent_name: str, goal: str, start_ts: float):
        args = getattr(ctx, "arguments", {})
        return build_tool_call_start(
            run_id=run_id,
            agent_name=agent_name,
            goal=goal,
            tool_name=getattr(ctx, "tool_name", "unknown"),
            tool_args=json.dumps(args, default=str)[:2048],
            call_id=getattr(ctx, "call_id", ""),
            start_ts=start_ts,
        )

    @staticmethod
    def tool_call_end(ctx: Any, run_id: str, agent_name: str, goal: str, start_ts: float):
        result = getattr(ctx, "return_value", None)
        return build_tool_call_end(
            run_id=run_id,
            agent_name=agent_name,
            goal=goal,
            tool_name=getattr(ctx, "tool_name", "unknown"),
            tool_result=json.dumps(result, default=str)[:4096],
            call_id=getattr(ctx, "call_id", ""),
            duration_ms=getattr(ctx, "duration_ms", 0),
            start_ts=start_ts,
        )

    @staticmethod
    def tool_error(ctx: Any, run_id: str, agent_name: str, goal: str, start_ts: float):
        return build_tool_error(
            run_id=run_id,
            agent_name=agent_name,
            goal=goal,
            tool_name=getattr(ctx, "tool_name", "unknown"),
            error_type=getattr(ctx, "exception_type", "Error"),
            error_message=str(getattr(ctx, "exception_message", "")),
            error_traceback=getattr(ctx, "traceback", ""),
            call_id=getattr(ctx, "call_id", ""),
            start_ts=start_ts,
        )

    @staticmethod
    def llm_call_start(ctx: Any, run_id: str, agent_name: str, goal: str, start_ts: float):
        messages = getattr(ctx, "messages", [])
        preview = ""
        if messages:
            if isinstance(messages, list) and len(messages) > 0:
                last = messages[-1]
                preview = str(last.get("content", "") if isinstance(last, dict) else last)[:200]
            elif isinstance(messages, str):
                preview = messages[:200]
        return build_llm_call_start(
            run_id=run_id,
            agent_name=agent_name,
            goal=goal,
            model=getattr(ctx, "model", "unknown"),
            input_tokens=getattr(ctx, "input_token_estimate", 0),
            prompt_preview=preview,
            call_id=getattr(ctx, "call_id", ""),
            start_ts=start_ts,
        )

    @staticmethod
    def llm_call_end(ctx: Any, run_id: str, agent_name: str, goal: str, start_ts: float):
        response_text = ""
        resp = getattr(ctx, "response", None)
        if resp:
            if isinstance(resp, str):
                response_text = resp
            elif isinstance(resp, dict):
                response_text = json.dumps(resp, default=str)
            else:
                response_text = str(resp)

        return build_llm_call_end(
            run_id=run_id,
            agent_name=agent_name,
            goal=goal,
            model=getattr(ctx, "model", "unknown"),
            input_tokens=getattr(ctx, "input_tokens", 0),
            output_tokens=getattr(ctx, "output_tokens", 0),
            duration_ms=getattr(ctx, "duration_ms", 0),
            call_id=getattr(ctx, "call_id", ""),
            llm_output_full=response_text[:8192],
            start_ts=start_ts,
        )

    @staticmethod
    def llm_error(ctx: Any, run_id: str, agent_name: str, goal: str, start_ts: float):
        return build_llm_error(
            run_id=run_id,
            agent_name=agent_name,
            goal=goal,
            model=getattr(ctx, "model", "unknown"),
            error_type=getattr(ctx, "error_type", "Error"),
            error_message=str(getattr(ctx, "error_message", "")),
            start_ts=start_ts,
            response_status=getattr(ctx, "http_status", None),
        )

    @staticmethod
    def file_read(ctx: Any, run_id: str, agent_name: str, goal: str, start_ts: float):
        return build_file_event(
            run_id=run_id,
            agent_name=agent_name,
            goal=goal,
            event_type="file_read",
            file_path=getattr(ctx, "file_path", ""),
            file_size_bytes=getattr(ctx, "file_size", 0),
            is_inside_workdir=getattr(ctx, "is_inside_workdir", True),
            start_ts=start_ts,
        )

    @staticmethod
    def file_write(ctx: Any, run_id: str, agent_name: str, goal: str, start_ts: float):
        return build_file_event(
            run_id=run_id,
            agent_name=agent_name,
            goal=goal,
            event_type="file_write",
            file_path=getattr(ctx, "file_path", ""),
            file_size_bytes=getattr(ctx, "bytes_written", 0),
            is_inside_workdir=getattr(ctx, "is_inside_workdir", True),
            start_ts=start_ts,
            is_new_file=getattr(ctx, "is_new_file", None),
        )

    @staticmethod
    def file_delete(ctx: Any, run_id: str, agent_name: str, goal: str, start_ts: float):
        return build_file_event(
            run_id=run_id,
            agent_name=agent_name,
            goal=goal,
            event_type="file_delete",
            file_path=getattr(ctx, "file_path", ""),
            file_size_bytes=0,
            is_inside_workdir=getattr(ctx, "is_inside_workdir", True),
            start_ts=start_ts,
        )

    @staticmethod
    def network_request(ctx: Any, run_id: str, agent_name: str, goal: str, start_ts: float):
        return build_network_request(
            run_id=run_id,
            agent_name=agent_name,
            goal=goal,
            method=getattr(ctx, "method", "GET"),
            url=getattr(ctx, "url", ""),
            request_body_bytes=getattr(ctx, "body_size", 0),
            call_id=getattr(ctx, "call_id", ""),
            start_ts=start_ts,
        )

    @staticmethod
    def network_response(ctx: Any, run_id: str, agent_name: str, goal: str, start_ts: float):
        return build_network_response(
            run_id=run_id,
            agent_name=agent_name,
            goal=goal,
            response_status=getattr(ctx, "status_code", 0),
            response_body_bytes=getattr(ctx, "body_size", 0),
            duration_ms=getattr(ctx, "duration_ms", 0),
            call_id=getattr(ctx, "call_id", ""),
            start_ts=start_ts,
        )

    @staticmethod
    def subprocess_exec(ctx: Any, run_id: str, agent_name: str, goal: str, start_ts: float):
        cmd = getattr(ctx, "command", [])
        return build_subprocess(
            run_id=run_id,
            agent_name=agent_name,
            goal=goal,
            command_tokens=json.dumps(cmd if isinstance(cmd, list) else [cmd]),
            exit_code=getattr(ctx, "exit_code", -1),
            stdout_preview=str(getattr(ctx, "stdout", ""))[:500],
            stderr_preview=str(getattr(ctx, "stderr", ""))[:500],
            duration_ms=getattr(ctx, "duration_ms", 0),
            workdir=getattr(ctx, "working_directory", ""),
            start_ts=start_ts,
        )

    @staticmethod
    def env_access(ctx: Any, run_id: str, agent_name: str, goal: str, start_ts: float):
        return build_env_access(
            run_id=run_id,
            agent_name=agent_name,
            goal=goal,
            env_var_name=getattr(ctx, "variable_name", ""),
            start_ts=start_ts,
        )
