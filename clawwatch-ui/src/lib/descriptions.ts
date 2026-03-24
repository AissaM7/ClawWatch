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

    case 'file_read':
      return `Reading ${event.file_path || 'unknown'}${event.file_size_bytes ? ` (${formatBytes(event.file_size_bytes)})` : ''}`;

    case 'file_write':
      return `Writing → ${event.file_path || 'unknown'}${event.file_size_bytes ? ` (${formatBytes(event.file_size_bytes)})` : ''}`;

    case 'file_delete':
      return `Deleting ${event.file_path || 'unknown'}`;

    case 'network_request':
      return `${(event.method || 'GET').toUpperCase()} ${event.url || 'unknown'}`;

    case 'network_response':
      return `← ${event.response_status || '???'} ${event.url || ''}${event.duration_ms ? ` in ${event.duration_ms}ms` : ''}`;

    case 'subprocess_exec': {
      let cmd = '';
      try {
        const tokens: string[] = JSON.parse(event.command_tokens || '[]');
        cmd = tokens.join(' ');
      } catch {
        cmd = event.command_tokens || '';
      }
      return `Shell: ${cmd.substring(0, 120)}${event.exit_code !== undefined && event.exit_code !== 0 ? ` (exit ${event.exit_code})` : ''}`;
    }

    case 'env_access':
      return `Read env var: ${event.env_var_name || 'unknown'}`;

    case 'loop_detected':
      return `Loop detected: ${event.tool_name} called ${event.repeat_count}× with identical args`;

    case 'review_note':
      return 'Review note added';

    case 'user_prompt':
      return `"${(event.prompt_preview || event.goal || '').substring(0, 120)}"`;

    case 'agent_response':
      return `Agent replied: "${(event.llm_output_full || '').substring(0, 120)}"`;


    default:
      return event.event_type;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function formatOffset(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `+${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
