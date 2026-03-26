// ── API client + SSE connection layer ────────────────────────────

import type { ClawEvent, Run, Agent, Thread, Task, Exchange } from './types';

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
