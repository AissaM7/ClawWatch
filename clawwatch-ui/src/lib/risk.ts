// ── Risk Scoring Engine — pure TypeScript, deterministic ─────────

import type { ClawEvent, RiskLevel, RiskResult, RiskRule } from './types';

// ── Critical file patterns ───────────────────────────────────────
const CRITICAL_PATH_PATTERNS = [
  '/.ssh/', '/.aws/', '/.kube/', '/etc/passwd', '/etc/shadow',
  '/etc/hosts', '/.env', '/.gitconfig', '/.npmrc', '/.pypirc',
  '/.config/gcloud',
];

const CREDENTIAL_EXTENSIONS = ['.pem', '.key', '.pfx', '.p12', '.p8', '.ppk'];

const EXECUTABLE_EXTENSIONS = ['.sh', '.bash', '.exe', '.bin'];

const SCRIPT_EXTENSIONS = ['.py', '.js', '.ts'];

// ── Network patterns ────────────────────────────────────────────
const PRIVATE_IP_PREFIXES = ['10.', '172.16.', '172.17.', '172.18.', '172.19.',
  '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.',
  '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.',
  '192.168.', '127.'];

const METADATA_ENDPOINTS = [
  '169.254.169.254', 'metadata.google.internal', 'fd00:ec2::254',
];

const EXFIL_DOMAINS = [
  'pastebin.com', 'paste.ee', 'hastebin.com', 'dpaste.org',
  'ghostbin.co', 'transfer.sh', 'file.io', 'wetransfer.com',
  '0x0.st', 'ix.io', 'sprunge.us', 'catbox.moe', 'uguu.se',
  'teknik.io', 'pomf.cat', 'mixtape.moe', 'litter.catbox.moe',
  'tmpfiles.org', 'anonfiles.com', 'bayfiles.com',
];

// ── Subprocess patterns ─────────────────────────────────────────
const PIPE_TO_SHELL = ['| bash', '| sh', '| python', '| node'];
const DANGEROUS_COMMANDS = ['eval', 'exec(', 'base64 -d', 'xxd -r'];
const NETWORK_TOOLS = ['nc', 'netcat'];
const GLOBAL_INSTALLS = ['pip install', 'npm install -g', 'brew install', 'apt install', 'yum install'];
const PRIV_ESCALATION = ['sudo', 'chmod 777'];
const SYSTEM_ID_CMDS = ['whoami', 'uname', 'hostname', 'ifconfig', 'ip addr'];

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function pathSegments(p: string): number {
  return p.split('/').filter(Boolean).length;
}

// ── Rule functions ──────────────────────────────────────────────

function scoreFileEvent(event: ClawEvent, allEvents: ClawEvent[]): RiskRule[] {
  const rules: RiskRule[] = [];
  const fp = event.file_path || '';
  const isWrite = event.event_type === 'file_write';
  const isDelete = event.event_type === 'file_delete';
  const isRead = event.event_type === 'file_read';
  const insideWorkdir = Boolean(event.is_inside_workdir);

  // Critical — sensitive paths
  for (const pattern of CRITICAL_PATH_PATTERNS) {
    if (fp.includes(pattern)) {
      rules.push({
        name: 'critical_path',
        level: 'critical',
        score: 95,
        explanation: `File operation on sensitive path: ${fp} (matches ${pattern})`,
      });
    }
  }

  // Critical — deleting shallow paths
  if (isDelete && pathSegments(fp) < 4) {
    rules.push({
      name: 'shallow_delete',
      level: 'critical',
      score: 95,
      explanation: `Deleting path with fewer than 4 segments from root: ${fp}`,
    });
  }

  // Critical — writing executables outside workdir
  if (isWrite && !insideWorkdir && EXECUTABLE_EXTENSIONS.some(e => fp.endsWith(e))) {
    rules.push({
      name: 'executable_outside_workdir',
      level: 'critical',
      score: 95,
      explanation: `Writing executable file outside working directory: ${fp}`,
    });
  }

  // High — operations outside workdir
  if (!insideWorkdir) {
    rules.push({
      name: 'outside_workdir',
      level: 'high',
      score: 70,
      explanation: `File operation outside working directory: ${fp}`,
    });
  }

  // High — deleting files not created in this run
  if (isDelete) {
    const createdInRun = allEvents.some(
      e => e.event_type === 'file_write' && e.file_path === fp && e.sequence_num < event.sequence_num
    );
    if (!createdInRun) {
      rules.push({
        name: 'delete_uncreated',
        level: 'high',
        score: 70,
        explanation: `Deleting a file the agent did not create during this run: ${fp}`,
      });
    }
  }

  // High — reading credential files
  if (isRead && CREDENTIAL_EXTENSIONS.some(e => fp.endsWith(e))) {
    rules.push({
      name: 'credential_read',
      level: 'high',
      score: 70,
      explanation: `Reading credential file: ${fp}`,
    });
  }

  // Medium — scripts outside project
  if (isWrite && !insideWorkdir && SCRIPT_EXTENSIONS.some(e => fp.endsWith(e))) {
    rules.push({
      name: 'script_outside_project',
      level: 'medium',
      score: 45,
      explanation: `Writing script file outside project: ${fp}`,
    });
  }

  // Medium — reading .env files
  if (isRead && fp.endsWith('.env')) {
    rules.push({
      name: 'env_file_read',
      level: 'medium',
      score: 45,
      explanation: `Reading .env file (may contain secrets): ${fp}`,
    });
  }

  // Medium — writing to hidden dirs
  if (isWrite && fp.split('/').some(seg => seg.startsWith('.') && seg.length > 1)) {
    rules.push({
      name: 'hidden_dir_write',
      level: 'medium',
      score: 45,
      explanation: `Writing to hidden directory: ${fp}`,
    });
  }

  // Low — large file writes
  if (isWrite && (event.file_size_bytes || 0) > 10 * 1024 * 1024) {
    rules.push({
      name: 'large_file_write',
      level: 'low',
      score: 20,
      explanation: `Large file write (${((event.file_size_bytes || 0) / 1024 / 1024).toFixed(1)}MB): ${fp}`,
    });
  }

  return rules;
}

