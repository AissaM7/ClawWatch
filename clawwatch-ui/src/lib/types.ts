// ── ClawWatch Data Types ─────────────────────────────────────────

export type EventType =
  | 'agent_start' | 'agent_end' | 'agent_error'
  | 'tool_call_start' | 'tool_call_end' | 'tool_error'
  | 'llm_call_start' | 'llm_call_end' | 'llm_error'
  | 'file_read' | 'file_write' | 'file_delete'
  | 'network_request' | 'network_response'
  | 'subprocess_exec' | 'env_access'
  | 'loop_detected' | 'review_note' | 'user_prompt' | 'agent_response'
  // Semantic: Tool Classification
  | 'code_executed' | 'browser_navigate' | 'browser_screenshot'
  | 'knowledge_retrieval' | 'api_call'
  | 'memory_read' | 'memory_write'
  // Semantic: Reasoning & Planning
  | 'thinking_start' | 'thinking_end'
  | 'plan_created' | 'plan_step_start' | 'plan_step_end'
  | 'decision_point'
  // Semantic: Message Lifecycle
  | 'message_draft' | 'message_delivered' | 'message_failed' | 'channel_switch'
  // Semantic: Performance & Cost
  | 'token_usage' | 'latency_warning' | 'context_window_usage' | 'rate_limit_hit'
  // Semantic: Retry & Recovery
  | 'llm_retry' | 'tool_retry' | 'fallback_triggered' | 'checkpoint_saved'
  // Semantic: Safety & Guardrails
  | 'content_filtered' | 'pii_detected' | 'tool_blocked' | 'permission_escalation'
  | 'human_approval_requested' | 'human_approval_received' | 'handoff_to_human'
  // Semantic: Multi-Agent
  | 'subagent_delegated' | 'subagent_result_received' | 'agent_collaboration'
  // Semantic: Context & State
  | 'compaction_start' | 'compaction_end' | 'context_truncated'
  // Session
  | 'session_start' | 'session_end' | 'model_resolve' | 'tool_result_persist';

export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

export interface ClawEvent {
  event_id: string;
  run_id: string;
  agent_name: string;
  goal: string;
  wall_ts: number;
  run_offset_ms: number;
  event_type: EventType;
  sequence_num: number;

  // Tool call
  tool_name?: string;
  tool_args?: string;
  tool_result?: string;
  call_id?: string;
  duration_ms?: number;
  error_type?: string;
  error_message?: string;
  error_traceback?: string;

  // LLM
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  prompt_preview?: string;
  llm_output_full?: string;

  // File
  file_path?: string;
  file_size_bytes?: number;
  is_new_file?: boolean | number;
  is_inside_workdir?: boolean | number;

  // Network
  url?: string;
  method?: string;
  request_body_bytes?: number;
  response_status?: number;
  response_body_bytes?: number;

  // Subprocess
  command_tokens?: string;
  exit_code?: number;
  stdout_preview?: string;
  stderr_preview?: string;

  // Env
  env_var_name?: string;

  // Loop
  arg_hash?: string;
  repeat_count?: number;

  // Agent extras
  status?: string;
  tools_list?: string;
  workdir?: string;

  // Hierarchy (Thread/Task/Exchange)
  thread_id?: string;
  task_id?: string;
  exchange_id?: string;
}

export interface Run {
  run_id: string;
  agent_name: string;
  goal: string;
  started_at: number;
  ended_at: number | null;
  status: string;
  event_count: number;
  db_path: string;
}

export interface RiskResult {
  level: RiskLevel;
  score: number;
  requires_review: boolean;
  rules: RiskRule[];
}

export interface RiskRule {
  name: string;
  level: RiskLevel;
  score: number;
  explanation: string;
}

export interface GoalAlignmentResult {
  score: number;
  is_on_goal: boolean;
  matched_tokens: string[];
}

export type ClaimVerdict = 'supported' | 'unsupported' | 'contradicted';
export type HallucinationConfidence = 'low' | 'medium' | 'high';

export interface Claim {
  phrase: string;
  sentence: string;
  extracted_object: string;
  verdict: ClaimVerdict;
  evidence_event_id?: string;
  explanation: string;
  confidence: HallucinationConfidence;
}

export interface HallucinationReport {
  has_hallucination: boolean;
  confidence: HallucinationConfidence;
  claims: Claim[];
  unsupported_count: number;
  contradicted_count: number;
  llm_event_id: string;
  checked_at_offset_ms: number;
}

// Enriched event with computed scores
export interface EnrichedEvent extends ClawEvent {
  risk: RiskResult;
  goal_alignment: GoalAlignmentResult;
  description: string;
}

// ── Thread / Task / Exchange hierarchy ───────────────────────────

export interface Agent {
  agent_id: string;
  thread_count: number;
  total_tasks: number;
  last_active_at: number;
  total_cost_usd: number;
}

export interface Thread {
  thread_id: string;
  channel: string;
  agent_id: string;
  user_id: string;
  display_name?: string;
  created_at: number;
  last_active_at: number;
  task_count: number;
  total_cost_usd: number;
}

export interface Task {
  task_id: string;
  thread_id: string;
  run_id: string;
  opened_at: number;
  closed_at: number | null;
  duration_ms: number | null;
  status: 'active' | 'completed' | 'abandoned' | 'error';
  opening_prompt: string;
  exchange_count: number;
  llm_call_count: number;
  tool_call_count: number;
  error_count: number;
  total_cost_usd: number;
  goal_alignment_pct: number | null;
  highest_risk_score: number | null;
}

export interface Exchange {
  exchange_id: string;
  task_id: string;
  thread_id: string;
  run_id: string;
  exchange_index: number;
  opened_at: number;
  closed_at: number | null;
  duration_ms: number | null;
  user_message: string;
  user_message_channel: string;
  agent_response: string | null;
  latency_ms: number | null;
  llm_call_count: number;
  tool_call_count: number;
  cost_usd: number;
  risk_score: number | null;
  goal_alignment_pct: number | null;
}
