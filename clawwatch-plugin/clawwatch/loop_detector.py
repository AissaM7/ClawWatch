"""Rolling-window loop detection for tool calls."""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from typing import Optional


class LoopDetector:
    """Detects when the same tool is called with identical arguments repeatedly."""

    def __init__(self, threshold: int = 5) -> None:
        self._threshold = threshold
        # tool_name -> {arg_hash: consecutive_count}
        self._counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        self._last_key: Optional[str] = None

    def record_call(self, tool_name: str, tool_args: str) -> Optional[tuple[str, int]]:
        """Record a tool call. Returns (arg_hash, count) if loop threshold is reached."""
        arg_hash = hashlib.md5(
            json.dumps({"tool": tool_name, "args": tool_args}, sort_keys=True).encode()
        ).hexdigest()

        key = f"{tool_name}:{arg_hash}"

        # If same key as last call, increment; else reset this key
        if key == self._last_key:
            self._counts[tool_name][arg_hash] += 1
        else:
            self._counts[tool_name][arg_hash] = 1

        self._last_key = key
        count = self._counts[tool_name][arg_hash]

        if count >= self._threshold:
            return arg_hash, count

        return None