function scoreNetworkEvent(event: ClawEvent, allEvents: ClawEvent[]): RiskRule[] {
  const rules: RiskRule[] = [];
  const eventUrl = event.url || '';
  const method = (event.method || 'GET').toUpperCase();
  const domain = extractDomain(eventUrl);

  // Critical — private IPs
  if (PRIVATE_IP_PREFIXES.some(p => domain.startsWith(p)) || domain === '::1') {
    rules.push({
      name: 'private_ip_request',
      level: 'critical',
      score: 95,
      explanation: `Request to private IP address: ${eventUrl}`,
    });
  }

  // Critical — metadata endpoints
  if (METADATA_ENDPOINTS.some(m => domain === m || eventUrl.includes(m))) {
    rules.push({
      name: 'metadata_endpoint',
      level: 'critical',
      score: 95,
      explanation: `Request to cloud metadata endpoint: ${eventUrl}`,
    });
  }

  // Critical — large POST/PUT to unknown domains
  if ((method === 'POST' || method === 'PUT') && (event.request_body_bytes || 0) > 100 * 1024) {
    rules.push({
      name: 'large_post_body',
      level: 'critical',
      score: 95,
      explanation: `Large ${method} request (${((event.request_body_bytes || 0) / 1024).toFixed(0)}KB) to ${domain}`,
    });
  }

  // High — exfiltration domains
  if (EXFIL_DOMAINS.some(d => domain.includes(d))) {
    rules.push({
      name: 'exfil_domain',
      level: 'high',
      score: 70,
      explanation: `Request to known file exfiltration service: ${domain}`,
    });
  }

  // High — base64 in URL
  const base64Regex = /[A-Za-z0-9+/=]{100,}/;
  if (base64Regex.test(eventUrl)) {
    rules.push({
      name: 'base64_url',
      level: 'high',
      score: 70,
      explanation: `URL contains long base64-encoded segment: ${eventUrl.substring(0, 80)}...`,
    });
  }

  // Medium — first request to new domain
  const earlierDomains = new Set(
    allEvents
      .filter(e => (e.event_type === 'network_request' || e.event_type === 'network_response') && e.sequence_num < event.sequence_num)
      .map(e => extractDomain(e.url || ''))
  );
  if (!earlierDomains.has(domain)) {
    rules.push({
      name: 'new_domain',
      level: 'medium',
      score: 45,
      explanation: `First request to new domain: ${domain}`,
    });
  }

  // Medium — HTTP (not HTTPS) external
  if (eventUrl.startsWith('http://') && !domain.startsWith('127.') && domain !== 'localhost') {
    rules.push({
      name: 'insecure_http',
      level: 'medium',
      score: 45,
      explanation: `Insecure HTTP request to external domain: ${domain}`,
    });
  }

  // Medium — large response
  if ((event.response_body_bytes || 0) > 50 * 1024 * 1024) {
    rules.push({
      name: 'large_response',
      level: 'medium',
      score: 45,
      explanation: `Unusually large response body (${((event.response_body_bytes || 0) / 1024 / 1024).toFixed(0)}MB)`,
    });
  }

  return rules;
}

