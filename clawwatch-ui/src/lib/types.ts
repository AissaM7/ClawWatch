// ── ClawWatch Data Types ─────────────────────────────────────────

export type EventType =
  | 'agent_start' | 'agent_end'
  | 'tool_call_start' | 'tool_call_end' | 'tool_error'
  | 'llm_call_start' | 'llm_call_end' | 'llm_error'
  | 'file_read' | 'file_write' | 'file_delete'
  | 'network_request' | 'network_response'
  | 'subprocess_exec' | 'env_access'
  | 'loop_detected' | 'review_note' | 'user_prompt' | 'agent_response';

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
