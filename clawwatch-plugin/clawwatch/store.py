"""SQLite write layer — append-only event storage."""

from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path
from typing import Optional

from clawwatch.event import ClawEvent


def _resolve_base_dir() -> Path:
    """Return the base storage directory, respecting CLAWWATCH_DIR."""
    override = os.environ.get("CLAWWATCH_DIR")
    if override:
        return Path(override)
    return Path.home() / ".clawwatch"


BASE_DIR = _resolve_base_dir()
RUNS_DIR = BASE_DIR / "runs"
INDEX_DB = BASE_DIR / "index.db"
LOG_FILE = BASE_DIR / "plugin.log"
CONFIG_FILE = BASE_DIR / "config.json"

# ── Column definitions for the events table ──────────────────────

EVENTS_COLS = [
    # base
    "event_id TEXT PRIMARY KEY",
    "run_id TEXT NOT NULL",
    "agent_name TEXT NOT NULL",
    "goal TEXT NOT NULL",
    "wall_ts REAL NOT NULL",
    "run_offset_ms INTEGER NOT NULL",
    "event_type TEXT NOT NULL",
    "sequence_num INTEGER NOT NULL",
    # tool
    "tool_name TEXT",
    "tool_args TEXT",
    "tool_result TEXT",
    "call_id TEXT",
    "duration_ms INTEGER",
    "error_type TEXT",
    "error_message TEXT",
    "error_traceback TEXT",
    # llm
    "model TEXT",
    "input_tokens INTEGER",
    "output_tokens INTEGER",
    "prompt_preview TEXT",
    "llm_output_full TEXT",
    # file
    "file_path TEXT",
    "file_size_bytes INTEGER",
    "is_new_file INTEGER",
    "is_inside_workdir INTEGER",
    # network
    "url TEXT",
    "method TEXT",
    "request_body_bytes INTEGER",
    "response_status INTEGER",
    "response_body_bytes INTEGER",
    # subprocess
    "command_tokens TEXT",
    "exit_code INTEGER",
    "stdout_preview TEXT",
    "stderr_preview TEXT",
    # env
    "env_var_name TEXT",
    # loop
    "arg_hash TEXT",
    "repeat_count INTEGER",
    # agent extras
    "status TEXT",
    "tools_list TEXT",
    "workdir TEXT",
]

RUNS_COLS = [
    "run_id TEXT PRIMARY KEY",
    "agent_name TEXT NOT NULL",
    "goal TEXT NOT NULL",
    "started_at REAL NOT NULL",
    "ended_at REAL",
    "status TEXT DEFAULT 'running'",
    "event_count INTEGER DEFAULT 0",
    "db_path TEXT NOT NULL",
]


def _ensure_dirs() -> None:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)


