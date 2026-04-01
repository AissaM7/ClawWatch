"""SQLite write layer — append-only event storage with Thread/Task/Exchange hierarchy."""

from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid as _uuid
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

# Default task inactivity timeout in seconds (30 minutes)
DEFAULT_TASK_TIMEOUT = 1800

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
    # hierarchy (Thread/Task/Exchange)
    "thread_id TEXT",
    "task_id TEXT",
    "exchange_id TEXT",
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
    "merge_group TEXT",
    "is_primary INTEGER DEFAULT 1",
]

# Run consolidation window — runs starting within this many seconds
# of an existing run are treated as the same user message.
MERGE_WINDOW_SECONDS = 3600  # 1 hour — safety net for long-running agents

THREADS_COLS = [
    "thread_id TEXT PRIMARY KEY",
    "channel TEXT NOT NULL",
    "agent_id TEXT NOT NULL",
    "user_id TEXT NOT NULL",
    "display_name TEXT DEFAULT NULL",
    "created_at REAL NOT NULL",
    "last_active_at REAL NOT NULL",
    "task_count INTEGER DEFAULT 0",
    "total_cost_usd REAL DEFAULT 0.0",
]

TASKS_COLS = [
    "task_id TEXT PRIMARY KEY",
    "thread_id TEXT NOT NULL",
    "run_id TEXT",
    "opened_at REAL NOT NULL",
    "closed_at REAL",
    "duration_ms INTEGER",
    "status TEXT DEFAULT 'active'",
    "opening_prompt TEXT",
    "exchange_count INTEGER DEFAULT 0",
    "llm_call_count INTEGER DEFAULT 0",
    "tool_call_count INTEGER DEFAULT 0",
    "error_count INTEGER DEFAULT 0",
    "total_cost_usd REAL DEFAULT 0.0",
    "goal_alignment_pct REAL",
    "highest_risk_score REAL",
]

EXCHANGES_COLS = [
    "exchange_id TEXT PRIMARY KEY",
    "task_id TEXT NOT NULL",
    "thread_id TEXT NOT NULL",
    "run_id TEXT",
    "exchange_index INTEGER NOT NULL",
    "opened_at REAL NOT NULL",
    "closed_at REAL",
    "duration_ms INTEGER",
    "user_message TEXT NOT NULL",
    "user_message_channel TEXT",
    "agent_response TEXT",
    "latency_ms INTEGER",
    "llm_call_count INTEGER DEFAULT 0",
    "tool_call_count INTEGER DEFAULT 0",
    "cost_usd REAL DEFAULT 0.0",
    "risk_score REAL",
    "goal_alignment_pct REAL",
]


SECURITY_EVENTS_COLS = [
    "id TEXT PRIMARY KEY",
    "run_id TEXT NOT NULL",
    "agent_id TEXT",
    "event_type TEXT NOT NULL",
    "severity TEXT NOT NULL",
    "label TEXT NOT NULL",
    "description TEXT NOT NULL",
    "raw_command TEXT",
    "file_path TEXT",
    "network_target TEXT",
    "detected_at REAL NOT NULL",
    "run_timestamp REAL",
    "acknowledged INTEGER DEFAULT 0",
    "chapter_id TEXT",
    "trace_event_index INTEGER",
    "is_false_positive INTEGER DEFAULT 0",
]

SECURITY_SKIP_LIST_COLS = [
    "id TEXT PRIMARY KEY",
    "pattern_hash TEXT UNIQUE NOT NULL",
    "event_type TEXT NOT NULL",
    "reason TEXT",
    "created_at REAL NOT NULL",
]


def _ensure_dirs() -> None:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)


