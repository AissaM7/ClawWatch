"""Command-line interface for ClawWatch."""

import argparse
import importlib.metadata
import os
import socket
import time

from clawwatch.server import ClawWatchServer
from clawwatch.store import BASE_DIR, RUNS_DIR, INDEX_DB, CONFIG_FILE


def _cmd_ui(args):
    """Start the ClawWatch dashboard."""
    print(f"Starting ClawWatch dashboard on http://127.0.0.1:{args.port}")
    print("Press Ctrl+C to stop.")
    server = ClawWatchServer(args.port)
    server.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.stop()


def _cmd_doctor(args):
    """Run diagnostic checks."""
    port = args.port
    issues = 0

    # 1. Version
    try:
        from clawwatch import __version__
        _ok(f"ClawWatch version {__version__}")
    except Exception:
        _warn("Could not determine ClawWatch version")
        issues += 1

    # 2. Plugin discovery
    try:
        eps = importlib.metadata.entry_points()
        cw_eps = [ep for ep in eps.get("openclaw.plugins", []) if ep.name == "clawwatch"]
        if cw_eps:
            _ok("Plugin registered as openclaw.plugins entry point")
        else:
            _warn("Plugin NOT found in openclaw.plugins entry points")
            _hint("Run: pip install -e . (from the clawwatch-plugin directory)")
            issues += 1
    except Exception:
        _warn("Could not inspect entry points")
        issues += 1

    # 3. Data directory
    if BASE_DIR.exists():
        _ok(f"Data directory exists: {BASE_DIR}")
    else:
        _info(f"Data directory does not exist yet: {BASE_DIR}")
        _hint("It will be created automatically on the first agent run.")

    # 4. Existing runs
    if INDEX_DB.exists():
        try:
            import sqlite3
            conn = sqlite3.connect(str(INDEX_DB))
            count = conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
            conn.close()
            _ok(f"Index database: {count} run(s) recorded")
        except Exception as e:
            _warn(f"Index database exists but cannot be read: {e}")
            issues += 1
    else:
        _info("No runs recorded yet (index.db not found)")

    # 5. Config file
    if CONFIG_FILE.exists():
        _ok(f"Config file found: {CONFIG_FILE}")
    else:
        _info("No config file (using defaults)")

    # 6. CLAWWATCH_DIR override
    cw_dir = os.environ.get("CLAWWATCH_DIR")
    if cw_dir:
        _ok(f"CLAWWATCH_DIR is set: {cw_dir}")
    else:
        _info("CLAWWATCH_DIR not set (using ~/.clawwatch)")

    # 7. Port availability
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(1)
        result = sock.connect_ex(("127.0.0.1", port))
        sock.close()
        if result == 0:
            _warn(f"Port {port} is already in use")
            _hint("Another process is listening. Use --port to choose a different port.")
            issues += 1
        else:
            _ok(f"Port {port} is available")
    except Exception:
        _warn(f"Could not check port {port}")
        issues += 1

    # 8. Bundled UI
    from pathlib import Path
    static_dir = Path(__file__).parent / "static" / "index.html"
    if static_dir.exists():
        _ok("Bundled UI assets found")
    else:
        _warn("Bundled UI assets NOT found")
        _hint("Run: make build (from the project root) to bundle the React dashboard.")
        issues += 1

    # Summary
    print()
    if issues == 0:
        print("  All checks passed. You're ready to go.")
    else:
        print(f"  {issues} issue(s) found. See hints above.")


def _ok(msg):
    print(f"  \033[32m\u2713\033[0m {msg}")

def _warn(msg):
    print(f"  \033[31m\u2717\033[0m {msg}")

def _info(msg):
    print(f"  \033[33m-\033[0m {msg}")

def _hint(msg):
    print(f"    \033[90m\u2192 {msg}\033[0m")


def main():
    parser = argparse.ArgumentParser(
        prog="clawwatch",
        description="ClawWatch \u2014 local observability for OpenClaw agents",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # 'ui' subcommand
    ui_parser = subparsers.add_parser("ui", help="Start the ClawWatch dashboard")
    ui_parser.add_argument(
        "--port", type=int, default=8765, help="Port to bind to (default: 8765)"
    )

    # 'doctor' subcommand
    doc_parser = subparsers.add_parser("doctor", help="Check environment and configuration")
    doc_parser.add_argument(
        "--port", type=int, default=8765, help="Port to check (default: 8765)"
    )

    args = parser.parse_args()

    if args.command == "ui":
        _cmd_ui(args)
    elif args.command == "doctor":
        _cmd_doctor(args)


if __name__ == "__main__":
    main()
