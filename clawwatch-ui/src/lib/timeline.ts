// ── Timeline Hierarchy Builder ───────────────────────────────────
// Derives Task → Exchange → Event hierarchy from flat event list.
// Pure client-side computation — no backend changes required.

import type { EnrichedEvent, RiskLevel } from './types';
import { estimateCost } from './cost';

// ── Types ────────────────────────────────────────────────────────

export interface ExchangeBlock {
  exchangeIndex: number;        // 1-indexed within task
  userMessage: string;
  userMessageOffsetMs: number;
  agentResponse: string | null;
  events: EnrichedEvent[];      // all events in this exchange (excluding the prompt itself)
  latencyMs: number;            // time to first agent action after user message
  durationMs: number;
  llmCalls: number;
  toolCalls: number;
  costUsd: number;
  riskScore: number;
  highestRiskLevel: RiskLevel;
  goalAlignmentPct: number;
}

export type TaskStatus = 'active' | 'completed' | 'abandoned' | 'error';

export interface TaskBlock {
  taskIndex: number;            // 1-indexed
  status: TaskStatus;
  openingPrompt: string;
  startOffsetMs: number;
  endOffsetMs: number;
  durationMs: number;
  gapFromPreviousMs: number;    // gap from end of previous task (0 for first)
  exchanges: ExchangeBlock[];
  // aggregate metrics
  llmCalls: number;
  toolCalls: number;
  errorCount: number;
  costUsd: number;
  goalAlignmentPct: number;
  highestRiskLevel: RiskLevel;
}

export interface TimelineHierarchy {
  tasks: TaskBlock[];
  totalTasks: number;
}

// ── Constants ────────────────────────────────────────────────────

const TASK_GAP_THRESHOLD_MS = 60_000; // 60 seconds gap = new task

// ── Risk level ordering ──────────────────────────────────────────

const RISK_ORDER: RiskLevel[] = ['safe', 'low', 'medium', 'high', 'critical'];

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

// ── Extract prompt text from an event ────────────────────────────

function extractPromptText(event: EnrichedEvent, allEvents: EnrichedEvent[], eventIdx: number): string {
  // user_prompt events carry text in prompt_preview or goal
  if (event.event_type === 'user_prompt') {
    const text = event.prompt_preview || event.goal || '';
    // Skip debug-only prompts
    if (text.startsWith('[keys:')) return '';
    return text;
  }
  // For llm_call_start, try to get prompt context
  if (event.prompt_preview && event.prompt_preview !== '""' && event.prompt_preview.length > 2) {
    return event.prompt_preview;
  }
  if (event.goal && event.goal.length > 2) {
    return event.goal;
  }
  // Look at tool_call_start events to infer the prompt
  const hints: string[] = [];
  for (let j = eventIdx + 1; j < allEvents.length && j <= eventIdx + 5; j++) {
    const ev = allEvents[j];
    if (!ev || ev.event_type === 'llm_call_end' || ev.event_type === 'llm_call_start') break;
    if (ev.event_type === 'tool_call_start' && ev.tool_args) {
      try {
        const args = JSON.parse(ev.tool_args);
        if (args.query) { hints.push(args.query); continue; }
        if (args.content) { hints.push(args.content.slice(0, 80)); continue; }
        if (args.command) { hints.push(args.command); continue; }
        if (args.file_path || args.path) { hints.push(args.file_path || args.path); continue; }
      } catch { /* skip */ }
    }
  }
  return hints.length > 0 ? hints.slice(0, 2).join(', ') : 'User prompt';
}

// ── Detect agent response text ───────────────────────────────────

function findAgentResponse(events: EnrichedEvent[]): string | null {
  // Find the last llm_call_end in this exchange
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event_type === 'llm_call_end' && e.llm_output_full) {
      return e.llm_output_full.slice(0, 8192);
    }
  }
  return null;
}

// ── Build exchange metrics ───────────────────────────────────────

function buildExchange(
  exchangeIndex: number,
  userMessage: string,
  userMessageOffsetMs: number,
  events: EnrichedEvent[],
): ExchangeBlock {
  let llmCalls = 0;
  let toolCalls = 0;
  let costUsd = 0;
  let riskScore = 0;
  let highestRiskLevel: RiskLevel = 'safe';
  let onGoalCount = 0;

  for (const e of events) {
    if (e.event_type === 'llm_call_end') {
      llmCalls++;
      costUsd += estimateCost(e.model || '', e.input_tokens || 0, e.output_tokens || 0);
    }
    if (e.event_type === 'tool_call_start') toolCalls++;
    if (e.risk.score > riskScore) riskScore = e.risk.score;
    highestRiskLevel = maxRisk(highestRiskLevel, e.risk.level);
    if (e.goal_alignment.is_on_goal) onGoalCount++;
  }

  const goalAlignmentPct = events.length > 0
    ? Math.round((onGoalCount / events.length) * 100) : 0;

  const firstEventOffset = events.length > 0 ? events[0].run_offset_ms : userMessageOffsetMs;
  const lastEventOffset = events.length > 0
    ? events[events.length - 1].run_offset_ms : userMessageOffsetMs;
  const latencyMs = firstEventOffset - userMessageOffsetMs;
  const durationMs = lastEventOffset - userMessageOffsetMs;
  const agentResponse = findAgentResponse(events);

  return {
    exchangeIndex,
    userMessage,
    userMessageOffsetMs,
    agentResponse,
    events,
    latencyMs: Math.max(0, latencyMs),
    durationMs: Math.max(0, durationMs),
    llmCalls,
    toolCalls,
    costUsd,
    riskScore,
    highestRiskLevel,
    goalAlignmentPct,
  };
}