def _init_index_db() -> sqlite3.Connection:
    _ensure_dirs()
    conn = sqlite3.connect(str(INDEX_DB), check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(f"CREATE TABLE IF NOT EXISTS runs ({', '.join(RUNS_COLS)})")
    conn.execute(f"CREATE TABLE IF NOT EXISTS threads ({', '.join(THREADS_COLS)})")
    conn.execute(f"CREATE TABLE IF NOT EXISTS tasks ({', '.join(TASKS_COLS)})")
    conn.execute(f"CREATE TABLE IF NOT EXISTS security_events ({', '.join(SECURITY_EVENTS_COLS)})")
    conn.execute(f"CREATE TABLE IF NOT EXISTS security_skip_list ({', '.join(SECURITY_SKIP_LIST_COLS)})")
    
    # Run migrations
    try:
        conn.execute("ALTER TABLE security_events ADD COLUMN is_false_positive INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        pass # Column already exists
    
    conn.commit()
    return conn


def _init_run_db(run_id: str) -> sqlite3.Connection:
    _ensure_dirs()
    db_path = RUNS_DIR / f"{run_id}.db"
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(f"CREATE TABLE IF NOT EXISTS events ({', '.join(EVENTS_COLS)})")
    conn.execute(f"CREATE TABLE IF NOT EXISTS exchanges ({', '.join(EXCHANGES_COLS)})")
    conn.commit()
    return conn


def _get_task_timeout() -> int:
    """Get task inactivity timeout in seconds from env or config."""
    env_val = os.environ.get("CLAWWATCH_TASK_TIMEOUT")
    if env_val:
        try:
            return int(env_val) * 60  # env is in minutes
        except ValueError:
            pass
    if CONFIG_FILE.exists():
        try:
            cfg = json.loads(CONFIG_FILE.read_text())
            return int(cfg.get("inactivity_timeout_minutes", 30)) * 60
        except Exception:
            pass
    return DEFAULT_TASK_TIMEOUT


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
        # Filter out: gateway runs, non-primary merge group members
        rows = conn.execute(
            "SELECT * FROM runs "
            "WHERE agent_name NOT LIKE '%gateway%' "
            "AND (is_primary = 1 OR is_primary IS NULL) "
            "ORDER BY started_at DESC"
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    @staticmethod
    def get_run_events(run_id: str) -> list[dict]:
        """Get events for a run, merging events from sibling runs in the same merge group."""
        all_events = []

        # Get primary run events
        db_path = RUNS_DIR / f"{run_id}.db"
        if db_path.exists():
            conn = sqlite3.connect(str(db_path), check_same_thread=False)
            conn.row_factory = sqlite3.Row
            rows = conn.execute("SELECT * FROM events ORDER BY wall_ts ASC, sequence_num ASC").fetchall()
            all_events.extend([dict(r) for r in rows])
            conn.close()

        # Find sibling runs in the same merge group
        if INDEX_DB.exists():
            idx = sqlite3.connect(str(INDEX_DB), check_same_thread=False)
            idx.row_factory = sqlite3.Row
            mg_row = idx.execute(
                "SELECT merge_group FROM runs WHERE run_id = ?", (run_id,)
            ).fetchone()
            if mg_row and mg_row["merge_group"]:
                siblings = idx.execute(
                    "SELECT run_id FROM runs WHERE merge_group = ? AND run_id != ?",
                    (mg_row["merge_group"], run_id),
                ).fetchall()
                for sib in siblings:
                    sib_path = RUNS_DIR / f"{sib['run_id']}.db"
                    if sib_path.exists():
                        sconn = sqlite3.connect(str(sib_path), check_same_thread=False)
                        sconn.row_factory = sqlite3.Row
                        srows = sconn.execute(
                            "SELECT * FROM events ORDER BY wall_ts ASC, sequence_num ASC"
                        ).fetchall()
                        all_events.extend([dict(r) for r in srows])
                        sconn.close()
            idx.close()

        # Sort by wall_ts then sequence_num for a unified chronological timeline
        all_events.sort(key=lambda e: (e.get('wall_ts', 0), e.get('sequence_num', 0)))
        return all_events

    @staticmethod
    def add_review_note(run_id: str, event_id: str, note: str) -> None:
        db_path = RUNS_DIR / f"{run_id}.db"
        if not db_path.exists():
            return
        conn = sqlite3.connect(str(db_path), check_same_thread=False)
        conn.execute(
            "INSERT INTO events (event_id, run_id, agent_name, goal, wall_ts, "
            "run_offset_ms, event_type, sequence_num, tool_result) "
            "VALUES (?, ?, '', '', ?, 0, 'review_note', "
            "(SELECT COALESCE(MAX(sequence_num),0)+1 FROM events), ?)",
            (str(_uuid.uuid4()), run_id, time.time(), json.dumps({"event_id": event_id, "note": note})),
        )
        conn.commit()
        conn.close()

    # ── Thread / Task / Exchange helpers ──────────────────────────

    @staticmethod
    def get_or_create_thread(conn: sqlite3.Connection, channel: str, agent_id: str, user_id: str) -> str:
        """Get existing thread or create a new one. Returns thread_id."""
        row = conn.execute(
            "SELECT thread_id FROM threads WHERE channel = ? AND agent_id = ? AND user_id = ?",
            (channel, agent_id, user_id),
        ).fetchone()
        if row:
            thread_id = row[0]
            conn.execute(
                "UPDATE threads SET last_active_at = ? WHERE thread_id = ?",
                (time.time(), thread_id),
            )
            return thread_id

        thread_id = str(_uuid.uuid4())
        now = time.time()
        conn.execute(
            "INSERT INTO threads (thread_id, channel, agent_id, user_id, created_at, last_active_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (thread_id, channel, agent_id, user_id, now, now),
        )
        return thread_id

    @staticmethod
    def get_active_task(conn: sqlite3.Connection, thread_id: str) -> Optional[dict]:
        """Get the currently active task for a thread, or None."""
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM tasks WHERE thread_id = ? AND status = 'active' "
            "ORDER BY opened_at DESC LIMIT 1",
            (thread_id,),
        ).fetchone()
        conn.row_factory = None
        return dict(row) if row else None

    @staticmethod
    def open_task(conn: sqlite3.Connection, thread_id: str, run_id: str,
                  opening_prompt: str) -> str:
        """Create a new task. Returns task_id."""
        task_id = str(_uuid.uuid4())
        now = time.time()
        conn.execute(
            "INSERT INTO tasks (task_id, thread_id, run_id, opened_at, status, "
            "opening_prompt, exchange_count) VALUES (?, ?, ?, ?, 'active', ?, 0)",
            (task_id, thread_id, run_id, now, opening_prompt),
        )
        conn.execute(
            "UPDATE threads SET task_count = task_count + 1, last_active_at = ? "
            "WHERE thread_id = ?",
            (now, thread_id),
        )
        return task_id

    @staticmethod
    def close_task(conn: sqlite3.Connection, task_id: str, status: str = "completed") -> None:
        """Close a task."""
        now = time.time()
        conn.execute(
            "UPDATE tasks SET closed_at = ?, status = ?, "
            "duration_ms = CAST((? - opened_at) * 1000 AS INTEGER) "
            "WHERE task_id = ?",
            (now, status, now, task_id),
        )

    @staticmethod
    def open_exchange(conn: sqlite3.Connection, run_conn: sqlite3.Connection,
                      task_id: str, thread_id: str, run_id: str,
                      user_message: str, channel: str) -> tuple[str, int]:
        """Create a new exchange. Returns (exchange_id, exchange_index)."""
        exchange_id = str(_uuid.uuid4())
        now = time.time()

        # Get the next exchange index
        row = conn.execute(
            "SELECT exchange_count FROM tasks WHERE task_id = ?", (task_id,)
        ).fetchone()
        exchange_index = (row[0] if row else 0) + 1

        # Insert into per-run database
        run_conn.execute(
            "INSERT INTO exchanges (exchange_id, task_id, thread_id, run_id, "
            "exchange_index, opened_at, user_message, user_message_channel) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (exchange_id, task_id, thread_id, run_id, exchange_index, now,
             user_message, channel),
        )
        run_conn.commit()

        # Update task exchange count
        conn.execute(
            "UPDATE tasks SET exchange_count = ? WHERE task_id = ?",
            (exchange_index, task_id),
        )

        return exchange_id, exchange_index

    @staticmethod
    def close_exchange(run_conn: sqlite3.Connection, exchange_id: str,
                       agent_response: Optional[str] = None) -> None:
        """Close an exchange with optional agent response."""
        now = time.time()
        run_conn.execute(
            "UPDATE exchanges SET closed_at = ?, agent_response = ?, "
            "duration_ms = CAST((? - opened_at) * 1000 AS INTEGER) "
            "WHERE exchange_id = ?",
            (now, agent_response, now, exchange_id),
        )
        run_conn.commit()

    @staticmethod
    def update_exchange_metrics(run_conn: sqlite3.Connection, exchange_id: str,
                                event_type: str) -> None:
        """Increment exchange-level counters based on event type."""
        if not exchange_id:
            return
        if event_type in ("llm_call_start", "llm_call_end"):
            run_conn.execute(
                "UPDATE exchanges SET llm_call_count = llm_call_count + 1 "
                "WHERE exchange_id = ?", (exchange_id,)
            )
        elif event_type in ("tool_call_start", "tool_call_end"):
            run_conn.execute(
                "UPDATE exchanges SET tool_call_count = tool_call_count + 1 "
                "WHERE exchange_id = ?", (exchange_id,)
            )

    @staticmethod
    def update_task_metrics(conn: sqlite3.Connection, task_id: str,
                            event_type: str) -> None:
        """Increment task-level counters based on event type."""
        if not task_id:
            return
        if event_type in ("llm_call_start",):
            conn.execute(
                "UPDATE tasks SET llm_call_count = llm_call_count + 1 "
                "WHERE task_id = ?", (task_id,)
            )
        elif event_type in ("tool_call_start",):
            conn.execute(
                "UPDATE tasks SET tool_call_count = tool_call_count + 1 "
                "WHERE task_id = ?", (task_id,)
            )
        elif event_type in ("agent_error", "tool_error"):
            conn.execute(
                "UPDATE tasks SET error_count = error_count + 1 "
                "WHERE task_id = ?", (task_id,)
            )

    # ── Thread/Task/Exchange query helpers ────────────────────────

    @staticmethod
    def list_agents() -> list[dict]:
        """List unique agents with aggregate stats."""
        if not INDEX_DB.exists():
            return []
        conn = sqlite3.connect(str(INDEX_DB), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        # Aggregate from threads table
        rows = conn.execute(
            "SELECT agent_id, "
            "COUNT(DISTINCT thread_id) as thread_count, "
            "SUM(task_count) as total_tasks, "
            "MAX(last_active_at) as last_active_at, "
            "SUM(total_cost_usd) as total_cost_usd "
            "FROM threads GROUP BY agent_id ORDER BY last_active_at DESC"
        ).fetchall()

        if not rows:
            # Fallback: derive agents from runs table.
            # Normalize 'telegram' agent_name to 'openclaw' since telegram
            # is just a channel adapter, not a separate agent.
            rows = conn.execute(
                "SELECT "
                "CASE WHEN agent_name = 'telegram' THEN 'openclaw' ELSE agent_name END as agent_id, "
                "1 as thread_count, "
                "COUNT(*) as total_tasks, "
                "MAX(started_at) as last_active_at, "
                "0 as total_cost_usd "
                "FROM runs WHERE agent_name NOT LIKE '%gateway%' "
                "GROUP BY agent_id ORDER BY last_active_at DESC"
            ).fetchall()

        conn.close()
        return [dict(r) for r in rows]

    @staticmethod
    def list_threads(agent_id: Optional[str] = None) -> list[dict]:
        """List threads, optionally filtered by agent."""
        if not INDEX_DB.exists():
            return []
        conn = sqlite3.connect(str(INDEX_DB), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        if agent_id:
            rows = conn.execute(
                "SELECT * FROM threads WHERE agent_id = ? ORDER BY last_active_at DESC",
                (agent_id,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM threads ORDER BY last_active_at DESC"
            ).fetchall()

        if not rows:
            # Fallback: derive synthetic threads from runs data.
            # Group runs by agent (normalizing 'telegram' to 'openclaw')
            # to create one thread per agent.
            agent_filter = ""
            params = []
            if agent_id:
                agent_filter = (
                    "AND (agent_name = ? OR (agent_name = 'telegram' AND ? = 'openclaw'))"
                )
                params = [agent_id, agent_id]

            query = (
                "SELECT "
                "CASE WHEN agent_name = 'telegram' THEN 'openclaw' ELSE agent_name END as agent_id, "
                "'thread-' || CASE WHEN agent_name = 'telegram' THEN 'openclaw' ELSE agent_name END as thread_id, "
                "'telegram' as channel, "
                "'unknown' as user_id, "
                "MIN(started_at) as created_at, "
                "MAX(COALESCE(ended_at, started_at)) as last_active_at, "
                "COUNT(*) as task_count, "
                "0.0 as total_cost_usd "
                f"FROM runs WHERE agent_name NOT LIKE '%gateway%' "
                f"AND (is_primary = 1 OR is_primary IS NULL) "
                f"{agent_filter} "
                "GROUP BY agent_id ORDER BY last_active_at DESC"
            )
            rows = conn.execute(query, params).fetchall()

        conn.close()
        results = [dict(r) for r in rows]
        # Ensure display_name is populated (fallback to channel name)
        for t in results:
            if not t.get('display_name'):
                ch = t.get('channel', 'agent')
                t['display_name'] = ch.capitalize() if ch else 'Agent'
        return results

    @staticmethod
    def rename_thread(thread_id: str, display_name: str) -> bool:
        """Rename a thread's display name. Returns True if successful."""
        if not INDEX_DB.exists():
            return False
        conn = sqlite3.connect(str(INDEX_DB), check_same_thread=False)
        try:
            # Try to add display_name column if it doesn't exist (migration)
            try:
                conn.execute("ALTER TABLE threads ADD COLUMN display_name TEXT DEFAULT NULL")
                conn.commit()
            except sqlite3.OperationalError:
                pass  # Column already exists
            conn.execute(
                "UPDATE threads SET display_name = ? WHERE thread_id = ?",
                (display_name, thread_id),
            )
            conn.commit()
            return conn.total_changes > 0
        finally:
            conn.close()

    @staticmethod
    def get_thread_tasks(thread_id: str) -> list[dict]:
        """Get all tasks for a thread."""
        if not INDEX_DB.exists():
            return []
        conn = sqlite3.connect(str(INDEX_DB), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM tasks WHERE thread_id = ? ORDER BY opened_at DESC",
            (thread_id,),
        ).fetchall()

        if not rows:
            # Fallback: derive synthetic tasks from runs data.
            # Synthetic thread IDs have format 'thread-{agent_name}'
            agent_name = None
            if thread_id.startswith("thread-"):
                agent_name = thread_id[7:]  # Remove 'thread-' prefix

            if agent_name:
                rows = conn.execute(
                    "SELECT "
                    "run_id as task_id, "
                    "? as thread_id, "
                    "run_id, "
                    "started_at as opened_at, "
                    "ended_at as closed_at, "
                    "CASE WHEN ended_at IS NOT NULL "
                    "  THEN CAST((ended_at - started_at) * 1000 AS INTEGER) "
                    "  ELSE NULL END as duration_ms, "
                    "CASE WHEN status = 'completed' THEN 'completed' "
                    "  WHEN status = 'error' THEN 'error' "
                    "  WHEN status = 'running' THEN 'active' "
                    "  ELSE 'active' END as status, "
                    "goal as opening_prompt, "
                    "event_count as exchange_count, "
                    "0 as llm_call_count, "
                    "0 as tool_call_count, "
                    "0 as error_count, "
                    "0.0 as total_cost_usd, "
                    "NULL as goal_alignment_pct, "
                    "NULL as highest_risk_score "
                    "FROM runs "
                    "WHERE (agent_name = ? OR (agent_name = 'telegram' AND ? = 'openclaw')) "
                    "AND agent_name NOT LIKE '%gateway%' "
                    "AND (is_primary = 1 OR is_primary IS NULL) "
                    "ORDER BY started_at DESC",
                    (thread_id, agent_name, agent_name),
                ).fetchall()

        conn.close()
        return [dict(r) for r in rows]

    @staticmethod
    def get_task(task_id: str) -> Optional[dict]:
        """Get a single task by ID."""
        if not INDEX_DB.exists():
            return None
        conn = sqlite3.connect(str(INDEX_DB), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM tasks WHERE task_id = ?", (task_id,)
        ).fetchone()
        conn.close()
        return dict(row) if row else None

    @staticmethod
    def get_task_exchanges(task_id: str) -> list[dict]:
        """Get all exchanges for a task (searches across run DBs)."""
        if not INDEX_DB.exists():
            return []
        conn = sqlite3.connect(str(INDEX_DB), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        task = conn.execute(
            "SELECT run_id FROM tasks WHERE task_id = ?", (task_id,)
        ).fetchone()
        conn.close()
        if not task or not task["run_id"]:
            return []

        run_id = task["run_id"]
        db_path = RUNS_DIR / f"{run_id}.db"
        if not db_path.exists():
            return []

        rconn = sqlite3.connect(str(db_path), check_same_thread=False)
        rconn.row_factory = sqlite3.Row
        rows = rconn.execute(
            "SELECT * FROM exchanges WHERE task_id = ? ORDER BY exchange_index ASC",
            (task_id,),
        ).fetchall()
        rconn.close()
        return [dict(r) for r in rows]

    @staticmethod
    def get_exchange_events(exchange_id: str, run_id: str) -> list[dict]:
        """Get all events for a specific exchange."""
        db_path = RUNS_DIR / f"{run_id}.db"
        if not db_path.exists():
            return []
        conn = sqlite3.connect(str(db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM events WHERE exchange_id = ? ORDER BY sequence_num ASC",
            (exchange_id,),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    # ── Main ingest pipeline ─────────────────────────────────────

    @staticmethod
    def ingest_event(data: dict) -> None:
        """Ingest an event from the external HTTP API (OpenClaw hook bridge).

        Auto-creates the run in index.db if it doesn't exist yet.
        Handles Thread/Task/Exchange hierarchy.
        """
        run_id = data.get("run_id", "")
        if not run_id:
            return

        agent_name = data.get("agent_name", "openclaw")

        # Normalize: 'telegram' is a channel adapter, not a separate agent.
        # Rewrite to 'openclaw' so all events go to the same agent.
        original_agent_name = agent_name
        if agent_name == "telegram":
            agent_name = "openclaw"
            data["agent_name"] = "openclaw"

        # Skip gateway events entirely
        if "gateway" in agent_name.lower():
            return

        _ensure_dirs()

        # Auto-create run in index if needed
        idx_conn = sqlite3.connect(str(INDEX_DB), check_same_thread=False)
        idx_conn.execute("PRAGMA journal_mode=WAL")
        idx_conn.execute(f"CREATE TABLE IF NOT EXISTS runs ({', '.join(RUNS_COLS)})")
        idx_conn.execute(f"CREATE TABLE IF NOT EXISTS threads ({', '.join(THREADS_COLS)})")
        idx_conn.execute(f"CREATE TABLE IF NOT EXISTS tasks ({', '.join(TASKS_COLS)})")

        event_type = data.get("event_type", "")

        # ── Run consolidation: merge temporally-adjacent runs ─────
        existing = idx_conn.execute(
            "SELECT run_id, merge_group FROM runs WHERE run_id = ?", (run_id,)
        ).fetchone()

        primary_run_id = run_id  # The run_id we'll actually write events to

        if not existing:
            # New run — check if there's a recent run we should merge with
            wall_ts = data.get("wall_ts", time.time())

            # For agent lifecycle-ending events, use a broader search:
            # find the most recent non-ended run regardless of time window.
            # Agent completion should ALWAYS be tied to an existing run.
            if event_type in ("agent_end", "agent_error", "agent_response"):
                recent = idx_conn.execute(
                    "SELECT run_id, merge_group, started_at FROM runs "
                    "WHERE agent_name NOT LIKE '%gateway%' "
                    "AND is_primary = 1 "
                    "AND (ended_at IS NULL OR status = 'running') "
                    "ORDER BY started_at DESC LIMIT 1",
                    (),
                ).fetchone()
            else:
                recent = idx_conn.execute(
                    "SELECT run_id, merge_group, started_at FROM runs "
                    "WHERE agent_name NOT LIKE '%gateway%' "
                    "AND is_primary = 1 "
                    "AND ABS(? - started_at) < ? "
                    "ORDER BY started_at DESC LIMIT 1",
                    (wall_ts, MERGE_WINDOW_SECONDS),
                ).fetchone()

            if recent:
                # Found a recent primary run — merge into it
                merge_group = recent[1] or recent[0]
                primary_run_id = recent[0]

                # Register this run as a non-primary member of the merge group
                db_path = str(RUNS_DIR / f"{run_id}.db")
                idx_conn.execute(
                    "INSERT OR IGNORE INTO runs "
                    "(run_id, agent_name, goal, started_at, db_path, merge_group, is_primary) "
                    "VALUES (?, ?, ?, ?, ?, ?, 0)",
                    (run_id, agent_name, data.get("goal", ""), wall_ts, db_path, merge_group),
                )
                # Ensure primary also has the merge_group set
                idx_conn.execute(
                    "UPDATE runs SET merge_group = ? WHERE run_id = ? AND merge_group IS NULL",
                    (merge_group, primary_run_id),
                )
            else:
                # No recent run — this is a new primary run
                db_path = str(RUNS_DIR / f"{run_id}.db")
                merge_group = run_id  # Use own run_id as merge group key
                idx_conn.execute(
                    "INSERT OR IGNORE INTO runs "
                    "(run_id, agent_name, goal, started_at, db_path, merge_group, is_primary) "
                    "VALUES (?, ?, ?, ?, ?, ?, 1)",
                    (run_id, agent_name, data.get("goal", ""), wall_ts, db_path, merge_group),
                )
        else:
            # Existing run — check if it has a primary redirect
            if existing[1]:  # has merge_group
                primary_row = idx_conn.execute(
                    "SELECT run_id FROM runs WHERE merge_group = ? AND is_primary = 1 LIMIT 1",
                    (existing[1],),
                ).fetchone()
                if primary_row:
                    primary_run_id = primary_row[0]

        # Update event count on the primary run
        idx_conn.execute(
            "UPDATE runs SET event_count = event_count + 1 WHERE run_id = ?",
            (primary_run_id,),
        )

        # Bug #3: Backfill goal from first user_prompt OR llm_call_start if goal is empty
        if event_type in ("user_prompt", "llm_call_start"):
            prompt_text = data.get("prompt_preview") or data.get("goal") or ""
            if prompt_text:
                idx_conn.execute(
                    "UPDATE runs SET goal = ? WHERE run_id = ? AND (goal IS NULL OR goal = '')",
                    (prompt_text[:200], primary_run_id),
                )

        # If this is an agent_end event, close the run
        if event_type == "agent_end":
            idx_conn.execute(
                "UPDATE runs SET ended_at = ?, status = ? WHERE run_id = ?",
                (data.get("wall_ts", time.time()), data.get("status", "completed"), primary_run_id),
            )

        # ── Thread / Task / Exchange hierarchy ────────────────────
        thread_id = None
        task_id = None
        exchange_id = None

        run_conn = _init_run_db(run_id)

        # ── Deduplication for user_prompt and agent_response ──────────
        # OpenClaw can emit duplicate hooks for these (e.g., message:received AND before_tool_call:user:telegram)
        if event_type in ("user_prompt", "agent_response"):
            try:
                content_sig = data.get("prompt_preview", "") if event_type == "user_prompt" else data.get("llm_output_full", "")
                content_sig = content_sig[:100]  # Just need a prefix to verify it's the same message
                
                # Check for same event_type within last 2 seconds
                recent_dup = run_conn.execute(
                    "SELECT 1 FROM events WHERE event_type = ? AND ABS(? - wall_ts) < 2 "
                    "AND (prompt_preview LIKE ? OR llm_output_full LIKE ?) LIMIT 1",
                    (event_type, wall_ts, f"{content_sig}%", f"{content_sig}%")
                ).fetchone()
                
                if recent_dup:
                    # It's a duplicate of an event we just processed, drop it
                    return
            except Exception:
                pass

        # Process user_prompt — this drives the hierarchy
        if event_type == "user_prompt":
            # Extract channel and user info from tool_args
            channel = "unknown"
            user_id = "unknown"
            try:
                args = json.loads(data.get("tool_args", "{}"))
                channel = args.get("channel", "unknown")
                user_id = args.get("user_id", "unknown")
            except (json.JSONDecodeError, TypeError):
                pass

            # Get or create thread
            thread_id = EventStore.get_or_create_thread(
                idx_conn, channel, agent_name, user_id
            )

            # Check for active task — apply boundary rules
            active_task = EventStore.get_active_task(idx_conn, thread_id)
            timeout = _get_task_timeout()
            prompt_text = data.get("prompt_preview") or data.get("goal") or ""

            if active_task:
                last_activity = active_task.get("opened_at", 0)
                # Check all exchanges for most recent activity
                try:
                    rconn_check = sqlite3.connect(
                        str(RUNS_DIR / f"{active_task.get('run_id', run_id)}.db"),
                        check_same_thread=False,
                    )
                    row = rconn_check.execute(
                        "SELECT MAX(opened_at) FROM exchanges WHERE task_id = ?",
                        (active_task["task_id"],),
                    ).fetchone()
                    if row and row[0]:
                        last_activity = max(last_activity, row[0])
                    rconn_check.close()
                except Exception:
                    pass

                elapsed = time.time() - last_activity

                if elapsed < timeout:
                    # Within timeout — add exchange to existing task
                    task_id = active_task["task_id"]
                    exchange_id, _ = EventStore.open_exchange(
                        idx_conn, run_conn, task_id, thread_id, run_id,
                        prompt_text, channel,
                    )
                else:
                    # Timeout elapsed — close old task, open new one
                    old_status = "completed" if active_task.get("exchange_count", 0) > 0 else "abandoned"
                    EventStore.close_task(idx_conn, active_task["task_id"], old_status)
                    task_id = EventStore.open_task(
                        idx_conn, thread_id, run_id, prompt_text
                    )
                    exchange_id, _ = EventStore.open_exchange(
                        idx_conn, run_conn, task_id, thread_id, run_id,
                        prompt_text, channel,
                    )
            else:
                # No active task — create new one
                task_id = EventStore.open_task(
                    idx_conn, thread_id, run_id, prompt_text
                )
                exchange_id, _ = EventStore.open_exchange(
                    idx_conn, run_conn, task_id, thread_id, run_id,
                    prompt_text, channel,
                )

        # For agent_response / message_sending — close current exchange
        elif event_type == "agent_response":
            response_text = data.get("llm_output_full", "")
            # Find the most recent open exchange for this run
            try:
                row = run_conn.execute(
                    "SELECT exchange_id, task_id, thread_id FROM exchanges "
                    "WHERE run_id = ? AND closed_at IS NULL "
                    "ORDER BY opened_at DESC LIMIT 1",
                    (run_id,),
                ).fetchone()
                if row:
                    exchange_id = row[0]
                    task_id = row[1]
                    thread_id = row[2]
                    EventStore.close_exchange(run_conn, exchange_id, response_text[:8192])
            except Exception:
                pass

        else:
            # For all other events, inherit the current exchange/task context
            try:
                row = run_conn.execute(
                    "SELECT exchange_id, task_id, thread_id FROM exchanges "
                    "WHERE run_id = ? ORDER BY opened_at DESC LIMIT 1",
                    (run_id,),
                ).fetchone()
                if row:
                    exchange_id = row[0]
                    task_id = row[1]
                    thread_id = row[2]
            except Exception:
                pass

        # Inject hierarchy IDs into event data
        data["thread_id"] = thread_id
        data["task_id"] = task_id
        data["exchange_id"] = exchange_id

        # Update metrics
        if task_id:
            EventStore.update_task_metrics(idx_conn, task_id, event_type)
        if exchange_id:
            EventStore.update_exchange_metrics(run_conn, exchange_id, event_type)

        idx_conn.commit()
        idx_conn.close()

        # Insert event into per-run database
        col_names_set = {c.split()[0] for c in EVENTS_COLS}
        filtered = {k: v for k, v in data.items() if k in col_names_set and v is not None}

        if not filtered.get("event_id"):
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

    # ── Security event methods ───────────────────────────────────

    @staticmethod
    def insert_security_event(event_dict: dict) -> None:
        """Insert a security event into index.db. Skips exact duplicates."""
        if not INDEX_DB.exists():
            _init_index_db()
        conn = sqlite3.connect(str(INDEX_DB), check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(f"CREATE TABLE IF NOT EXISTS security_events ({', '.join(SECURITY_EVENTS_COLS)})")

        # Dedup: same run_id + event_type + raw_command
        existing = conn.execute(
            "SELECT id FROM security_events WHERE run_id = ? AND event_type = ? AND raw_command = ?",
            (event_dict.get("run_id", ""), event_dict.get("event_type", ""),
             event_dict.get("raw_command", "")),
        ).fetchone()
        if existing:
            conn.close()
            return

        cols = [c.split()[0] for c in SECURITY_EVENTS_COLS]
        values = [event_dict.get(c) for c in cols]
        placeholders = ", ".join(["?"] * len(cols))
        col_names = ", ".join(cols)
        conn.execute(f"INSERT INTO security_events ({col_names}) VALUES ({placeholders})", values)
        conn.commit()
        conn.close()

    @staticmethod
    def get_security_events(severity: str = "", run_id: str = "",
                            acknowledged: str = "", agent_id: str = "",
                            limit: int = 50, offset: int = 0) -> list[dict]:
        """Query security events with optional filters."""
        if not INDEX_DB.exists():
            return []
        conn = sqlite3.connect(str(INDEX_DB), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute(f"CREATE TABLE IF NOT EXISTS security_events ({', '.join(SECURITY_EVENTS_COLS)})")

        conditions = []
        params: list = []
        if severity:
            conditions.append("severity = ?")
            params.append(severity)
        if run_id:
            conditions.append("run_id = ?")
            params.append(run_id)
        if acknowledged == "true":
            conditions.append("acknowledged = 1")
        elif acknowledged == "false":
            conditions.append("acknowledged = 0")
        if agent_id:
            conditions.append("agent_id = ?")
            params.append(agent_id)
            
        conditions.append("is_false_positive = 0")

        where = (" WHERE " + " AND ".join(conditions)) if conditions else ""

        # Sort: severity order then detected_at desc
        order = """ORDER BY
            CASE severity
                WHEN 'critical' THEN 0
                WHEN 'high' THEN 1
                WHEN 'medium' THEN 2
                WHEN 'low' THEN 3
            END ASC,
            detected_at DESC"""

        params.extend([limit, offset])
        rows = conn.execute(
            f"SELECT * FROM security_events{where} {order} LIMIT ? OFFSET ?",
            params,
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    @staticmethod
    def get_security_events_for_run(run_id: str) -> list[dict]:
        """Get all security events for a specific run, sorted by run_timestamp."""
        if not INDEX_DB.exists():
            return []
        conn = sqlite3.connect(str(INDEX_DB), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute(f"CREATE TABLE IF NOT EXISTS security_events ({', '.join(SECURITY_EVENTS_COLS)})")
        rows = conn.execute(
            "SELECT * FROM security_events WHERE run_id = ? AND is_false_positive = 0 "
            "ORDER BY run_timestamp ASC, detected_at ASC",
            (run_id,),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    @staticmethod
    def acknowledge_security_event(event_id: str) -> dict:
        """Set acknowledged = True. Returns updated event."""
        if not INDEX_DB.exists():
            return {}
        conn = sqlite3.connect(str(INDEX_DB), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute(f"CREATE TABLE IF NOT EXISTS security_events ({', '.join(SECURITY_EVENTS_COLS)})")
        conn.execute(
            "UPDATE security_events SET acknowledged = 1 WHERE id = ?",
            (event_id,),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM security_events WHERE id = ?", (event_id,)).fetchone()
        conn.close()
        return dict(row) if row else {}

    @staticmethod
    def get_security_stats() -> dict:
        """Aggregate security stats."""
        if not INDEX_DB.exists():
            return {
                "total_events": 0, "critical_count": 0, "high_count": 0,
                "medium_count": 0, "low_count": 0,
                "credential_access_count": 0, "destructive_ops_count": 0,
                "network_risk_count": 0, "subprocess_count": 0,
                "runs_affected": 0, "last_scan_at": None,
                "unscanned_runs_count": 0,
            }
        conn = sqlite3.connect(str(INDEX_DB), check_same_thread=False)
        conn.execute(f"CREATE TABLE IF NOT EXISTS security_events ({', '.join(SECURITY_EVENTS_COLS)})")

        stats = conn.execute("""
            SELECT
                COUNT(*) as total_events,
                SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical_count,
                SUM(CASE WHEN severity = 'high' THEN 1 ELSE 0 END) as high_count,
                SUM(CASE WHEN severity = 'medium' THEN 1 ELSE 0 END) as medium_count,
                SUM(CASE WHEN severity = 'low' THEN 1 ELSE 0 END) as low_count,
                SUM(CASE WHEN event_type = 'CREDENTIAL_ACCESS' THEN 1 ELSE 0 END) as credential_access_count,
                SUM(CASE WHEN event_type IN ('DESTRUCTIVE_FILE_OP', 'DATABASE_WIPE', 'MASS_DELETION') THEN 1 ELSE 0 END) as destructive_ops_count,
                SUM(CASE WHEN event_type IN ('SENSITIVE_DATA_EXFIL', 'PORT_SCAN_BEHAVIOR', 'EXTERNAL_DOWNLOAD', 'CONFIG_EXFIL') THEN 1 ELSE 0 END) as network_risk_count,
                SUM(CASE WHEN event_type IN ('SHELL_ESCALATION', 'PROCESS_INJECTION') THEN 1 ELSE 0 END) as subprocess_count,
                COUNT(DISTINCT run_id) as runs_affected,
                MAX(detected_at) as last_scan_at
            FROM security_events
            WHERE is_false_positive = 0
        """).fetchone()

        result = {
            "total_events": stats[0] or 0,
            "critical_count": stats[1] or 0,
            "high_count": stats[2] or 0,
            "medium_count": stats[3] or 0,
            "low_count": stats[4] or 0,
            "credential_access_count": stats[5] or 0,
            "destructive_ops_count": stats[6] or 0,
            "network_risk_count": stats[7] or 0,
            "subprocess_count": stats[8] or 0,
            "runs_affected": stats[9] or 0,
            "last_scan_at": stats[10],
        }

        # Count unscanned runs
        scanned_run_ids = conn.execute(
            "SELECT DISTINCT run_id FROM security_events"
        ).fetchall()
        scanned = {r[0] for r in scanned_run_ids}

        all_runs = conn.execute(
            "SELECT run_id FROM runs WHERE agent_name NOT LIKE '%gateway%' "
            "AND (is_primary = 1 OR is_primary IS NULL)"
        ).fetchall()
        total_runs = {r[0] for r in all_runs}
        result["unscanned_runs_count"] = len(total_runs - scanned)

        conn.close()
        return result

    @staticmethod
    def get_unscanned_run_ids() -> list[str]:
        """Get run IDs that haven't been scanned yet."""
        if not INDEX_DB.exists():
            return []
        conn = sqlite3.connect(str(INDEX_DB), check_same_thread=False)
        conn.execute(f"CREATE TABLE IF NOT EXISTS security_events ({', '.join(SECURITY_EVENTS_COLS)})")

        scanned = conn.execute(
            "SELECT DISTINCT run_id FROM security_events"
        ).fetchall()
        scanned_ids = {r[0] for r in scanned}

        all_runs = conn.execute(
            "SELECT run_id FROM runs WHERE agent_name NOT LIKE '%gateway%' "
            "AND (is_primary = 1 OR is_primary IS NULL)"
        ).fetchall()
        total_runs = {r[0] for r in all_runs}
        conn.close()
        return list(total_runs - scanned_ids)

    @staticmethod
    def add_to_skip_list(pattern_hash: str, event_type: str, reason: str = "") -> None:
        """Add a pattern hash to the avoid list."""
        if not INDEX_DB.exists():
            return
        conn = sqlite3.connect(str(INDEX_DB), check_same_thread=False)
        conn.execute(f"CREATE TABLE IF NOT EXISTS security_skip_list ({', '.join(SECURITY_SKIP_LIST_COLS)})")
        try:
            conn.execute(
                "INSERT INTO security_skip_list (id, pattern_hash, event_type, reason, created_at) VALUES (?, ?, ?, ?, ?)",
                (str(_uuid.uuid4()), pattern_hash, event_type, reason, time.time())
            )
            conn.commit()
        except sqlite3.IntegrityError:
            pass # Already exists
        finally:
            conn.close()

    @staticmethod
    def is_in_skip_list(pattern_hash: str, event_type: str) -> bool:
        """Check if a pattern hash is in the skip list for this event type."""
        if not INDEX_DB.exists():
            return False
        conn = sqlite3.connect(str(INDEX_DB), check_same_thread=False)
        try:
            row = conn.execute(
                "SELECT 1 FROM security_skip_list WHERE pattern_hash = ? AND event_type = ?",
                (pattern_hash, event_type)
            ).fetchone()
            return bool(row)
        except sqlite3.OperationalError:
            return False # Table might not exist yet
        finally:
            conn.close()
        return False

    @staticmethod
    def mark_events_false_positive(pattern_hash: str, event_type: str) -> None:
        """Update existing matching unacknowledged events to be false positives."""
        import hashlib
        if not INDEX_DB.exists():
            return
        conn = sqlite3.connect(str(INDEX_DB), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            candidates = conn.execute(
                "SELECT id, raw_command, network_target FROM security_events "
                "WHERE event_type = ? AND is_false_positive = 0 AND acknowledged = 0",
                (event_type,)
            ).fetchall()
            
            to_update = []
            for row in candidates:
                val = row["network_target"] if row["network_target"] else (row["raw_command"] or "")
                h = hashlib.sha256(val.encode("utf-8")).hexdigest()
                if h == pattern_hash:
                    to_update.append((row["id"],))
            
            if to_update:
                conn.executemany("UPDATE security_events SET is_false_positive = 1 WHERE id = ?", to_update)
                conn.commit()
        except sqlite3.OperationalError:
            pass # Table might not exist yet
        finally:
            conn.close()

