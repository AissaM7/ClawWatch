"""ClawEvent dataclass and builder functions."""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field, asdict
from typing import Any, Optional


# All recognised event types
EVENT_TYPES = [
    "agent_start", "agent_end", "agent_error", "agent_response",
    "tool_call_start", "tool_call_end", "tool_error",
    "llm_call_start", "llm_call_end", "llm_error",
    "file_read", "file_write", "file_delete",
    "network_request", "network_response",
    "subprocess_exec", "env_access",
    "loop_detected", "user_prompt",
]


@dataclass
class ClawEvent:
    """Every event recorded by ClawWatch."""

    # ── Base fields (always present) ──────────────────────────────
    event_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    run_id: str = ""
    agent_name: str = ""
    goal: str = ""
    wall_ts: float = field(default_factory=time.time)
    run_offset_ms: int = 0
    event_type: str = ""
    sequence_num: int = 0

    # ── Tool call payload ─────────────────────────────────────────
    tool_name: Optional[str] = None
    tool_args: Optional[str] = None        # JSON string, max 2 KB per arg
    tool_result: Optional[str] = None      # JSON string, max 4 KB
    call_id: Optional[str] = None
    duration_ms: Optional[int] = None
    error_type: Optional[str] = None
    error_message: Optional[str] = None
    error_traceback: Optional[str] = None

    # ── LLM call payload ──────────────────────────────────────────
    model: Optional[str] = None
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    prompt_preview: Optional[str] = None   # first 200 chars
    llm_output_full: Optional[str] = None  # up to 8 KB for hallucination detection

    # ── File operation payload ────────────────────────────────────
    file_path: Optional[str] = None
    file_size_bytes: Optional[int] = None
    is_new_file: Optional[bool] = None
    is_inside_workdir: Optional[bool] = None

    # ── Network payload ───────────────────────────────────────────
    url: Optional[str] = None
    method: Optional[str] = None
    request_body_bytes: Optional[int] = None
    response_status: Optional[int] = None
    response_body_bytes: Optional[int] = None

    # ── Subprocess payload ────────────────────────────────────────
    command_tokens: Optional[str] = None   # JSON list of strings
    exit_code: Optional[int] = None
    stdout_preview: Optional[str] = None   # first 500 chars
    stderr_preview: Optional[str] = None   # first 500 chars

    # ── Env access ────────────────────────────────────────────────
    env_var_name: Optional[str] = None

    # ── Loop detection ────────────────────────────────────────────
    arg_hash: Optional[str] = None
    repeat_count: Optional[int] = None

    # ── Agent lifecycle extras ────────────────────────────────────
    status: Optional[str] = None           # for agent_end
    tools_list: Optional[str] = None       # JSON list for agent_start
    workdir: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        """Serialise to dict, dropping None values."""
        return {k: v for k, v in asdict(self).items() if v is not None}


# ── Builder helpers ───────────────────────────────────────────────

def _base(run_id: str, agent_name: str, goal: str,
          event_type: str, start_ts: float) -> dict[str, Any]:
    now = time.time()
    return dict(
        run_id=run_id,
        agent_name=agent_name,
        goal=goal,
        event_type=event_type,
        wall_ts=now,
        run_offset_ms=int((now - start_ts) * 1000),
    )


def build_agent_start(run_id: str, agent_name: str, goal: str,
                       workdir: str, tools: list[str],
                       start_ts: float) -> ClawEvent:
    import json
    return ClawEvent(
        **_base(run_id, agent_name, goal, "agent_start", start_ts),
        workdir=workdir,
        tools_list=json.dumps(tools),
    )


def build_agent_end(run_id: str, agent_name: str, goal: str,
                     status: str, start_ts: float,
                     error_message: str | None = None) -> ClawEvent:
    return ClawEvent(
        **_base(run_id, agent_name, goal, "agent_end", start_ts),
        status=status,
        error_message=error_message,
    )


def build_tool_call_start(run_id: str, agent_name: str, goal: str,
                           tool_name: str, tool_args: str,
                           call_id: str, start_ts: float) -> ClawEvent:
    return ClawEvent(
        **_base(run_id, agent_name, goal, "tool_call_start", start_ts),
        tool_name=tool_name,
        tool_args=tool_args[:2048],
        call_id=call_id,
    )


def build_tool_call_end(run_id: str, agent_name: str, goal: str,
                         tool_name: str, tool_result: str,
                         call_id: str, duration_ms: int,
                         start_ts: float) -> ClawEvent:
    return ClawEvent(
        **_base(run_id, agent_name, goal, "tool_call_end", start_ts),
        tool_name=tool_name,
        tool_result=tool_result[:4096],
        call_id=call_id,
        duration_ms=duration_ms,
    )


