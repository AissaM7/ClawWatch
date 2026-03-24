// ── API client + SSE connection layer ────────────────────────────

import type { ClawEvent, Run } from './types';

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
