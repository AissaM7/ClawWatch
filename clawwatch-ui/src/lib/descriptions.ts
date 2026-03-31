// ── Event description builder — pure string interpolation ────────

import type { ClawEvent } from './types';

export function buildDescription(event: ClawEvent): string {
  switch (event.event_type) {
    case 'agent_start':
      return `Agent started: ${event.agent_name} — "${(event.goal || '').substring(0, 80)}"`;

    case 'agent_end':
      return `Agent ${event.status || 'ended'}${event.error_message ? ` — ${event.error_message.substring(0, 100)}` : ''}`;

    case 'tool_call_start': {
      // Try to extract meaningful info from args
      let detail = '';
      if (event.tool_args) {
        try {
          const args = JSON.parse(event.tool_args);
          if (typeof args === 'object' && args !== null) {
            // Look for URL-like args
            for (const val of Object.values(args)) {
              if (typeof val === 'string' && val.startsWith('http')) {
                detail = val.substring(0, 100);
                break;
              }
              if (typeof val === 'string' && val.includes('/')) {
                detail = val.substring(0, 100);
                break;
              }
            }
            if (!detail) {
              detail = JSON.stringify(args).substring(0, 80);
            }
          }
        } catch {
          detail = event.tool_args.substring(0, 60);
        }
      }
      return `${event.tool_name || 'unknown'}(${detail})`;
    }

    case 'tool_call_end':
      return `${event.tool_name || 'unknown'} completed${event.duration_ms ? ` in ${event.duration_ms}ms` : ''}`;

    case 'tool_error':
      return `${event.tool_name || 'unknown'} error: ${(event.error_message || event.error_type || 'unknown error').substring(0, 100)}`;

    case 'llm_call_start':
      return `LLM call → ${event.model || 'unknown'}${event.input_tokens ? ` (${event.input_tokens.toLocaleString()} tokens)` : ''}`;

    case 'llm_call_end':
      return `LLM response ← ${event.model || 'unknown'} ${event.output_tokens ? `${event.output_tokens.toLocaleString()} tokens` : ''}${event.duration_ms ? ` in ${(event.duration_ms / 1000).toFixed(1)}s` : ''}`;

    case 'llm_error':
      return `LLM error: ${event.model || 'unknown'} — ${(event.error_message || '').substring(0, 100)}`;

    // ── File I/O ──
    case 'file_read':
      return `Reading ${safeArg(event, 'file_path') || event.tool_name || 'file'}`;
    case 'file_write':
      return `Writing → ${safeArg(event, 'file_path') || event.tool_name || 'file'}`;

    // ── Code Execution ──
    case 'code_executed':
      return `Executing: ${(safeArg(event, 'command') || event.tool_name || 'command').substring(0, 100)}`;

    // ── Web / Browser ──
    case 'browser_navigate':
      return `Navigating to ${safeArg(event, 'url') || event.tool_name || 'page'}`;
    case 'browser_screenshot':
      return `Screenshot captured`;
    case 'knowledge_retrieval':
      return `Searching: "${safeArg(event, 'query') || ''}"`;
    case 'api_call':
      return `API call: ${event.tool_name || 'external'}`;

    // ── Reasoning ──
    case 'thinking_start':
      return `Reasoning started`;
    case 'thinking_end':
      return `Reasoning complete (${(event.llm_output_full || '').length} chars)`;
    case 'plan_created': {
      const steps = safeResult(event, 'step_count');
      return `Plan created${steps ? ` (${steps} steps)` : ''}`;
    }
    case 'decision_point':
      return `Decision: "${(event.llm_output_full || '').substring(0, 100)}"`;

    // ── Message Lifecycle ──
    case 'message_draft':
      return `Drafting response → ${safeArg(event, 'channel') || 'channel'}`;
    case 'message_delivered':
      return `Message delivered → ${safeResult(event, 'channel') || 'channel'}`;
    case 'message_failed':
      return `Message delivery failed: ${(event.error_message || '').substring(0, 100)}`;
    case 'channel_switch':
      return `Channel switched: ${safeArg(event, 'previous_channel')} → ${safeArg(event, 'new_channel')}`;
    case 'agent_response':
      return `Agent replied: "${(event.llm_output_full || '').substring(0, 120)}"`;

    // ── Cost & Performance ──
    case 'token_usage': {
      const inp = safeArg(event, 'input_tokens') || event.input_tokens || 0;
      const out = safeArg(event, 'output_tokens') || event.output_tokens || 0;
      return `Tokens: ${Number(inp).toLocaleString()} in / ${Number(out).toLocaleString()} out`;
    }
    case 'latency_warning':
      return `Slow operation: ${event.tool_name} took ${((event.duration_ms || 0) / 1000).toFixed(1)}s`;
    case 'context_window_usage':
      return `Context window: ~${(Number(safeArg(event, 'estimated_tokens')) || 0).toLocaleString()} tokens used`;
    case 'rate_limit_hit':
      return `Rate limit hit: ${event.model || 'provider'}`;

    // ── Retry & Recovery ──
    case 'llm_retry':
      return `LLM retry: ${event.model || 'model'}`;
    case 'tool_retry':
      return `Tool retry: ${event.tool_name || 'tool'}`;
    case 'fallback_triggered':
      return `Fallback: ${safeArg(event, 'previous_model')} → ${safeArg(event, 'new_model')}`;
    case 'checkpoint_saved':
      return `State saved`;

    // ── Safety ──
    case 'content_filtered':
      return `Content filtered by safety policy`;
    case 'pii_detected':
      return `PII detected: ${safeArg(event, 'pii_types') || 'sensitive data'}`;
    case 'tool_blocked':
      return `Tool blocked: ${event.tool_name || 'tool'}`;
    case 'permission_escalation':
      return `Permission escalation: ${event.tool_name || 'action'}`;
    case 'human_approval_requested':
      return `Approval requested for: ${event.tool_name || 'action'}`;
    case 'human_approval_received':
      return `Approval received for: ${event.tool_name || 'action'}`;
    case 'handoff_to_human':
      return `Handed off to human operator`;

    // ── Multi-Agent ──
    case 'subagent_delegated':
      return `Task delegated → ${safeArg(event, 'target') || 'subagent'}`;
    case 'subagent_result_received':
      return `Subagent result received`;
    case 'agent_collaboration':
      return `Agent-to-agent communication`;

    // ── Memory ──
    case 'memory_read':
      return `Memory recall: ${event.tool_name || 'knowledge'}`;
    case 'memory_write':
      return `Memory stored`;

    // ── Compaction ──
    case 'compaction_start':
      return `Compacting session context...`;
    case 'compaction_end':
      return `Compaction complete`;
    case 'context_truncated':
      return `Context truncated (compaction)`;

    // ── Session ──
    case 'session_start':
      return `Session started`;
    case 'session_end':
      return `Session ended`;
    case 'model_resolve':
      return `Model resolved`;
    case 'tool_result_persist':
      return `Tool result persisted`;

    case 'agent_error':
      return `Agent failed (${event.error_type || 'error'}): ${(event.error_message || 'unknown error').substring(0, 200)}`;

    case 'user_prompt':
      return `"${(event.prompt_preview || event.goal || '').substring(0, 120)}"`;

    default:
      return event.event_type;
  }
}

/** Safely parse a value from tool_args JSON */
function safeArg(event: ClawEvent, key: string): string {
  try {
    const args = JSON.parse(event.tool_args || '{}');
    return String(args[key] || '');
  } catch {
    return '';
  }
}

/** Safely parse a value from tool_result JSON */
function safeResult(event: ClawEvent, key: string): string {
  try {
    const result = JSON.parse(event.tool_result || '{}');
    return String(result[key] || '');
  } catch {
    return '';
  }
}

export function formatOffset(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `+${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
