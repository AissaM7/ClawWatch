"""Security event classifier — pure regex/string-matching, no external deps.

Philosophy: always-allow, always-record.  We never block agent execution;
we detect and surface security-relevant actions after the fact.
"""

from __future__ import annotations

import re
import time
import uuid
from dataclasses import dataclass, field, asdict
from typing import List, Optional


# ── Severity levels ──────────────────────────────────────────────

SEVERITY_CRITICAL = "critical"
SEVERITY_HIGH = "high"
SEVERITY_MEDIUM = "medium"
SEVERITY_LOW = "low"

SEVERITY_ORDER = {
    SEVERITY_CRITICAL: 0,
    SEVERITY_HIGH: 1,
    SEVERITY_MEDIUM: 2,
    SEVERITY_LOW: 3,
}

# ── Event type constants ─────────────────────────────────────────

# Critical
DESTRUCTIVE_FILE_OP = "DESTRUCTIVE_FILE_OP"
CREDENTIAL_ACCESS = "CREDENTIAL_ACCESS"
MASS_DELETION = "MASS_DELETION"          # run-level
DATABASE_WIPE = "DATABASE_WIPE"

# High
SHELL_ESCALATION = "SHELL_ESCALATION"
SENSITIVE_DATA_EXFIL = "SENSITIVE_DATA_EXFIL"
SYSTEM_CONFIG_WRITE = "SYSTEM_CONFIG_WRITE"
PROCESS_INJECTION = "PROCESS_INJECTION"

# Medium
BULK_FILE_READ = "BULK_FILE_READ"        # run-level
EXTERNAL_DOWNLOAD = "EXTERNAL_DOWNLOAD"
PORT_SCAN_BEHAVIOR = "PORT_SCAN_BEHAVIOR"  # run-level
CONFIG_EXFIL = "CONFIG_EXFIL"            # run-level
RECURSIVE_DIRECTORY_OP = "RECURSIVE_DIRECTORY_OP"

# Low
HIDDEN_FILE_ACCESS = "HIDDEN_FILE_ACCESS"
LARGE_FILE_WRITE = "LARGE_FILE_WRITE"
REPEATED_CREDENTIAL_READ = "REPEATED_CREDENTIAL_READ"  # run-level
CROSS_WORKSPACE_ACCESS = "CROSS_WORKSPACE_ACCESS"


# ── Label map ────────────────────────────────────────────────────

EVENT_LABELS = {
    DESTRUCTIVE_FILE_OP: "Destructive File Operation",
    CREDENTIAL_ACCESS: "Credential File Access",
    MASS_DELETION: "Mass Deletion Pattern",
    DATABASE_WIPE: "Database Destruction Command",
    SHELL_ESCALATION: "Privilege Escalation Attempt",
    SENSITIVE_DATA_EXFIL: "Potential Data Exfiltration",
    SYSTEM_CONFIG_WRITE: "System Configuration Modified",
    PROCESS_INJECTION: "Process Injection Attempt",
    BULK_FILE_READ: "Bulk File Read",
    EXTERNAL_DOWNLOAD: "External File Download",
    PORT_SCAN_BEHAVIOR: "Network Scanning Behavior",
    CONFIG_EXFIL: "Config Read Before Network Call",
    RECURSIVE_DIRECTORY_OP: "Recursive Directory Operation",
    HIDDEN_FILE_ACCESS: "Hidden File Access",
    LARGE_FILE_WRITE: "Large File Write",
    REPEATED_CREDENTIAL_READ: "Repeated Credential Read",
    CROSS_WORKSPACE_ACCESS: "Cross-Workspace File Access",
}