// ── Determine task status ────────────────────────────────────────

function determineTaskStatus(events: EnrichedEvent[], isLast: boolean): TaskStatus {
  const hasError = events.some(e =>
    e.event_type === 'tool_error' || e.event_type === 'llm_error'
  );
  const hasAgentEnd = events.some(e => e.event_type === 'agent_end');
  const agentEndEvent = events.find(e => e.event_type === 'agent_end');

  if (hasError && agentEndEvent?.status === 'error') return 'error';
  if (isLast && !hasAgentEnd) return 'active';
  if (hasAgentEnd) return 'completed';
  return 'completed';
}

// ── Main builder ─────────────────────────────────────────────────

export function buildTimeline(enrichedEvents: EnrichedEvent[]): TimelineHierarchy {
  if (enrichedEvents.length === 0) {
    return { tasks: [], totalTasks: 0 };
  }

  // Step 1: Split events into task groups by time gaps
  const taskEventGroups: EnrichedEvent[][] = [[]];
  const taskGaps: number[] = [0];

  for (let i = 0; i < enrichedEvents.length; i++) {
    const event = enrichedEvents[i];
    if (i > 0) {
      const prev = enrichedEvents[i - 1];
      const gap = event.run_offset_ms - prev.run_offset_ms;
      if (gap >= TASK_GAP_THRESHOLD_MS) {
        taskEventGroups.push([]);
        taskGaps.push(gap);
      }
    }
    taskEventGroups[taskEventGroups.length - 1].push(event);
  }

  // Step 2: For each task group, split into exchanges
  const tasks: TaskBlock[] = taskEventGroups.map((taskEvents, taskIdx) => {
    const exchanges: ExchangeBlock[] = [];
    let currentExchangeEvents: EnrichedEvent[] = [];
    let currentPromptText = '';
    let currentPromptOffset = taskEvents[0].run_offset_ms;
    let exchangeCounter = 0;
    let needsPromptForSynthesis = true;

    for (let i = 0; i < taskEvents.length; i++) {
      const event = taskEvents[i];

      // Check if this event opens a new exchange
      const isUserPrompt = event.event_type === 'user_prompt';
      const isLlmStart = event.event_type === 'llm_call_start';
      const shouldOpenExchange = isUserPrompt || (needsPromptForSynthesis && isLlmStart);

      if (shouldOpenExchange) {
        // Close previous exchange if it has events
        if (exchangeCounter > 0 || currentExchangeEvents.length > 0) {
          if (exchangeCounter > 0) {
            exchanges.push(buildExchange(
              exchangeCounter,
              currentPromptText,
              currentPromptOffset,
              currentExchangeEvents,
            ));
          }
          currentExchangeEvents = [];
        }

        exchangeCounter++;
        const promptText = extractPromptText(event, taskEvents, i);
        if (promptText) {
          currentPromptText = promptText;
          currentPromptOffset = event.run_offset_ms;
          needsPromptForSynthesis = false;

          // Don't add user_prompt events to the regular event list
          if (isUserPrompt) continue;
        }
      }

      // If we haven't opened any exchange yet (events before first prompt),
      // create an implicit first exchange
      if (exchangeCounter === 0) {
        exchangeCounter = 1;
        currentPromptText = event.goal || 'Agent activity';
        currentPromptOffset = event.run_offset_ms;
        needsPromptForSynthesis = false;
      }

      currentExchangeEvents.push(event);
    }

    // Close final exchange
    if (exchangeCounter > 0) {
      exchanges.push(buildExchange(
        exchangeCounter,
        currentPromptText,
        currentPromptOffset,
        currentExchangeEvents,
      ));
    }

    // Build task metrics
    const allTaskEvents = taskEvents.filter(e => e.event_type !== 'user_prompt');
    let llmCalls = 0;
    let toolCalls = 0;
    let errorCount = 0;
    let costUsd = 0;
    let onGoalCount = 0;
    let highestRiskLevel: RiskLevel = 'safe';

    for (const e of allTaskEvents) {
      if (e.event_type === 'llm_call_end') {
        llmCalls++;
        costUsd += estimateCost(e.model || '', e.input_tokens || 0, e.output_tokens || 0);
      }
      if (e.event_type === 'tool_call_start') toolCalls++;
      if (e.event_type === 'tool_error' || e.event_type === 'llm_error') errorCount++;
      if (e.goal_alignment.is_on_goal) onGoalCount++;
      highestRiskLevel = maxRisk(highestRiskLevel, e.risk.level);
    }

    const goalAlignmentPct = allTaskEvents.length > 0
      ? Math.round((onGoalCount / allTaskEvents.length) * 100) : 0;

    const startOffsetMs = taskEvents[0].run_offset_ms;
    const endOffsetMs = taskEvents[taskEvents.length - 1].run_offset_ms;
    const isLast = taskIdx === taskEventGroups.length - 1;

    return {
      taskIndex: taskIdx + 1,
      status: determineTaskStatus(taskEvents, isLast),
      openingPrompt: exchanges.length > 0 ? exchanges[0].userMessage : (taskEvents[0].goal || 'Agent task'),
      startOffsetMs,
      endOffsetMs,
      durationMs: endOffsetMs - startOffsetMs,
      gapFromPreviousMs: taskGaps[taskIdx],
      exchanges,
      llmCalls,
      toolCalls,
      errorCount,
      costUsd,
      goalAlignmentPct,
      highestRiskLevel,
    };
  });

  return { tasks, totalTasks: tasks.length };
}

// ── Format helpers ───────────────────────────────────────────────

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatGap(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${minutes}m`;
}
