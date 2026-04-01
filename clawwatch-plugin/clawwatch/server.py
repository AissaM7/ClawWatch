"""Local HTTP + SSE server — stdlib only, runs in a background thread."""

from __future__ import annotations

import json
import queue
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from typing import Any

from clawwatch.store import EventStore


class _SSEBroadcaster:
    """Fan-out queue for SSE clients."""

    def __init__(self) -> None:
        self._clients: list[queue.Queue[str]] = []
        self._lock = threading.Lock()

    def add_client(self) -> queue.Queue[str]:
        q: queue.Queue[str] = queue.Queue(maxsize=1000)
        with self._lock:
            self._clients.append(q)
        return q

    def remove_client(self, q: queue.Queue[str]) -> None:
        with self._lock:
            try:
                self._clients.remove(q)
            except ValueError:
                pass

    def broadcast(self, data: str) -> None:
        with self._lock:
            dead: list[queue.Queue[str]] = []
            for q in self._clients:
                try:
                    q.put_nowait(data)
                except queue.Full:
                    dead.append(q)
            for q in dead:
                self._clients.remove(q)


# Module-level broadcaster so the plugin can push events
broadcaster = _SSEBroadcaster()


def _make_handler(store_cls: type = EventStore):
    """Create a request handler class with access to the broadcaster."""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # noqa: N802
            pass  # silence request logs

        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(200)
            self._cors()
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            path = self.path.split("?")[0]

            # Normalize: /api/runs -> /api/v1/runs (backward compat)
            if path.startswith("/api/") and not path.startswith("/api/v1/"):
                path = "/api/v1/" + path[len("/api/"):]

            if path == "/health":
                self._json_response({"status": "ok", "ts": time.time()})

            elif path == "/api/v1/runs":
                runs = store_cls.list_runs()
                self._json_response(runs)

            elif path.startswith("/api/v1/runs/") and path.count("/") == 4:
                run_id = path.split("/")[4]
                events = store_cls.get_run_events(run_id)
                self._json_response(events)

            elif path == "/api/v1/agents":
                agents = store_cls.list_agents()
                self._json_response(agents)

            elif path == "/api/v1/threads":
                # Parse query param ?agent_id=...
                qs = self.path.split("?")[1] if "?" in self.path else ""
                agent_id = None
                for param in qs.split("&"):
                    if param.startswith("agent_id="):
                        agent_id = param.split("=", 1)[1]
                threads = store_cls.list_threads(agent_id)
                self._json_response(threads)

            elif path.startswith("/api/v1/threads/") and path.endswith("/tasks"):
                thread_id = path.split("/")[4]
                tasks = store_cls.get_thread_tasks(thread_id)
                self._json_response(tasks)

            elif path.startswith("/api/v1/threads/") and path.count("/") == 4:
                thread_id = path.split("/")[4]
                # Return thread detail with its tasks
                tasks = store_cls.get_thread_tasks(thread_id)
                self._json_response({"thread_id": thread_id, "tasks": tasks})

            elif path.startswith("/api/v1/tasks/") and path.endswith("/exchanges"):
                task_id = path.split("/")[4]
                exchanges = store_cls.get_task_exchanges(task_id)
                self._json_response(exchanges)

            elif path.startswith("/api/v1/tasks/") and path.count("/") == 4:
                task_id = path.split("/")[4]
                task = store_cls.get_task(task_id)
                self._json_response(task or {})

            elif path.startswith("/api/v1/exchanges/") and path.endswith("/events"):
                parts = path.split("/")
                exchange_id = parts[4]
                # Need run_id from query params
                qs = self.path.split("?")[1] if "?" in self.path else ""
                run_id = ""
                for param in qs.split("&"):
                    if param.startswith("run_id="):
                        run_id = param.split("=", 1)[1]
                events = store_cls.get_exchange_events(exchange_id, run_id)
                self._json_response(events)

            # ── Security routes ────────────────────────────────
            elif path == "/api/v1/security/events":
                qs = self.path.split("?")[1] if "?" in self.path else ""
                params: dict[str, str] = {}
                for param in qs.split("&"):
                    if "=" in param:
                        k, v = param.split("=", 1)
                        params[k] = v
                events = store_cls.get_security_events(
                    severity=params.get("severity", ""),
                    run_id=params.get("run_id", ""),
                    acknowledged=params.get("acknowledged", ""),
                    agent_id=params.get("agent_id", ""),
                    limit=int(params.get("limit", "200")),
                    offset=int(params.get("offset", "0")),
                )
                self._json_response(events)

            elif path.startswith("/api/v1/security/events/run/"):
                run_id = path.split("/")[-1]
                events = store_cls.get_security_events_for_run(run_id)
                self._json_response(events)

            elif path == "/api/v1/security/stats":
                stats = store_cls.get_security_stats()
                self._json_response(stats)

            elif path == "/api/v1/events/stream":
                self._handle_sse()

            else:
                self._serve_static(self.path.split("?")[0])

        def do_POST(self) -> None:  # noqa: N802
            path = self.path.split("?")[0]

            # Normalize: /api/ -> /api/v1/
            if path.startswith("/api/") and not path.startswith("/api/v1/"):
                path = "/api/v1/" + path[len("/api/"):]

            if path == "/api/v1/ingest":
                length = int(self.headers.get("Content-Length", 0))
                if length:
                    try:
                        body = json.loads(self.rfile.read(length))
                        store_cls.ingest_event(body)
                        # Broadcast to SSE clients
                        broadcaster.broadcast(json.dumps(body, default=str))
                    except Exception:
                        import traceback
                        traceback.print_exc()
                self._json_response({"ok": True})
                return

            if path.startswith("/api/v1/runs/") and path.endswith("/review"):
                parts = path.split("/")
                if len(parts) >= 5:
                    run_id = parts[4]
                    length = int(self.headers.get("Content-Length", 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    event_id = body.get("event_id", "")
                    note = body.get("note", "")
                    store_cls.add_review_note(run_id, event_id, note)
                    self._json_response({"ok": True})
                    return

            # ── Security scan route ───────────────────────────
            if path == "/api/v1/security/scan":
                from clawwatch.security import classify_run_events, SecurityEvent
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length)) if length else {}
                run_ids = body.get("run_ids", []) or store_cls.get_unscanned_run_ids()

                total_events = 0
                for rid in run_ids:
                    events = store_cls.get_run_events(rid)
                    if not events:
                        continue
                    agent_name = events[0].get("agent_name", "openclaw") if events else "openclaw"
                    workdir = events[0].get("workdir", "") if events else ""
                    sec_events = classify_run_events(events, workdir)
                    for se in sec_events:
                        se.run_id = rid
                        se.agent_id = agent_name
                        
                        import hashlib
                        val = se.network_target if se.network_target else (se.raw_command or "")
                        pattern_hash = hashlib.sha256(val.encode("utf-8")).hexdigest()
                        if store_cls.is_in_skip_list(pattern_hash, se.event_type):
                            continue
                            
                        store_cls.insert_security_event(se.to_dict())
                        total_events += 1
                    # Mark scanned runs with no findings: insert a sentinel
                    if not sec_events:
                        store_cls.insert_security_event({
                            "id": str(__import__("uuid").uuid4()),
                            "run_id": rid,
                            "agent_id": agent_name,
                            "event_type": "SCAN_CLEAN",
                            "severity": "info",
                            "label": "Clean Scan",
                            "description": "No security events detected",
                            "detected_at": __import__("time").time(),
                            "acknowledged": 1,
                        })

                stats = store_cls.get_security_stats()
                self._json_response({
                    "ok": True,
                    "runs_scanned": len(run_ids),
                    "events_found": total_events,
                    "stats": stats,
                })
                return

            if path.startswith("/api/v1/security/events/") and path.endswith("/mark-safe"):
                event_id = path.split("/")[-2]
                
                import sqlite3
                from clawwatch.store import INDEX_DB
                if INDEX_DB.exists():
                    conn = sqlite3.connect(str(INDEX_DB), check_same_thread=False)
                    conn.row_factory = sqlite3.Row
                    row = conn.execute("SELECT * FROM security_events WHERE id = ?", (event_id,)).fetchone()
                    conn.close()
                    
                    if row:
                        import hashlib
                        val = row["network_target"] if row["network_target"] else (row["raw_command"] or "")
                        pattern_hash = hashlib.sha256(val.encode("utf-8")).hexdigest()
                        event_type = row["event_type"]
                        
                        store_cls.add_to_skip_list(pattern_hash, event_type, reason="Marked safe via UI")
                        store_cls.mark_events_false_positive(pattern_hash, event_type)
                
                self._json_response({"ok": True, "marked_safe": True})
                return

            self.send_response(404)
            self._cors()
            self.end_headers()

        def do_PATCH(self) -> None:  # noqa: N802
            path = self.path.split("?")[0]

            # Normalize: /api/ -> /api/v1/
            if path.startswith("/api/") and not path.startswith("/api/v1/"):
                path = "/api/v1/" + path[len("/api/"):]

            # PATCH /api/v1/threads/<thread_id> — rename thread
            if path.startswith("/api/v1/threads/") and path.count("/") == 4:
                thread_id = path.split("/")[4]
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length)) if length else {}
                display_name = body.get("display_name", "").strip()
                if not display_name:
                    self._json_response({"error": "display_name required"}, 400)
                    return
                ok = store_cls.rename_thread(thread_id, display_name)
                self._json_response({"ok": ok})
                return

            # PATCH /api/v1/security/events/<id>/acknowledge
            if path.startswith("/api/v1/security/events/") and path.endswith("/acknowledge"):
                parts = path.split("/")
                if len(parts) >= 6:
                    event_id = parts[5]
                    result = store_cls.acknowledge_security_event(event_id)
                    self._json_response(result)
                    return

            self.send_response(404)
            self._cors()
            self.end_headers()

        def _json_response(self, data: Any, status: int = 200) -> None:
            body = json.dumps(data, default=str).encode()
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _handle_sse(self) -> None:
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()

            client_q = broadcaster.add_client()
            try:
                while True:
                    try:
                        data = client_q.get(timeout=15)
                        self.wfile.write(f"data: {data}\n\n".encode())
                        self.wfile.flush()
                    except queue.Empty:
                        # keepalive comment
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                broadcaster.remove_client(client_q)
                
        def _serve_static(self, path: str) -> None:
            from pathlib import Path
            static_dir = Path(__file__).parent / "static"
            static_dir_resolved = static_dir.resolve()

            # Map root to index.html
            if path == "/" or not path:
                path = "/index.html"

            # Resolve the requested file path
            file_path = (static_dir / path.lstrip("/")).resolve()

            # Path traversal guard + existence check
            if not str(file_path).startswith(str(static_dir_resolved)) or not file_path.is_file():
                # SPA fallback: serve index.html for client-side routes
                file_path = static_dir / "index.html"
                if not file_path.is_file():
                    self.send_response(404)
                    self.end_headers()
                    self.wfile.write(b"Not Found (UI not bundled)")
                    return

            ext = file_path.suffix.lower()
            mimes = {
                ".html": "text/html; charset=utf-8",
                ".js": "application/javascript",
                ".css": "text/css",
                ".svg": "image/svg+xml",
                ".json": "application/json",
                ".png": "image/png",
                ".ico": "image/x-icon",
                ".woff": "font/woff",
                ".woff2": "font/woff2",
            }
            mime = mimes.get(ext, "application/octet-stream")

            try:
                content = file_path.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(content)))
                # Hashed assets are immutable; cache aggressively
                if "/assets/" in str(file_path):
                    self.send_header("Cache-Control", "public, max-age=31536000, immutable")
                self.end_headers()
                self.wfile.write(content)
            except Exception:
                self.send_response(500)
                self.end_headers()

    return Handler


class _ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    """HTTPServer that handles each request in a separate thread."""
    daemon_threads = True
    allow_reuse_address = True


class ClawWatchServer:
    """Manages the background HTTP server thread."""

    def __init__(self, port: int = 8765) -> None:
        self._port = port
        self._server: HTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        handler = _make_handler()
        self._server = _ThreadingHTTPServer(("127.0.0.1", self._port), handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()

    def broadcast_event(self, event_data: str) -> None:
        broadcaster.broadcast(event_data)