EVENT_SEVERITIES = {
    DESTRUCTIVE_FILE_OP: SEVERITY_CRITICAL,
    CREDENTIAL_ACCESS: SEVERITY_CRITICAL,
    MASS_DELETION: SEVERITY_CRITICAL,
    DATABASE_WIPE: SEVERITY_CRITICAL,
    SHELL_ESCALATION: SEVERITY_HIGH,
    SENSITIVE_DATA_EXFIL: SEVERITY_HIGH,
    SYSTEM_CONFIG_WRITE: SEVERITY_HIGH,
    PROCESS_INJECTION: SEVERITY_HIGH,
    BULK_FILE_READ: SEVERITY_MEDIUM,
    EXTERNAL_DOWNLOAD: SEVERITY_MEDIUM,
    PORT_SCAN_BEHAVIOR: SEVERITY_MEDIUM,
    CONFIG_EXFIL: SEVERITY_MEDIUM,
    RECURSIVE_DIRECTORY_OP: SEVERITY_MEDIUM,
    HIDDEN_FILE_ACCESS: SEVERITY_LOW,
    LARGE_FILE_WRITE: SEVERITY_LOW,
    REPEATED_CREDENTIAL_READ: SEVERITY_LOW,
    CROSS_WORKSPACE_ACCESS: SEVERITY_LOW,
}


# ── SecurityEvent dataclass ──────────────────────────────────────

@dataclass
class SecurityEvent:
    event_type: str
    severity: str
    label: str
    description: str
    raw_command: Optional[str] = None
    file_path: Optional[str] = None
    network_target: Optional[str] = None
    detected_at: float = field(default_factory=time.time)
    run_timestamp: Optional[float] = None
    # Set by caller when inserting
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    run_id: str = ""
    agent_id: str = ""
    chapter_id: Optional[str] = None
    trace_event_index: Optional[int] = None
    acknowledged: bool = False

    def to_dict(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v is not None}


# ── Helper: build event ──────────────────────────────────────────

def _evt(event_type: str, description: str, *,
         raw_command: Optional[str] = None,
         file_path: Optional[str] = None,
         network_target: Optional[str] = None,
         run_timestamp: Optional[float] = None) -> SecurityEvent:
    cmd = raw_command[:500] if raw_command and len(raw_command) > 500 else raw_command
    return SecurityEvent(
        event_type=event_type,
        severity=EVENT_SEVERITIES[event_type],
        label=EVENT_LABELS[event_type],
        description=description,
        raw_command=cmd,
        file_path=file_path,
        network_target=network_target,
        run_timestamp=run_timestamp,
    )


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  SINGLE-COMMAND CLASSIFIERS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def _check_destructive_file_op(cmd: str) -> Optional[SecurityEvent]:
    """CRITICAL: rm -rf on home dirs, shred/wipe, write to DB files."""
    lower = cmd.lower()

    # rm with recursive flags on dangerous paths
    if "rm" in lower:
        has_recursive = bool(re.search(r'-\w*r\w*f|-\w*f\w*r|-r\b', lower))
        dangerous_paths = ["~", "$home", "/home/", "/root/", "/users/", "*", "./"]
        if has_recursive and any(p in lower for p in dangerous_paths):
            return _evt(DESTRUCTIVE_FILE_OP,
                        f"Agent executed destructive delete command: '{cmd}'",
                        raw_command=cmd)

    # rmdir with path
    if re.search(r'\brmdir\b', lower) and len(cmd.strip().split()) > 1:
        return _evt(DESTRUCTIVE_FILE_OP,
                    f"Agent executed directory removal: '{cmd}'",
                    raw_command=cmd)

    # shred/wipe
    if re.search(r'\b(shred|wipe)\b', lower):
        parts = cmd.strip().split()
        if len(parts) > 1:
            return _evt(DESTRUCTIVE_FILE_OP,
                        f"Agent executed secure deletion: '{cmd}'",
                        raw_command=cmd)

    # Write to database files
    db_extensions = ('.db', '.sqlite', '.sqlite3', '.sql')
    db_paths = ('/database/', '/db/', 'postgres', 'mysql', 'mongo')
    write_verbs = ('write', 'edit', 'modify', 'update', 'save', 'overwrite')
    if any(v in lower for v in write_verbs):
        if any(lower.endswith(ext) or ext in lower for ext in db_extensions):
            return _evt(DESTRUCTIVE_FILE_OP,
                        f"Agent wrote to database file: '{cmd}'",
                        raw_command=cmd)
        if any(p in lower for p in db_paths):
            return _evt(DESTRUCTIVE_FILE_OP,
                        f"Agent wrote to database path: '{cmd}'",
                        raw_command=cmd)

    return None


