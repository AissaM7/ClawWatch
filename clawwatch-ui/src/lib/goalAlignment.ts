// ── Goal Alignment Scoring — pure TypeScript, deterministic ──────

import type { ClawEvent, GoalAlignmentResult } from './types';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'this', 'that',
  'will', 'with', 'from', 'they', 'which', 'their', 'what', 'about', 'would',
  'make', 'like', 'just', 'over', 'such', 'take', 'into', 'than', 'them',
  'very', 'some', 'could', 'when', 'where', 'should', 'each', 'does', 'then',
]);

function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 4 && !STOPWORDS.has(t));
  return new Set(tokens);
}

// Base scores by event type
const TYPE_BASE_SCORES: Record<string, number> = {
  tool_call_start: 50,
  tool_call_end: 60,
  tool_error: 30,
  file_write: 65,
  file_read: 55,
  file_delete: 40,
  network_request: 50,
  network_response: 50,
  subprocess_exec: 45,
  llm_call_start: 55,
  llm_call_end: 55,
  llm_error: 20,
  agent_start: 80,
  agent_end: 80,
  env_access: 30,
  loop_detected: 0,
};

function getPayloadText(event: ClawEvent): string {
  const parts: string[] = [];
  if (event.tool_args) parts.push(event.tool_args);
  if (event.tool_result) parts.push(event.tool_result);
  if (event.tool_name) parts.push(event.tool_name);
  if (event.file_path) parts.push(event.file_path);
  if (event.url) parts.push(event.url);
  if (event.command_tokens) parts.push(event.command_tokens);
  if (event.prompt_preview) parts.push(event.prompt_preview);
  if (event.env_var_name) parts.push(event.env_var_name);
  return parts.join(' ');
}

export function scoreGoalAlignment(event: ClawEvent, goalText: string): GoalAlignmentResult {
  if (!goalText || goalText.trim().length === 0) {
    return { score: 50, is_on_goal: true, matched_tokens: [] };
  }

  const goalTokens = tokenize(goalText);
  if (goalTokens.size === 0) {
    return { score: 50, is_on_goal: true, matched_tokens: [] };
  }

  const payloadText = getPayloadText(event).toLowerCase();
  const matched: string[] = [];

  for (const token of goalTokens) {
    if (payloadText.includes(token)) {
      matched.push(token);
    }
  }

  // Overlap score: proportion of goal tokens found in payload
  const overlap = matched.length / goalTokens.size;
  const overlapScore = overlap * 60; // 0-60 from overlap

  // Base type score
  const baseScore = (TYPE_BASE_SCORES[event.event_type] || 30) * 0.4; // 0-32 from type

  let score = overlapScore + baseScore;

  // Penalties
  if (event.event_type === 'loop_detected') score = 0;
  if (event.event_type === 'tool_error' || event.event_type === 'llm_error') {
    score = Math.max(0, score - 20);
  }

  score = Math.min(100, Math.max(0, Math.round(score)));

  return {
    score,
    is_on_goal: score >= 50,
    matched_tokens: matched,
  };
}

export function computeGoalDrift(events: GoalAlignmentResult[]): number {
  if (events.length === 0) return 0;
  const offGoal = events.filter(e => !e.is_on_goal).length;
  return (offGoal / events.length) * 100;
}