def build_tool_error(run_id: str, agent_name: str, goal: str,
                      tool_name: str, error_type: str,
                      error_message: str, error_traceback: str,
                      call_id: str, start_ts: float) -> ClawEvent:
    return ClawEvent(
        **_base(run_id, agent_name, goal, "tool_error", start_ts),
        tool_name=tool_name,
        error_type=error_type,
        error_message=error_message,
        error_traceback=error_traceback,
        call_id=call_id,
    )


def build_llm_call_start(run_id: str, agent_name: str, goal: str,
                           model: str, input_tokens: int,
                           prompt_preview: str,
                           call_id: str, start_ts: float) -> ClawEvent:
    return ClawEvent(
        **_base(run_id, agent_name, goal, "llm_call_start", start_ts),
        model=model,
        input_tokens=input_tokens,
        prompt_preview=prompt_preview[:200],
        call_id=call_id,
    )


def build_llm_call_end(run_id: str, agent_name: str, goal: str,
                         model: str, input_tokens: int,
                         output_tokens: int, duration_ms: int,
                         call_id: str, llm_output_full: str,
                         start_ts: float) -> ClawEvent:
    return ClawEvent(
        **_base(run_id, agent_name, goal, "llm_call_end", start_ts),
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        duration_ms=duration_ms,
        call_id=call_id,
        llm_output_full=llm_output_full[:8192],
    )


def build_llm_error(run_id: str, agent_name: str, goal: str,
                      model: str, error_type: str,
                      error_message: str, start_ts: float,
                      response_status: int | None = None) -> ClawEvent:
    return ClawEvent(
        **_base(run_id, agent_name, goal, "llm_error", start_ts),
        model=model,
        error_type=error_type,
        error_message=error_message,
        response_status=response_status,
    )


def build_file_event(run_id: str, agent_name: str, goal: str,
                      event_type: str, file_path: str,
                      file_size_bytes: int, is_inside_workdir: bool,
                      start_ts: float,
                      is_new_file: bool | None = None) -> ClawEvent:
    return ClawEvent(
        **_base(run_id, agent_name, goal, event_type, start_ts),
        file_path=file_path,
        file_size_bytes=file_size_bytes,
        is_inside_workdir=is_inside_workdir,
        is_new_file=is_new_file,
    )


def build_network_request(run_id: str, agent_name: str, goal: str,
                            method: str, url: str,
                            request_body_bytes: int,
                            call_id: str, start_ts: float) -> ClawEvent:
    return ClawEvent(
        **_base(run_id, agent_name, goal, "network_request", start_ts),
        method=method,
        url=url,
        request_body_bytes=request_body_bytes,
        call_id=call_id,
    )


def build_network_response(run_id: str, agent_name: str, goal: str,
                             response_status: int,
                             response_body_bytes: int,
                             duration_ms: int,
                             call_id: str, start_ts: float) -> ClawEvent:
    return ClawEvent(
        **_base(run_id, agent_name, goal, "network_response", start_ts),
        response_status=response_status,
        response_body_bytes=response_body_bytes,
        duration_ms=duration_ms,
        call_id=call_id,
    )


def build_subprocess(run_id: str, agent_name: str, goal: str,
                      command_tokens: str, exit_code: int,
                      stdout_preview: str, stderr_preview: str,
                      duration_ms: int, workdir: str,
                      start_ts: float) -> ClawEvent:
    return ClawEvent(
        **_base(run_id, agent_name, goal, "subprocess_exec", start_ts),
        command_tokens=command_tokens,
        exit_code=exit_code,
        stdout_preview=stdout_preview[:500],
        stderr_preview=stderr_preview[:500],
        duration_ms=duration_ms,
        workdir=workdir,
    )


def build_env_access(run_id: str, agent_name: str, goal: str,
                      env_var_name: str, start_ts: float) -> ClawEvent:
    return ClawEvent(
        **_base(run_id, agent_name, goal, "env_access", start_ts),
        env_var_name=env_var_name,
    )


def build_loop_detected(run_id: str, agent_name: str, goal: str,
                          tool_name: str, arg_hash: str,
                          repeat_count: int,
                          start_ts: float) -> ClawEvent:
    return ClawEvent(
        **_base(run_id, agent_name, goal, "loop_detected", start_ts),
        tool_name=tool_name,
        arg_hash=arg_hash,
        repeat_count=repeat_count,
    )