# Credential file patterns
_CREDENTIAL_PATTERNS = [
    ".env", ".env.local", ".env.production", ".env.staging",
    "id_rsa", "id_ed25519", "id_dsa",
    ".pem", ".p12", ".pfx", ".key",
    "credentials", "/secrets/", ".netrc",
    "/.aws/", "/.ssh/", "keychain", "wallet.dat",
    "shadow", "passwd", "htpasswd",
    ".npmrc", ".pypirc", "docker-credential", "kubeconfig",
]


def _check_credential_access(cmd: str) -> Optional[SecurityEvent]:
    """CRITICAL: read/write of credential files."""
    lower = cmd.lower()
    access_verbs = ("read", "write", "cat", "open", "edit", "less", "more",
                    "head", "tail", "view", "nano", "vim", "vi", "cp", "mv")
    if not any(v in lower for v in access_verbs):
        return None

    for pattern in _CREDENTIAL_PATTERNS:
        if pattern.lower() in lower:
            fp = None
            # Try to extract file path
            parts = cmd.strip().split()
            for p in parts[1:]:
                if pattern.lower() in p.lower():
                    fp = p
                    break
            return _evt(CREDENTIAL_ACCESS,
                        f"Agent accessed credential file matching '{pattern}': '{cmd}'",
                        raw_command=cmd, file_path=fp)
    return None


def _check_database_wipe(cmd: str) -> Optional[SecurityEvent]:
    """CRITICAL: DROP/TRUNCATE/DELETE without WHERE."""
    lower = cmd.lower().strip()

    # DROP TABLE / DATABASE / SCHEMA
    if re.search(r'\bdrop\s+(table|database|schema)\b', lower):
        return _evt(DATABASE_WIPE,
                    f"Agent executed database destruction: '{cmd}'",
                    raw_command=cmd)

    # TRUNCATE TABLE or TRUNCATE <name>
    if re.search(r'\btruncate\s+\w+', lower):
        return _evt(DATABASE_WIPE,
                    f"Agent executed table truncation: '{cmd}'",
                    raw_command=cmd)

    # DELETE FROM without WHERE
    if re.search(r'\bdelete\s+from\b', lower):
        if not re.search(r'\bwhere\b', lower):
            return _evt(DATABASE_WIPE,
                        f"Agent executed unrestricted DELETE: '{cmd}'",
                        raw_command=cmd)

    # JS/Python ORM destructive calls
    orm_patterns = [
        r'db\.dropcollection', r'db\.drop\(\)', r'dropdatabase\(\)',
        r'mongoose\.connection\.dropdatabase',
        r'sequelize\.drop',
    ]
    for pat in orm_patterns:
        if re.search(pat, lower):
            return _evt(DATABASE_WIPE,
                        f"Agent executed ORM database destruction: '{cmd}'",
                        raw_command=cmd)

    return None


def _check_shell_escalation(cmd: str) -> Optional[SecurityEvent]:
    """HIGH: sudo, su, chmod 777, etc."""
    lower = cmd.lower()

    patterns = [
        (r'\bsudo\s', "sudo"),
        (r'\bsu\s*-', "su -"),
        (r'\bsudo\s+-[is]\b', "sudo -i/-s"),
        (r'\bchmod\s+777\b', "chmod 777"),
        (r'\bchmod\s+a\+x\b.*(/usr/|/bin/|/sbin/|/etc/)', "chmod a+x on system path"),
        (r'\bchown\s+root\b', "chown root"),
        (r'\bsetuid\b', "setuid"),
        (r'\bpkexec\b', "pkexec"),
        (r'\bdoas\s', "doas"),
    ]
    for pat, method in patterns:
        if re.search(pat, lower):
            return _evt(SHELL_ESCALATION,
                        f"Agent attempted privilege escalation via {method}: '{cmd}'",
                        raw_command=cmd)
    return None