def _init_index_db() -> sqlite3.Connection:
    _ensure_dirs()
    conn = sqlite3.connect(str(INDEX_DB), check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(f"CREATE TABLE IF NOT EXISTS runs ({', '.join(RUNS_COLS)})")
    conn.commit()
    return conn


def _init_run_db(run_id: str) -> sqlite3.Connection:
    _ensure_dirs()
    db_path = RUNS_DIR / f"{run_id}.db"
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(f"CREATE TABLE IF NOT EXISTS events ({', '.join(EVENTS_COLS)})")
    conn.commit()
    return conn


class EventStore:
    """Manages per-run SQLite databases and the index."""

    def __init__(self) -> None:
        self._index_conn: Optional[sqlite3.Connection] = None
        self._run_conn: Optional[sqlite3.Connection] = None
        self._run_id: Optional[str] = None
        self._seq: int = 0

    # ── Run lifecycle ─────────────────────────────────────────────

    def open_run(self, run_id: str, agent_name: str, goal: str) -> None:
        self._index_conn = _init_index_db()
        self._run_conn = _init_run_db(run_id)
        self._run_id = run_id
        self._seq = 0

        db_path = str(RUNS_DIR / f"{run_id}.db")
        self._index_conn.execute(
            "INSERT OR REPLACE INTO runs (run_id, agent_name, goal, started_at, db_path) "
            "VALUES (?, ?, ?, ?, ?)",
            (run_id, agent_name, goal, time.time(), db_path),
        )
        self._index_conn.commit()

        # Run retention cleanup in background
        self._cleanup_old_runs()

    def close_run(self, status: str = "completed") -> None:
        if self._index_conn and self._run_id:
            self._index_conn.execute(
                "UPDATE runs SET ended_at = ?, status = ?, event_count = ? WHERE run_id = ?",
                (time.time(), status, self._seq, self._run_id),
            )
            self._index_conn.commit()

    # ── Event insertion ───────────────────────────────────────────

    def append(self, event: ClawEvent) -> ClawEvent:
        """Append an event to the run database. Returns the event with sequence_num set."""
        if not self._run_conn:
            return event

        self._seq += 1
        event.sequence_num = self._seq

        d = event.to_dict()
        cols = list(d.keys())
        placeholders = ", ".join(["?"] * len(cols))
        col_names = ", ".join(cols)
        values = [d[c] for c in cols]

        self._run_conn.execute(
            f"INSERT INTO events ({col_names}) VALUES ({placeholders})", values
        )
        self._run_conn.commit()

        # Update event count in index
        if self._index_conn and self._run_id:
            self._index_conn.execute(
                "UPDATE runs SET event_count = ? WHERE run_id = ?",
                (self._seq, self._run_id),
            )
            self._index_conn.commit()

        return event

    # ── Query helpers (for the REST API) ──────────────────────────

    @staticmethod
    def list_runs() -> list[dict]:
        if not INDEX_DB.exists():
            return []
        conn = sqlite3.connect(str(INDEX_DB), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM runs ORDER BY started_at DESC"
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    @staticmethod
    def get_run_events(run_id: str) -> list[dict]:
        db_path = RUNS_DIR / f"{run_id}.db"
        if not db_path.exists():
            return []
        conn = sqlite3.connect(str(db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM events ORDER BY sequence_num ASC"
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    @staticmethod
    def add_review_note(run_id: str, event_id: str, note: str) -> None:
        db_path = RUNS_DIR / f"{run_id}.db"
        if not db_path.exists():
            return
        conn = sqlite3.connect(str(db_path), check_same_thread=False)
        import uuid as _uuid
        conn.execute(
            "INSERT INTO events (event_id, run_id, agent_name, goal, wall_ts, "
            "run_offset_ms, event_type, sequence_num, tool_result) "
            "VALUES (?, ?, '', '', ?, 0, 'review_note', "
            "(SELECT COALESCE(MAX(sequence_num),0)+1 FROM events), ?)",
            (str(_uuid.uuid4()), run_id, time.time(), json.dumps({"event_id": event_id, "note": note})),
        )
        conn.commit()
        conn.close()

    @staticmethod
    def ingest_event(data: dict) -> None:
        """Ingest an event from the external HTTP API (OpenClaw hook bridge).

        Auto-creates the run in index.db if it doesn't exist yet.
        """
        run_id = data.get("run_id", "")
        if not run_id:
            return

        _ensure_dirs()

        # Auto-create run in index if needed
        idx_conn = sqlite3.connect(str(INDEX_DB), check_same_thread=False)
        idx_conn.execute("PRAGMA journal_mode=WAL")
        idx_conn.execute(f"CREATE TABLE IF NOT EXISTS runs ({', '.join(RUNS_COLS)})")

        existing = idx_conn.execute(
            "SELECT run_id FROM runs WHERE run_id = ?", (run_id,)
        ).fetchone()

        if not existing:
            db_path = str(RUNS_DIR / f"{run_id}.db")
            idx_conn.execute(
                "INSERT INTO runs (run_id, agent_name, goal, started_at, db_path) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    run_id,
                    data.get("agent_name", "openclaw"),
                    data.get("goal", ""),
                    data.get("wall_ts", time.time()),
                    db_path,
                ),
            )

        # Update event count
        idx_conn.execute(
            "UPDATE runs SET event_count = event_count + 1 WHERE run_id = ?",
            (run_id,),
        )

        # If this is an agent_end event, close the run
        if data.get("event_type") == "agent_end":
            idx_conn.execute(
                "UPDATE runs SET ended_at = ?, status = ? WHERE run_id = ?",
                (data.get("wall_ts", time.time()), data.get("status", "completed"), run_id),
            )

        idx_conn.commit()
        idx_conn.close()

        # Insert event into per-run database
        run_conn = _init_run_db(run_id)

        # Extract only known columns
        col_names_set = {c.split()[0] for c in EVENTS_COLS}
        filtered = {k: v for k, v in data.items() if k in col_names_set and v is not None}

        if not filtered.get("event_id"):
            import uuid as _uuid
            filtered["event_id"] = str(_uuid.uuid4())

        cols = list(filtered.keys())
        placeholders = ", ".join(["?"] * len(cols))
        col_str = ", ".join(cols)
        values = [filtered[c] for c in cols]

        run_conn.execute(
            f"INSERT OR IGNORE INTO events ({col_str}) VALUES ({placeholders})",
            values,
        )
        run_conn.commit()
        run_conn.close()

    # ── Retention ─────────────────────────────────────────────────

    def _cleanup_old_runs(self) -> None:
        try:
            config = self._load_config()
            retention_days = config.get("retention_days", 30)
            pinned = set(config.get("pinned_runs", []))
            cutoff = time.time() - (retention_days * 86400)

            if not self._index_conn:
                return

            rows = self._index_conn.execute(
                "SELECT run_id, db_path FROM runs WHERE started_at < ?", (cutoff,)
            ).fetchall()

            for run_id, db_path in rows:
                if run_id in pinned:
                    continue
                try:
                    if db_path and os.path.exists(db_path):
                        os.remove(db_path)
                    self._index_conn.execute(
                        "DELETE FROM runs WHERE run_id = ?", (run_id,)
                    )
                except Exception:
                    pass

            self._index_conn.commit()
        except Exception:
            pass  # retention cleanup is best-effort

    @staticmethod
    def _load_config() -> dict:
        if CONFIG_FILE.exists():
            try:
                return json.loads(CONFIG_FILE.read_text())
            except Exception:
                pass
        return {}