function scoreSubprocessEvent(event: ClawEvent): RiskRule[] {
  const rules: RiskRule[] = [];
  let cmdStr = '';
  try {
    const tokens: string[] = JSON.parse(event.command_tokens || '[]');
    cmdStr = tokens.join(' ');
  } catch {
    cmdStr = event.command_tokens || '';
  }
  const cmdLower = cmdStr.toLowerCase();

  // Critical — pipe to shell
  if (PIPE_TO_SHELL.some(p => cmdLower.includes(p))) {
    rules.push({
      name: 'pipe_to_shell',
      level: 'critical',
      score: 95,
      explanation: `Command pipes to shell interpreter: ${cmdStr}`,
    });
  }

  // Critical — dangerous commands
  if (DANGEROUS_COMMANDS.some(d => cmdLower.includes(d))) {
    rules.push({
      name: 'dangerous_command',
      level: 'critical',
      score: 95,
      explanation: `Command contains dangerous operation: ${cmdStr}`,
    });
  }

  // Critical — network tools
  if (NETWORK_TOOLS.some(t => cmdLower.split(/\s+/).includes(t))) {
    rules.push({
      name: 'network_tool',
      level: 'critical',
      score: 95,
      explanation: `Command invokes outbound network tool: ${cmdStr}`,
    });
  }

  // Critical — SSH config modification
  if (cmdLower.includes('.ssh') && (cmdLower.includes('write') || cmdLower.includes('>>') || cmdLower.includes('>'))) {
    rules.push({
      name: 'ssh_config_mod',
      level: 'critical',
      score: 95,
      explanation: `Command modifies SSH configuration: ${cmdStr}`,
    });
  }

  // High — global installs
  if (GLOBAL_INSTALLS.some(g => cmdLower.includes(g))) {
    rules.push({
      name: 'global_install',
      level: 'high',
      score: 70,
      explanation: `Package manager global install: ${cmdStr}`,
    });
  }

  // High — privilege escalation
  if (PRIV_ESCALATION.some(p => cmdLower.includes(p))) {
    rules.push({
      name: 'privilege_escalation',
      level: 'high',
      score: 70,
      explanation: `Permission escalation detected: ${cmdStr}`,
    });
  }

  // High — process management
  if (cmdLower.startsWith('kill ') || cmdLower.startsWith('pkill ') || cmdLower.includes('/proc')) {
    rules.push({
      name: 'process_management',
      level: 'high',
      score: 70,
      explanation: `Process inspection or signaling: ${cmdStr}`,
    });
  }

  // Medium — system identity
  if (SYSTEM_ID_CMDS.some(c => cmdLower.split(/\s+/).includes(c))) {
    rules.push({
      name: 'system_identity',
      level: 'medium',
      score: 45,
      explanation: `Reading system identity: ${cmdStr}`,
    });
  }

  // Medium — cron
  if (cmdLower.includes('crontab') || cmdLower.includes('cron')) {
    rules.push({
      name: 'cron_modification',
      level: 'medium',
      score: 45,
      explanation: `Modifying cron jobs: ${cmdStr}`,
    });
  }

  return rules;
}

function scoreLlmEvent(event: ClawEvent): RiskRule[] {
  const rules: RiskRule[] = [];

  // High — very large context
  if ((event.input_tokens || 0) > 100000) {
    rules.push({
      name: 'huge_context',
      level: 'high',
      score: 70,
      explanation: `Extremely large input context: ${event.input_tokens?.toLocaleString()} tokens`,
    });
  }

  // Medium — large context
  if ((event.input_tokens || 0) > 50000 && (event.input_tokens || 0) <= 100000) {
    rules.push({
      name: 'large_context',
      level: 'medium',
      score: 45,
      explanation: `Large input context: ${event.input_tokens?.toLocaleString()} tokens`,
    });
  }

  return rules;
}

// ── Main scoring function ───────────────────────────────────────

const LEVEL_ORDER: RiskLevel[] = ['safe', 'low', 'medium', 'high', 'critical'];

function maxLevel(rules: RiskRule[]): RiskLevel {
  if (rules.length === 0) return 'safe';
  let highest = 0;
  for (const r of rules) {
    highest = Math.max(highest, LEVEL_ORDER.indexOf(r.level));
  }
  return LEVEL_ORDER[highest];
}

export function scoreEvent(event: ClawEvent, allEvents: ClawEvent[]): RiskResult {
  let rules: RiskRule[] = [];

  // File events
  if (['file_read', 'file_write', 'file_delete'].includes(event.event_type)) {
    rules = scoreFileEvent(event, allEvents);
  }

  // Network events
  if (['network_request', 'network_response'].includes(event.event_type)) {
    rules = scoreNetworkEvent(event, allEvents);
  }

  // Subprocess
  if (event.event_type === 'subprocess_exec') {
    rules = scoreSubprocessEvent(event);
  }

  // LLM
  if (['llm_call_start', 'llm_call_end'].includes(event.event_type)) {
    rules = scoreLlmEvent(event);
  }

  // Loop detected is always medium
  if (event.event_type === 'loop_detected') {
    rules.push({
      name: 'loop_detected',
      level: 'medium',
      score: 45,
      explanation: `Loop detected: ${event.tool_name} called ${event.repeat_count}× with identical args`,
    });
  }

  const level = maxLevel(rules);
  const score = rules.length > 0 ? Math.max(...rules.map(r => r.score)) : 0;

  return {
    level,
    score,
    requires_review: score > 70,
    rules,
  };
}