# Well-known safe domains for exfil detection
_SAFE_DOMAINS = {
    "google.com", "reddit.com", "github.com", "npmjs.com", "pypi.org",
    "anthropic.com", "openai.com", "stackoverflow.com"
}


def _check_sensitive_data_exfil(cmd: str) -> Optional[SecurityEvent]:
    """HIGH: outbound network with potential secret/key data."""
    lower = cmd.lower()
    
    # If it's a known network protocol/command
    network_cmds = ("curl", "wget", "fetch", "axios", "http.get",
                    "requests.post", "requests.get", "http.request", "web_fetch")
    is_network_call = any(nc in lower for nc in network_cmds)
    
    # Check destination — extract URL
    is_safe_domain = False
    url_match = re.search(r'https?://([^/\s\"\']+)', cmd)
    if url_match:
        host = url_match.group(1).lower().split(":")[0]
        if any(host.endswith(safe) for safe in _SAFE_DOMAINS):
            is_safe_domain = True
        else:
            # If not safe domain and it's a network command with body data, flag unknown endpoint
            if is_network_call and re.search(r'(-d\s|--data|--body|--json|\|\s*(curl|wget))', lower):
                return _evt(SENSITIVE_DATA_EXFIL,
                            f"Agent sent data to unknown endpoint: {host}",
                            raw_command=cmd, network_target=host)
    
    # Exfiltration Whitelisting: ignore high-entropy strings if headed to a safe domain
    if is_safe_domain:
        return None

    # Check for long token-like strings (potential API keys)
    if re.search(r'[A-Za-z0-9_\-]{32,}', cmd):
        return _evt(SENSITIVE_DATA_EXFIL,
                    f"Agent sent data containing potential API key/token: '{cmd[:120]}...'",
                    raw_command=cmd)

    # Check for large base64 content
    if re.search(r'[A-Za-z0-9+/]{100,}={0,2}', cmd):
        return _evt(SENSITIVE_DATA_EXFIL,
                    f"Agent sent base64-encoded data in network request: '{cmd[:120]}...'",
                    raw_command=cmd)

    return None


def _check_system_config_write(cmd: str) -> Optional[SecurityEvent]:
    """HIGH: writes to system config paths."""
    lower = cmd.lower()
    write_verbs = ("write", "edit", "modify", "save", "echo", ">>", ">",
                   "tee", "sed", "nano", "vim", "vi", "cat >")
    if not any(v in lower for v in write_verbs):
        return None

    sys_paths = [
        "/etc/", "/system/", "c:\\windows\\", "/usr/local/bin/", "/usr/bin/",
    ]
    config_files = [
        "~/.bashrc", "~/.zshrc", "~/.profile", "~/.bash_profile",
        "~/.zprofile", "~/.config/", "crontab", "/etc/cron",
    ]
    plist_paths = ["/library/launchagents/", "/library/launchdaemons/"]

    for sp in sys_paths:
        if sp in lower:
            return _evt(SYSTEM_CONFIG_WRITE,
                        f"Agent modified system configuration: '{cmd}'",
                        raw_command=cmd)

    for cf in config_files:
        if cf in lower:
            return _evt(SYSTEM_CONFIG_WRITE,
                        f"Agent modified config file: '{cmd}'",
                        raw_command=cmd)

    for pp in plist_paths:
        if pp in lower and ".plist" in lower:
            return _evt(SYSTEM_CONFIG_WRITE,
                        f"Agent modified launch agent/daemon: '{cmd}'",
                        raw_command=cmd)

    return None


