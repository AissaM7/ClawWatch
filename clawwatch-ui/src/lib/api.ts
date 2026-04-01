// ── API client + SSE connection layer ────────────────────────────

import type { ClawEvent, Run, Agent, Thread, Task, Exchange, SecurityEvent, SecurityStats, SecurityScanResult } from './types';

const BASE_URL = (import.meta.env.VITE_CLAWWATCH_API as string) || '';

export async function fetchRuns(): Promise<Run[]> {
  const res = await fetch(`${BASE_URL}/api/v1/runs`);
  if (!res.ok) throw new Error(`Failed to fetch runs: ${res.status}`);
  return res.json();
}

export async function fetchRunEvents(runId: string): Promise<ClawEvent[]> {
  const res = await fetch(`${BASE_URL}/api/v1/runs/${runId}`);
  if (!res.ok) throw new Error(`Failed to fetch events: ${res.status}`);
  return res.json();
}

export async function fetchHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function submitReview(
  runId: string,
  eventId: string,
  note: string
): Promise<void> {
  await fetch(`${BASE_URL}/api/v1/runs/${runId}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_id: eventId, note }),
  });
}

// ── Hierarchy API ────────────────────────────────────────────────

export async function fetchAgents(): Promise<Agent[]> {
  const res = await fetch(`${BASE_URL}/api/v1/agents`);
  if (!res.ok) throw new Error(`Failed to fetch agents: ${res.status}`);
  return res.json();
}

export async function fetchThreads(agentId?: string): Promise<Thread[]> {
  const url = agentId
    ? `${BASE_URL}/api/v1/threads?agent_id=${encodeURIComponent(agentId)}`
    : `${BASE_URL}/api/v1/threads`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch threads: ${res.status}`);
  return res.json();
}

export async function renameThread(threadId: string, displayName: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/threads/${encodeURIComponent(threadId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: displayName }),
  });
  if (!res.ok) throw new Error(`Failed to rename thread: ${res.status}`);
}
export async function fetchThreadTasks(threadId: string): Promise<Task[]> {
  const res = await fetch(`${BASE_URL}/api/v1/threads/${threadId}/tasks`);
  if (!res.ok) throw new Error(`Failed to fetch tasks: ${res.status}`);
  return res.json();
}

export async function fetchTask(taskId: string): Promise<Task> {
  const res = await fetch(`${BASE_URL}/api/v1/tasks/${taskId}`);
  if (!res.ok) throw new Error(`Failed to fetch task: ${res.status}`);
  return res.json();
}

export async function fetchTaskExchanges(taskId: string): Promise<Exchange[]> {
  const res = await fetch(`${BASE_URL}/api/v1/tasks/${taskId}/exchanges`);
  if (!res.ok) throw new Error(`Failed to fetch exchanges: ${res.status}`);
  return res.json();
}

// ── Security API ─────────────────────────────────────────────────

export async function scanSecurity(runIds?: string[]): Promise<SecurityScanResult> {
  const res = await fetch(`${BASE_URL}/api/v1/security/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ run_ids: runIds || [] }),
  });
  if (!res.ok) throw new Error(`Security scan failed: ${res.status}`);
  return res.json();
}

export async function fetchSecurityEvents(params?: {
  severity?: string;
  run_id?: string;
  acknowledged?: string;
  agent_id?: string;
  limit?: number;
}): Promise<SecurityEvent[]> {
  const qs = new URLSearchParams();
  if (params?.severity) qs.set('severity', params.severity);
  if (params?.run_id) qs.set('run_id', params.run_id);
  if (params?.acknowledged) qs.set('acknowledged', params.acknowledged);
  if (params?.agent_id) qs.set('agent_id', params.agent_id);
  if (params?.limit) qs.set('limit', String(params.limit));
  const url = `${BASE_URL}/api/v1/security/events${qs.toString() ? '?' + qs.toString() : ''}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch security events: ${res.status}`);
  return res.json();
}

export async function fetchSecurityStats(): Promise<SecurityStats> {
  const res = await fetch(`${BASE_URL}/api/v1/security/stats`);
  if (!res.ok) throw new Error(`Failed to fetch security stats: ${res.status}`);
  return res.json();
}

export async function fetchRunSecurityEvents(runId: string): Promise<SecurityEvent[]> {
  const res = await fetch(`${BASE_URL}/api/v1/security/events/run/${runId}`);
  if (!res.ok) throw new Error(`Failed to fetch run security events: ${res.status}`);
  return res.json();
}

export async function acknowledgeSecurityEvent(eventId: string): Promise<SecurityEvent> {
  const res = await fetch(`${BASE_URL}/api/v1/security/events/${eventId}/acknowledge`, {
    method: 'PATCH',
  });
  if (!res.ok) throw new Error(`Failed to acknowledge event: ${res.status}`);
  return res.json();
}

export async function markSecurityEventSafe(eventId: string): Promise<{ ok: boolean; marked_safe: boolean }> {
  const res = await fetch(`${BASE_URL}/api/v1/security/events/${eventId}/mark-safe`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Failed to mark event safe: ${res.status}`);
  return res.json();
}

// ── SSE ──────────────────────────────────────────────────────────

export function createSSEConnection(
  onEvent: (event: ClawEvent) => void,
  onError?: () => void
): () => void {
  const url = `${BASE_URL}/api/v1/events/stream`;
  const source = new EventSource(url);

  source.onmessage = (msg) => {
    try {
      const event: ClawEvent = JSON.parse(msg.data);
      onEvent(event);
    } catch {
      // ignore malformed events
    }
  };

  source.onerror = () => {
    if (onError) onError();
  };

  return () => source.close();
}