def _check_process_injection(cmd: str) -> Optional[SecurityEvent]:
    """HIGH: ptrace, LD_PRELOAD, DYLD_INSERT, signal injection."""
    lower = cmd.lower()
    patterns = [
        (r'\bptrace\b', "ptrace"),
        (r'ld_preload=', "LD_PRELOAD injection"),
        (r'dyld_insert_libraries=', "DYLD_INSERT_LIBRARIES injection"),
        (r'process\.inject', "process injection"),
        (r'\bkill\s+-9\s+\d+', "kill -9 on PID"),
    ]
    for pat, method in patterns:
        if re.search(pat, lower):
            return _evt(PROCESS_INJECTION,
                        f"Agent attempted {method}: '{cmd}'",
                        raw_command=cmd)
    return None


def _check_external_download(cmd: str) -> Optional[SecurityEvent]:
    """MEDIUM: external downloads with file output."""
    lower = cmd.lower()
    dl_cmds = ("curl", "wget")
    if not any(d in lower for d in dl_cmds):
        return None

    output_patterns = ["-o ", "-O", "--output", "> ", "| tee"]
    url_match = re.search(r'https?://([^/\s]+)', cmd)
    if url_match and any(op in lower for op in output_patterns):
        host = url_match.group(1).lower()
        if not host.startswith(("localhost", "127.0.0.1")):
            return _evt(EXTERNAL_DOWNLOAD,
                        f"Agent downloaded file from external source: {host}",
                        raw_command=cmd, network_target=host)
    return None


def _check_recursive_directory_op(cmd: str, workspace: str = "") -> Optional[SecurityEvent]:
    """MEDIUM: recursive ops outside workspace."""
    lower = cmd.lower()
    if not re.search(r'-[rR]\b|--recursive', cmd):
        return None

    # Extract path (rough heuristic: last arg or path-like token)
    tokens = cmd.strip().split()
    path_token = ""
    for t in reversed(tokens):
        if t.startswith("/") or t.startswith("~") or t.startswith("."):
            path_token = t
            break

    if path_token and workspace and not path_token.startswith(workspace):
        return _evt(RECURSIVE_DIRECTORY_OP,
                    f"Agent ran recursive operation outside workspace: '{cmd}'",
                    raw_command=cmd, file_path=path_token)
    elif path_token and not workspace:
        # No workspace defined — flag anyway if it touches system paths
        sys_paths = ["/etc", "/usr", "/var", "/opt", "/home", "/root", "/Users"]
        if any(path_token.startswith(sp) for sp in sys_paths):
            return _evt(RECURSIVE_DIRECTORY_OP,
                        f"Agent ran recursive operation on system path: '{cmd}'",
                        raw_command=cmd, file_path=path_token)
    return None


def _check_hidden_file_access(cmd: str, workspace: str = "") -> Optional[SecurityEvent]:
    """LOW: access to hidden files outside workspace."""
    # Find hidden file/dir references (starts with .)
    hidden_match = re.search(r'(/[^\s]*\.[a-zA-Z][^\s]*)', cmd)
    if not hidden_match:
        return None

    path = hidden_match.group(1)
    basename = path.rsplit("/", 1)[-1] if "/" in path else path

    # Exclude common benign hidden files
    benign = {".gitignore", ".git", ".ds_store", ".npmignore", ".eslintrc",
              ".prettierrc", ".editorconfig"}
    if basename.lower() in benign:
        return None
    if basename.lower().startswith(".git/") or "/.git/" in path.lower():
        return None

    if workspace and path.startswith(workspace):
        return None

    return _evt(HIDDEN_FILE_ACCESS,
                f"Agent accessed hidden file: '{path}'",
                raw_command=cmd, file_path=path)


def _check_cross_workspace_access(cmd: str, workspace: str = "") -> Optional[SecurityEvent]:
    """LOW: file operations outside the workspace."""
    if not workspace:
        return None

    lower = cmd.lower()
    file_ops = ("read", "write", "cat", "open", "edit", "cp", "mv", "rm",
                "touch", "mkdir", "nano", "vim", "vi")
    if not any(op in lower for op in file_ops):
        return None

    # Extract paths from the command
    tokens = cmd.strip().split()
    for t in tokens[1:]:
        if t.startswith("/") and not t.startswith(workspace):
            return _evt(CROSS_WORKSPACE_ACCESS,
                        f"Agent accessed file outside workspace: '{t}'",
                        raw_command=cmd, file_path=t)
    return None


# ── Master single-command classifier ─────────────────────────────

def classify_command(command: str, workspace: str = "", is_output: bool = False) -> List[SecurityEvent]:
    """Classify a single command/tool call string. Returns 0+ events."""
    if not command or not command.strip():
        return []

    # Homebrew/System Log Protection
    if any(log_indicator in command for log_indicator in ["==>", "✔︎", "Pouring", "Auto-updated"]):
        return []

    results: List[SecurityEvent] = []
    
    # Target Isolation: some checkers only run on input strings
    if is_output:
        checkers = [
            _check_credential_access,
            _check_sensitive_data_exfil,
        ]
        ctx_checkers = []
    else:
        checkers = [
            _check_destructive_file_op,
            _check_credential_access,
            _check_database_wipe,
            _check_shell_escalation,
            _check_sensitive_data_exfil,
            _check_system_config_write,
            _check_process_injection,
            _check_external_download,
        ]
        ctx_checkers = [
            (_check_recursive_directory_op, workspace),
            (_check_hidden_file_access, workspace),
            (_check_cross_workspace_access, workspace),
        ]

    for checker in checkers:
        r = checker(command)
        if r:
            results.append(r)

    for checker, ws in ctx_checkers:
        r = checker(command, ws)
        if r:
            results.append(r)

    return results


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  RUN-LEVEL CLASSIFIERS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def _check_mass_deletion(events: List[dict]) -> List[SecurityEvent]:
    """CRITICAL: 3+ delete/remove ops within 60s window."""
    delete_times: List[float] = []
    for e in events:
        et = e.get("event_type", "")
        cmd = (e.get("command_tokens", "") or e.get("tool_args", "") or "").lower()
        if et == "file_delete" or ("rm " in cmd or "del " in cmd or "remove" in cmd):
            delete_times.append(e.get("wall_ts", 0))

    if len(delete_times) < 3:
        return []

    delete_times.sort()
    # Sliding window
    for i in range(len(delete_times) - 2):
        if delete_times[i + 2] - delete_times[i] <= 60:
            return [_evt(MASS_DELETION,
                         f"Detected {len(delete_times)} delete operations within a 60-second window",
                         run_timestamp=delete_times[i])]
    return []


def _check_bulk_file_read(events: List[dict]) -> List[SecurityEvent]:
    """MEDIUM: >20 distinct file reads in a run."""
    paths: set = set()
    for e in events:
        if e.get("event_type") == "file_read" and e.get("file_path"):
            paths.add(e["file_path"])
    if len(paths) > 20:
        return [_evt(BULK_FILE_READ,
                     f"Agent read {len(paths)} distinct files in a single run")]
    return []


def _check_port_scan(events: List[dict]) -> List[SecurityEvent]:
    """MEDIUM: >5 distinct hosts contacted."""
    hosts: set = set()
    for e in events:
        if e.get("event_type") in ("network_request",) and e.get("url"):
            m = re.search(r'https?://([^/:]+)', e["url"])
            if m:
                host = m.group(1).lower()
                if host not in ("localhost", "127.0.0.1"):
                    hosts.add(host)
    if len(hosts) > 5:
        return [_evt(PORT_SCAN_BEHAVIOR,
                     f"Agent contacted {len(hosts)} distinct external hosts")]
    return []


def _check_config_exfil(events: List[dict]) -> List[SecurityEvent]:
    """MEDIUM: credential read followed by network call within 30s."""
    cred_reads: List[dict] = []
    net_calls: List[dict] = []

    for e in events:
        fp = (e.get("file_path") or "").lower()
        et = e.get("event_type", "")
        cmd = (e.get("command_tokens", "") or e.get("tool_args", "") or "").lower()

        if et == "file_read" and any(p in fp for p in _CREDENTIAL_PATTERNS):
            cred_reads.append(e)
        elif "cat" in cmd and any(p in cmd for p in _CREDENTIAL_PATTERNS):
            cred_reads.append(e)

        if et in ("network_request",):
            net_calls.append(e)

    for cr in cred_reads:
        cr_ts = cr.get("wall_ts", 0)
        for nc in net_calls:
            nc_ts = nc.get("wall_ts", 0)
            if 0 < nc_ts - cr_ts <= 30:
                return [_evt(CONFIG_EXFIL,
                             f"Credential file read followed by network call within {int(nc_ts - cr_ts)}s",
                             run_timestamp=cr_ts)]
    return []


def _check_repeated_credential_read(events: List[dict]) -> List[SecurityEvent]:
    """LOW: same credential file read more than once."""
    cred_reads: dict = {}
    for e in events:
        fp = (e.get("file_path") or "").lower()
        if e.get("event_type") == "file_read" and any(p in fp for p in _CREDENTIAL_PATTERNS):
            cred_reads[fp] = cred_reads.get(fp, 0) + 1

    results = []
    for fp, count in cred_reads.items():
        if count > 1:
            results.append(_evt(REPEATED_CREDENTIAL_READ,
                                f"Credential file '{fp}' was read {count} times in this run",
                                file_path=fp))
    return results


def _check_large_file_write(events: List[dict]) -> List[SecurityEvent]:
    """LOW: write operations producing output >10MB."""
    results = []
    for e in events:
        if e.get("event_type") == "file_write":
            size = e.get("file_size_bytes", 0) or 0
            if size > 10 * 1024 * 1024:
                fp = e.get("file_path", "unknown")
                results.append(_evt(LARGE_FILE_WRITE,
                                    f"Agent wrote large file ({size // (1024*1024)}MB): '{fp}'",
                                    file_path=fp,
                                    run_timestamp=e.get("wall_ts")))
    return results


# ── Master run-level classifier ──────────────────────────────────

def classify_run_events(events: List[dict], workspace: str = "") -> List[SecurityEvent]:
    """Classify an entire run's event sequence. Returns all detected events
    from both per-command and run-level classifiers.
    """
    all_results: List[SecurityEvent] = []

    # Per-event classifiers
    for i, e in enumerate(events):
        et = e.get("event_type", "")
        cmd = ""

        if et in ("tool_call_start", "tool_call_end"):
            tool = e.get("tool_name", "")
            args = e.get("tool_args", "")
            result = e.get("tool_result", "")
            cmd = f"{tool} {args}" if args else tool
            # Also check the result for DB commands (output)
            if result:
                for r in classify_command(result, workspace, is_output=True):
                    r.run_timestamp = e.get("wall_ts")
                    r.trace_event_index = i
                    all_results.append(r)

        elif et == "subprocess_exec":
            cmd = e.get("command_tokens", "") or ""

        elif et in ("file_read", "file_write", "file_delete"):
            fp = e.get("file_path", "")
            cmd = f"{et.replace('file_', '')} {fp}"

        elif et == "network_request":
            method = e.get("method", "GET")
            url = e.get("url", "")
            cmd = f"{method} {url}"

        if cmd:
            for r in classify_command(cmd, workspace):
                r.run_timestamp = e.get("wall_ts")
                r.trace_event_index = i
                all_results.append(r)

    # Run-level detectors
    run_checkers = [
        _check_mass_deletion,
        _check_bulk_file_read,
        _check_port_scan,
        _check_config_exfil,
        _check_repeated_credential_read,
        _check_large_file_write,
    ]
    for checker in run_checkers:
        all_results.extend(checker(events))

    return all_results
