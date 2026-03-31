/**
 * @clawwatch/openclaw-plugin — Deep Observability for OpenClaw
 *
 * A hook-only OpenClaw plugin that intercepts the full agent execution loop
 * (LLM requests, tool calls, diagnostics) and forwards all events to the
 * ClawWatch local dashboard via HTTP POST.
 *
 * CONCURRENCY MODEL:
 * OpenClaw can run many chat sessions concurrently. Each session has a unique
 * `sessionKey`. This plugin maintains a Map<sessionKey, RunState> so that
 * events from different sessions never leak into each other's ClawWatch runs.
 *
 * Install:
 *   openclaw plugins install ./openclaw-plugin --link
 *   # or from npm:
 *   openclaw plugins install @clawwatch/openclaw-plugin
 *
 * Requires ClawWatch to be running:
 *   clawwatch ui
 */

// ─── Configuration ──────────────────────────────────────────────────
const CLAWWATCH_PORT = process.env.CLAWWATCH_PORT || "8765";
const CLAWWATCH_URL = `http://127.0.0.1:${CLAWWATCH_PORT}/api/v1/ingest`;

// ─── Per-Session State ──────────────────────────────────────────────

interface RunState {
  runId: string;
  seq: number;
  startedAt: number;
}

/** Maps OpenClaw sessionKey → ClawWatch run state */
const sessions = new Map<string, RunState>();

/** Fallback run ID for events with no sessionKey (e.g. gateway:startup) */
let fallbackRunId = crypto.randomUUID();
let fallbackSeq = 0;
let fallbackStartedAt = Date.now();

function getOrCreateRun(sessionKey: string | undefined): RunState {
  if (!sessionKey) {
    return { runId: fallbackRunId, seq: fallbackSeq, startedAt: fallbackStartedAt };
  }
  let state = sessions.get(sessionKey);
  if (!state) {
    state = {
      runId: crypto.randomUUID(),
      seq: 0,
      startedAt: Date.now(),
    };
    sessions.set(sessionKey, state);
  }
  return state;
}

function resetRun(sessionKey: string | undefined): RunState {
  const state: RunState = {
    runId: crypto.randomUUID(),
    seq: 0,
    startedAt: Date.now(),
  };
  if (sessionKey) {
    sessions.set(sessionKey, state);
  } else {
    fallbackRunId = state.runId;
    fallbackSeq = 0;
    fallbackStartedAt = state.startedAt;
  }
  return state;
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Fire-and-forget POST to ClawWatch. Never throws, never blocks. */
function send(payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  fetch(CLAWWATCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(2000),
  }).catch(() => {
    // ClawWatch may not be running — silently ignore
  });
}

/**
 * Strip OpenClaw metadata wrappers from prompt text.
 * OpenClaw prepends "Conversation info (untrusted metadata): ```json {...} ```"
 * and "Sender (untrusted metadata): ```json {...} ```" before the actual user message.
 * This function extracts just the user's text.
 */
function stripOpenClawMetadata(raw: string): string {
  if (!raw) return "";

  // Pattern: everything before the actual user message consists of
  // metadata blocks wrapped in ```json ... ``` fences.
  // Strategy: find the last ``` fence closure and take everything after it.
  let text = raw;

  // Remove all markdown code fence blocks (```...```)
  // These contain the untrusted metadata JSON
  const fencePattern = /```[\s\S]*?```/g;
  const withoutFences = text.replace(fencePattern, "|||FENCE|||");

  // Split by fence markers and metadata labels
  const parts = withoutFences.split("|||FENCE|||");
  if (parts.length > 1) {
    // The actual user message is after the last fence block
    let lastPart = parts[parts.length - 1].trim();

    // Remove any remaining metadata labels like "Sender (untrusted metadata):"
    lastPart = lastPart
      .replace(/^Conversation info\s*\(untrusted metadata\)\s*:?\s*/i, "")
      .replace(/^Sender\s*\(untrusted metadata\)\s*:?\s*/i, "")
      .trim();

    if (lastPart.length > 0) {
      return lastPart;
    }
  }

  // Fallback: try to find text after the last ``` in the original
  const lastFenceIdx = raw.lastIndexOf("```");
  if (lastFenceIdx > 0) {
    const afterFence = raw.substring(lastFenceIdx + 3).trim();
    // Remove remaining metadata labels
    const cleaned = afterFence
      .replace(/^Sender\s*\(untrusted metadata\)\s*:?\s*/i, "")
      .replace(/^Conversation info\s*\(untrusted metadata\)\s*:?\s*/i, "")
      .trim();
    if (cleaned.length > 0) {
      return cleaned;
    }
  }

  // No metadata detected, return as-is
  return raw.trim();
}

/**
 * Build a base event tied to a specific session.
 * Resolves the correct run_id from the session map to prevent cross-session leaking.
 */
function baseEvent(
  eventType: string,
  sessionKey: string | undefined
): Record<string, unknown> {
  const run = getOrCreateRun(sessionKey);
  run.seq++;
  // Persist the incremented seq for non-fallback sessions
  if (!sessionKey) {
    fallbackSeq = run.seq;
  }

  return {
    event_id: crypto.randomUUID(),
    run_id: run.runId,
    agent_name: "openclaw",
    goal: "",
    wall_ts: Date.now() / 1000,
    run_offset_ms: Date.now() - run.startedAt,
    event_type: eventType,
    sequence_num: run.seq,
  };
}

/**
 * Build a base event from an EXISTING RunState.
 * Unlike baseEvent(), this NEVER creates a new run — it reuses a known run.
 * Use this for lifecycle-ending events (agent_end, subagent_ended) to prevent
 * orphan runs when the session has already been partially cleaned up.
 */
function baseEventFromRun(
  eventType: string,
  run: RunState
): Record<string, unknown> {
  run.seq++;
  return {
    event_id: crypto.randomUUID(),
    run_id: run.runId,
    agent_name: "openclaw",
    goal: "",
    wall_ts: Date.now() / 1000,
    run_offset_ms: Date.now() - run.startedAt,
    event_type: eventType,
    sequence_num: run.seq,
  };
}

// ─── Session Cleanup ────────────────────────────────────────────────

/** Evict sessions older than 4 hours to prevent unbounded memory growth */
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;

function cleanupStaleSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [key, state] of sessions) {
    if (state.startedAt < cutoff) {
      sessions.delete(key);
    }
  }
}

// Run cleanup every 30 minutes
setInterval(cleanupStaleSessions, 30 * 60 * 1000).unref?.();

// ─── Semantic Event Classification ──────────────────────────────────

/**
 * Maps an OpenClaw tool name to zero or more semantic event types.
 * These are emitted IN ADDITION TO the standard tool_call_start/end events.
 * Only returns types when there's a confident match — no guessing.
 */
function classifyToolStart(toolName: string, args: any): string | null {
  const name = toolName.toLowerCase();

  // File I/O
  if (name === "read" || name === "readfile" || name === "cat")
    return "file_read";
  if (name === "write" || name === "writefile" || name === "edit" || name === "multiedit" || name === "patch")
    return "file_write";

  // Code execution
  if (name === "exec" || name === "bash" || name === "shell" || name === "execute_command" || name === "python" || name === "run")
    return "code_executed";

  // Web browsing
  if (name === "web_fetch" || name === "browse" || name === "navigate" || name === "scrape")
    return "browser_navigate";
  // Screenshot capture
  if (name === "screenshot" || name === "capture" || name === "screen_capture")
    return "browser_screenshot";

  // Knowledge retrieval (web search, RAG)
  if (name === "web_search" || name === "search" || name === "rag" || name === "vector_search")
    return "knowledge_retrieval";

  // Memory operations
  if (name === "memory_get" || name === "memory_search" || name === "memory_recall" || name === "remember_get")
    return "memory_read";
  if (name === "memory_set" || name === "memory_save" || name === "memory_write" || name === "remember_set")
    return "memory_write";

  // Multi-agent: delegation
  if (name === "sessions_spawn" || name === "subagent_spawn" || name === "spawn_agent" || name === "delegate")
    return "subagent_delegated";

  // Multi-agent: collaboration (messaging between agents)
  if (name === "sessions_send" || name === "sessions_yield" || name === "agent_send")
    return "agent_collaboration";

  // Multi-agent: queries about other agents
  if (name === "sessions_list" || name === "sessions_history" || name === "session_status" || name === "subagents")
    return "agent_collaboration";

  // External API calls (generic HTTP tools)
  if (name === "http" || name === "api_call" || name === "fetch" || name === "request" || name === "curl")
    return "api_call";

  return null;
}

/**
 * Classify a tool call END to detect result-level semantic events.
 */
function classifyToolEnd(
  toolName: string,
  error: any,
  durationMs: number
): string[] {
  const events: string[] = [];
  const name = toolName.toLowerCase();

  // Subagent result received
  if (name === "sessions_spawn" || name === "subagent_spawn" || name === "delegate")
    events.push("subagent_result_received");

  // Latency warning: tool took > 30 seconds (web searches naturally take 15-20s)
  if (durationMs > 30000)
    events.push("latency_warning");

  // Content filtering: detect safety blocks in results
  if (error) {
    const errStr = typeof error === "string" ? error : (error.message || String(error));
    if (/content.?filter|safety|blocked|harmful|moderation/i.test(errStr))
      events.push("content_filtered");
    if (/permission|unauthorized|forbidden|access denied/i.test(errStr))
      events.push("permission_escalation");
    if (/blocked.*policy|policy.*block|tool.*blocked/i.test(errStr))
      events.push("tool_blocked");
  }

  return events;
}

/**
 * Analyze LLM output text for reasoning patterns.
 * Returns semantic events to emit based on content analysis.
 * Uses strict pattern matching to avoid false positives.
 */
function analyzeLlmOutput(text: string): Array<{ type: string; detail: string }> {
  const events: Array<{ type: string; detail: string }> = [];
  if (!text || text.length < 10) return events;

  // Detect <thinking> blocks (explicit chain-of-thought)
  const thinkingMatch = text.match(/<thinking>([\s\S]*?)<\/thinking>/i);
  if (thinkingMatch) {
    events.push({
      type: "thinking",
      detail: thinkingMatch[1].trim().slice(0, 2048),
    });
  }

  // Detect numbered plan/step lists (3+ numbered steps)
  // Pattern: lines starting with "1.", "2.", "3." etc.
  const planLines = text.match(/^\s*\d+\.\s+.+$/gm);
  if (planLines && planLines.length >= 3) {
    events.push({
      type: "plan_created",
      detail: planLines.map(l => l.trim()).join("\n").slice(0, 2048),
    });
  }

  // Detect explicit decision statements
  // Only match clear decision language to avoid false positives
  const decisionPatterns = [
    /\bI(?:'ll| will) (?:use|try|choose|go with|switch to|opt for)\b/i,
    /\bInstead of .+, I(?:'ll| will)\b/i,
    /\bI (?:decided|chose) to\b/i,
    /\bLet me (?:try|use|switch to)\b/i,
  ];
  for (const pattern of decisionPatterns) {
    const match = text.match(pattern);
    if (match) {
      // Extract the sentence containing the decision
      const sentenceStart = Math.max(0, text.lastIndexOf(".", match.index! - 1) + 1);
      const sentenceEnd = text.indexOf(".", match.index! + match[0].length);
      const sentence = text.slice(sentenceStart, sentenceEnd > 0 ? sentenceEnd + 1 : sentenceStart + 200).trim();
      events.push({
        type: "decision_point",
        detail: sentence.slice(0, 500),
      });
      break; // Only report first decision per output
    }
  }

  return events;
}

/**
 * Simple PII pattern detection.
 * Returns detected PII types (not the actual PII values — we don't store them).
 */
function detectPII(text: string): string[] {
  if (!text || text.length < 5) return [];
  const found: string[] = [];

  // Email addresses
  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text))
    found.push("email");

  // US Phone numbers (various formats)
  if (/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/.test(text))
    found.push("phone");

  // SSN patterns
  if (/\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/.test(text))
    found.push("ssn");

  // Credit card patterns (basic)
  if (/\b(?:\d{4}[-.\s]?){3}\d{4}\b/.test(text))
    found.push("credit_card");

  return found;
}

// ─── Performance Tracking State ─────────────────────────────────────

/** Track last model used per session for fallback detection */
const lastModelPerSession = new Map<string, string>();

/** Track last tool + args per session for retry detection */
const lastToolCallPerSession = new Map<string, { tool: string; args: string; ts: number }>();

/** Track last LLM prompt per session for retry detection */
const lastLlmPromptPerSession = new Map<string, { prompt: string; ts: number }>();

/** Track channel per session for channel switch detection */
const lastChannelPerSession = new Map<string, string>();

// ─── Plugin Entry ───────────────────────────────────────────────────

export default {
  id: "clawwatch",

  register(api: any) {
    // ──────────────────────────────────────────────────────────────
    // Phase 1: Infrastructure — command & message events via hooks
    // ──────────────────────────────────────────────────────────────

    // before_agent_start — fires when a new agent run begins.
    // Creates a new run scoped to sessionKey, emits agent_start event.
    api.on("before_agent_start", async (event: any, ctx: any) => {
      const sk = ctx?.sessionKey || event?.sessionKey;
      const existing = sk ? sessions.get(sk) : undefined;
      if (existing) {
        // Session already has a run — skip duplicate creation.
        return;
      }
      // Create a new run for this session
      const run = resetRun(sk);
      send({
        ...baseEvent("agent_start", sk),
        run_id: run.runId,
        agent_name: "openclaw",
        goal: "",
        status: "running",
      });
    });

    // before_reset — fires when session is being reset.
    // End current run, start a fresh one.
    api.on("before_reset", async (event: any, ctx: any) => {
      const sk = ctx?.sessionKey || event?.sessionKey;
      send({
        ...baseEvent("agent_end", sk),
        status: "reset",
      });
      // Start a fresh run for this session
      const run = resetRun(sk);
      send({
        ...baseEvent("agent_start", sk),
        run_id: run.runId,
        agent_name: "openclaw",
        goal: "session reset",
        status: "running",
      });
    });

    // gateway:startup — intentionally NOT emitting agent_start.
    // The gateway is infrastructure, not an agent. Its lifecycle events
    // should not create agent run records in ClawWatch.

    // message_received — emit user_prompt event with full message text.
    // Does NOT create a new run — runs are only created by before_agent_start.
    api.on("message_received", async (event: any, ctx: any) => {
      const sk = ctx?.sessionKey || event?.sessionKey;
      const content = event?.content || event?.text || "";
      const channel = ctx?.channelId || event?.channelId || "unknown";
      const userId = event?.from || event?.userId || "unknown";

      if (content) {
        // Emit a user_prompt event — this is the primary record of the user's message
        send({
          ...baseEvent("user_prompt", sk),
          prompt_preview: content.slice(0, 2048),
          goal: content.slice(0, 200),
          tool_name: `user:${channel}`,
          tool_args: JSON.stringify({
            channel,
            user_id: userId,
            direction: "inbound",
            full_message: content,
          }),
        });
      }
    });

    // message_sent — captures messages after they are delivered to the channel.
    api.on("message_sent", async (event: any, ctx: any) => {
      const sk = ctx?.sessionKey || event?.sessionKey;
      const sessionId = sk || "__fallback__";
      const content = event?.content || "";
      const channel = ctx?.channelId || event?.channelId || "unknown";
      const success = event?.success !== false;

      send({
        ...baseEvent("tool_call_end", sk),
        tool_name: `message:${channel}`,
        tool_result: JSON.stringify({
          direction: "outbound",
          to: event?.to,
          channel,
          success,
          content: content.slice(0, 4096),
        }),
      });

      // ── Semantic: message_delivered / message_failed ──
      if (success) {
        send({
          ...baseEvent("message_delivered", sk),
          tool_name: `channel:${channel}`,
          tool_result: JSON.stringify({
            channel,
            to: event?.to,
            content_length: content.length,
          }),
        });
      } else {
        send({
          ...baseEvent("message_failed", sk),
          tool_name: `channel:${channel}`,
          error_type: "delivery_failure",
          error_message: event?.error || "Message delivery failed",
          tool_result: JSON.stringify({
            channel,
            to: event?.to,
          }),
        });
      }

      // ── Semantic: channel_switch ──
      const prevChannel = lastChannelPerSession.get(sessionId);
      if (prevChannel && prevChannel !== channel) {
        send({
          ...baseEvent("channel_switch", sk),
          tool_name: "channel",
          tool_args: JSON.stringify({
            previous_channel: prevChannel,
            new_channel: channel,
          }),
        });
      }
      lastChannelPerSession.set(sessionId, channel);
    });

    // ──────────────────────────────────────────────────────────────
    // Phase 2: Deep Agent Loop — LLM & Tool hooks
    // ──────────────────────────────────────────────────────────────

    // Intercept LLM input (prompts sent to provider)
    // PluginHookLlmInputEvent: { runId, sessionId, provider, model, systemPrompt?, prompt, historyMessages, imagesCount }
    api.on("llm_input", async (event: any) => {
      const sk = event?.sessionKey;
      const sessionId = sk || "__fallback__";

      // Extract the user's prompt — event.prompt is the confirmed field
      const rawPrompt: string = event?.prompt || "";
      const messages: any[] = event?.historyMessages || [];
      const model: string = event?.model || "";

      let userPrompt = "";
      if (rawPrompt) {
        userPrompt = stripOpenClawMetadata(rawPrompt);
      }

      // Fallback: try historyMessages for last user message
      if (!userPrompt && messages.length > 0) {
        const lastUserMsg = [...messages]
          .reverse()
          .find((m: any) => m.role === "user");
        if (lastUserMsg) {
          const content = typeof lastUserMsg.content === "string"
            ? lastUserMsg.content
            : JSON.stringify(lastUserMsg.content || "");
          userPrompt = stripOpenClawMetadata(content);
        }
      }

      const preview = userPrompt.slice(0, 2048);

      send({
        ...baseEvent("llm_call_start", sk),
        model,
        prompt_preview: preview,
        tool_name: "llm",
        tool_args: JSON.stringify({
          model,
          provider: event?.provider,
          message_count: messages.length,
          system_prompt_length: (event?.systemPrompt || "").length || 0,
          images_count: event?.imagesCount || 0,
        }),
      });

      // ── Semantic: context_window_usage ──
      // Estimate context consumption from message count and content length
      const totalContentLength = messages.reduce((sum: number, m: any) => {
        const c = typeof m.content === "string" ? m.content.length : JSON.stringify(m.content || "").length;
        return sum + c;
      }, 0) + (event?.systemPrompt || "").length + rawPrompt.length;
      // Rough token estimate: ~4 chars per token
      const estimatedTokens = Math.round(totalContentLength / 4);
      // Most models have 128k-1M context; flag if > 100k estimated tokens
      if (estimatedTokens > 100000) {
        send({
          ...baseEvent("context_window_usage", sk),
          tool_name: "context",
          tool_args: JSON.stringify({
            estimated_tokens: estimatedTokens,
            message_count: messages.length,
            content_length: totalContentLength,
            model,
          }),
        });
      }

      // ── Semantic: pii_detected ──
      const piiTypes = detectPII(userPrompt);
      if (piiTypes.length > 0) {
        send({
          ...baseEvent("pii_detected", sk),
          tool_name: "guardrail",
          tool_args: JSON.stringify({
            pii_types: piiTypes,
            location: "user_prompt",
          }),
        });
      }

      // ── Semantic: fallback_triggered ──
      // Detect if the model changed between consecutive LLM calls
      const prevModel = lastModelPerSession.get(sessionId);
      if (prevModel && model && prevModel !== model) {
        send({
          ...baseEvent("fallback_triggered", sk),
          model,
          tool_name: "model:fallback",
          tool_args: JSON.stringify({
            previous_model: prevModel,
            new_model: model,
          }),
        });
      }
      if (model) lastModelPerSession.set(sessionId, model);

      // ── Semantic: llm_retry ──
      // Detect if the same prompt is being sent again within 60 seconds
      const prevPrompt = lastLlmPromptPerSession.get(sessionId);
      const promptSig = preview.slice(0, 200);
      const now = Date.now();
      if (prevPrompt && prevPrompt.prompt === promptSig && (now - prevPrompt.ts) < 60000) {
        send({
          ...baseEvent("llm_retry", sk),
          model,
          tool_name: "llm:retry",
          tool_args: JSON.stringify({
            prompt_signature: promptSig.slice(0, 100),
            time_since_last_ms: now - prevPrompt.ts,
          }),
        });
      }
      lastLlmPromptPerSession.set(sessionId, { prompt: promptSig, ts: now });
    });

    // Intercept LLM output (completions from provider)
    // PluginHookLlmOutputEvent: { runId, sessionId, provider, model, assistantTexts: string[], lastAssistant?, usage?: { input, output, cacheRead } }
    api.on("llm_output", async (event: any) => {
      const sk = event?.sessionKey;
      const model: string = event?.model || "";

      // assistantTexts is the correct field — it's a string array
      const assistantTexts: string[] = event?.assistantTexts || [];
      const outputText = assistantTexts.join("\n") || "";

      // Also try lastAssistant as fallback
      let fullOutput = outputText;
      if (!fullOutput && event?.lastAssistant) {
        const la = event.lastAssistant;
        fullOutput = typeof la === "string" ? la : (la?.content || la?.text || JSON.stringify(la));
      }

      const inputTokens = event?.usage?.input || event?.usage?.inputTokens || 0;
      const outputTokens = event?.usage?.output || event?.usage?.outputTokens || 0;
      const cacheRead = event?.usage?.cacheRead || 0;

      send({
        ...baseEvent("llm_call_end", sk),
        model,
        llm_output_full: fullOutput.slice(0, 8192),
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        tool_name: "llm",
        tool_result: JSON.stringify({
          model,
          provider: event?.provider,
          output_length: fullOutput.length,
          cache_read: cacheRead,
        }),
      });

      // ── Semantic: token_usage ──
      if (inputTokens > 0 || outputTokens > 0) {
        send({
          ...baseEvent("token_usage", sk),
          model,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          tool_name: "cost",
          tool_args: JSON.stringify({
            model,
            provider: event?.provider,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_read: cacheRead,
            total_tokens: inputTokens + outputTokens,
          }),
        });
      }

      // ── Semantic: thinking / plan / decision analysis ──
      const llmAnalysis = analyzeLlmOutput(fullOutput);
      for (const analysis of llmAnalysis) {
        if (analysis.type === "thinking") {
          // Emit thinking_start and thinking_end as a pair
          send({
            ...baseEvent("thinking_start", sk),
            tool_name: "reasoning",
            tool_args: JSON.stringify({ model }),
          });
          send({
            ...baseEvent("thinking_end", sk),
            tool_name: "reasoning",
            llm_output_full: analysis.detail,
            tool_result: JSON.stringify({
              thinking_length: analysis.detail.length,
            }),
          });
        } else if (analysis.type === "plan_created") {
          send({
            ...baseEvent("plan_created", sk),
            tool_name: "planning",
            llm_output_full: analysis.detail,
            tool_result: JSON.stringify({
              step_count: (analysis.detail.match(/^\s*\d+\./gm) || []).length,
            }),
          });
        } else if (analysis.type === "decision_point") {
          send({
            ...baseEvent("decision_point", sk),
            tool_name: "reasoning",
            llm_output_full: analysis.detail,
          });
        }
      }

      // ── Semantic: rate_limit_hit ──
      // Detect rate limit in LLM errors/content.
      // Must include a numeric error code or explicit quota keyword so we don't trigger when the model just mentions "rate limit" conversationally.
      if (fullOutput && /(?:429\s*(?:too many requests)?)|(?:quota\s*exceeded)/i.test(fullOutput)) {
        send({
          ...baseEvent("rate_limit_hit", sk),
          model,
          tool_name: "provider",
          error_type: "rate_limit",
          error_message: "Rate limit metadata detected",
        });
      }
    });

    // Intercept tool calls BEFORE execution (sequential — can block)
    api.on("before_tool_call", async (event: any) => {
      const sk = event?.sessionKey;
      const sessionId = sk || "__fallback__";
      const toolName = event?.name || event?.toolName || "unknown";
      const toolArgs = event?.params || event?.args || event?.input || {};
      const toolArgsStr = JSON.stringify(toolArgs).slice(0, 4096);

      send({
        ...baseEvent("tool_call_start", sk),
        tool_name: toolName,
        tool_args: toolArgsStr,
        call_id: event?.callId || event?.tool_use_id || "",
      });

      // ── Semantic: classify tool into semantic category ──
      const semanticType = classifyToolStart(toolName, toolArgs);
      if (semanticType) {
        const semanticArgs: Record<string, unknown> = {
          original_tool: toolName,
        };

        // Add context-specific details based on semantic type
        if (semanticType === "file_read" || semanticType === "file_write") {
          semanticArgs.file_path = toolArgs?.path || toolArgs?.file || toolArgs?.filePath || "";
        } else if (semanticType === "code_executed") {
          semanticArgs.command = (toolArgs?.command || toolArgs?.cmd || toolArgs?.script || "").toString().slice(0, 500);
        } else if (semanticType === "browser_navigate") {
          semanticArgs.url = toolArgs?.url || toolArgs?.href || "";
        } else if (semanticType === "knowledge_retrieval") {
          semanticArgs.query = toolArgs?.query || toolArgs?.search || "";
        } else if (semanticType === "subagent_delegated") {
          semanticArgs.target = toolArgs?.sessionKey || toolArgs?.target || "";
          semanticArgs.task = toolArgs?.task || toolArgs?.message || "";
        }

        send({
          ...baseEvent(semanticType, sk),
          tool_name: toolName,
          tool_args: JSON.stringify(semanticArgs).slice(0, 4096),
          call_id: event?.callId || event?.tool_use_id || "",
        });
      }

      // ── Semantic: tool_retry detection ──
      const toolSig = `${toolName}:${toolArgsStr.slice(0, 200)}`;
      const now = Date.now();
      const prevTool = lastToolCallPerSession.get(sessionId);
      if (prevTool && prevTool.tool === toolName && prevTool.args === toolArgsStr.slice(0, 200) && (now - prevTool.ts) < 30000) {
        send({
          ...baseEvent("tool_retry", sk),
          tool_name: toolName,
          tool_args: JSON.stringify({
            retry_of: toolName,
            time_since_last_ms: now - prevTool.ts,
          }),
        });
      }
      lastToolCallPerSession.set(sessionId, { tool: toolName, args: toolArgsStr.slice(0, 200), ts: now });

      return undefined;
    });

    // NOTE: tool_result_received was invalid — tool results are captured
    // by after_tool_call below. The after_tool_call handler emits both
    // tool_call_end (with result) and tool_error events.

    // Intercept agent_end — fires when agent finishes (success, error, timeout, killed)
    // PluginHookAgentEndEvent: { messages: unknown[], success: boolean, error?: string, durationMs?: number }
    // PluginHookAgentContext: { agentId, sessionKey, sessionId, workspaceDir, messageProvider, trigger, channelId }
    api.on("agent_end", async (event: any, ctx: any) => {
      const sk = ctx?.sessionKey || event?.sessionKey;

      // Try to use existing session; if none exists, use getOrCreateRun
      // so the event still gets recorded (before_agent_start may not have
      // fired with a sessionKey if the agent was started differently)
      let run = sk ? sessions.get(sk) : null;
      if (!run) {
        // No existing session — use getOrCreateRun as fallback so agent_end
        // is ALWAYS recorded, even if we need to create a run for it
        run = getOrCreateRun(sk);
      }

      const success: boolean = event?.success === true;
      const errorMsg: string = event?.error || "";
      const durationMs: number = event?.durationMs || 0;
      const status = success ? "completed" : (errorMsg ? "error" : "unknown");

      // Always emit agent_end with actual status, using the EXISTING run
      send({
        ...baseEventFromRun("agent_end", run),
        status,
        duration_ms: durationMs,
        error_message: errorMsg || undefined,
        error_type: !success ? (errorMsg.includes("timed out") ? "timeout" : "error") : undefined,
      });

      // If the agent FAILED, emit a dedicated agent_error event for prominent UI display
      if (!success && errorMsg) {
        send({
          ...baseEventFromRun("agent_error", run),
          error_type: errorMsg.includes("timed out") ? "timeout" : "agent_failure",
          error_message: errorMsg,
          duration_ms: durationMs,
          tool_name: "agent",
          tool_result: JSON.stringify({
            success: false,
            error: errorMsg,
            agentId: ctx?.agentId,
            trigger: ctx?.trigger,
            channel: ctx?.channelId,
          }),
        });

        // Also emit as agent_response so the error text appears in the timeline
        send({
          ...baseEventFromRun("agent_response", run),
          llm_output_full: errorMsg.slice(0, 8192),
          tool_name: `response:${ctx?.channelId || "unknown"}`,
          tool_result: JSON.stringify({
            to: ctx?.channelId || "unknown",
            channel: ctx?.channelId || "unknown",
            is_error: true,
          }),
        });
      }

      // Clean up the session — all events have been emitted
      if (sk) sessions.delete(sk);
    });

    // Intercept after_tool_call — captures tool results AND errors.
    // This is the primary handler for tool completion events.
    // PluginHookAfterToolCallEvent: { toolName, params, runId?, toolCallId?, result?, error?, durationMs? }
    // PluginHookToolContext: { agentId, sessionKey, sessionId }
    api.on("after_tool_call", async (event: any, ctx: any) => {
      const sk = ctx?.sessionKey || event?.sessionKey;
      const toolName = event?.toolName || "unknown";
      const error = event?.error;
      const result = event?.result || "";
      const resultStr =
        typeof result === "string" ? result : JSON.stringify(result);
      const durationMs = event?.durationMs || 0;

      // Always emit tool_call_end with the result
      send({
        ...baseEvent("tool_call_end", sk),
        tool_name: toolName,
        tool_result: resultStr.slice(0, 4096),
        call_id: event?.toolCallId || "",
        duration_ms: durationMs,
        error_type: error ? "tool_error" : undefined,
        error_message: error
          ? typeof error === "string"
            ? error
            : error.message || String(error)
          : undefined,
      });

      // Additionally emit a dedicated tool_error for failed tool calls
      if (error) {
        const errorMsg =
          typeof error === "string" ? error : (error.message || String(error));
        send({
          ...baseEvent("tool_error", sk),
          tool_name: toolName,
          error_type: "tool_error",
          error_message: errorMsg,
          call_id: event?.toolCallId || "",
          duration_ms: durationMs,
        });
      }

      // ── Semantic: classify tool end events ──
      const semanticEndEvents = classifyToolEnd(toolName, error, durationMs);
      for (const semEvent of semanticEndEvents) {
        if (semEvent === "latency_warning") {
          send({
            ...baseEvent("latency_warning", sk),
            tool_name: toolName,
            duration_ms: durationMs,
            tool_args: JSON.stringify({
              threshold_ms: 15000,
              actual_ms: durationMs,
              tool: toolName,
            }),
          });
        } else if (semEvent === "subagent_result_received") {
          send({
            ...baseEvent("subagent_result_received", sk),
            tool_name: toolName,
            tool_result: resultStr.slice(0, 4096),
            duration_ms: durationMs,
          });
        } else if (semEvent === "content_filtered" || semEvent === "tool_blocked" || semEvent === "permission_escalation") {
          const errMsg = error ? (typeof error === "string" ? error : error.message || String(error)) : "";
          send({
            ...baseEvent(semEvent, sk),
            tool_name: toolName,
            error_type: semEvent,
            error_message: errMsg,
          });
        }
      }

      // ── Semantic: detect handoff_to_human ──
      // Check if tool result contains human handoff patterns, BUT only for specific tools
      // We don't want this firing because a web search result says "manual review"
      const isCommsTool = toolName.startsWith("message") || toolName === "telegram" || toolName === "slack" || toolName === "response:telegram";
      if (isCommsTool && resultStr && /needs? human|escalat|hand.?off|manual review|require.*approval/i.test(resultStr)) {
        send({
          ...baseEvent("handoff_to_human", sk),
          tool_name: toolName,
          tool_result: resultStr.slice(0, 1000),
        });
      }

      // ── Semantic: human_approval_requested ──
      // Detect approval request patterns in tool names or results
      if (/^approv|confirm|consent|authorize/i.test(toolName) && toolName !== "unknown") {
        send({
          ...baseEvent("human_approval_requested", sk),
          tool_name: toolName,
          tool_args: JSON.stringify(event?.params || {}),
        });
        // If it completed without error, the approval was received
        if (!error) {
          send({
            ...baseEvent("human_approval_received", sk),
            tool_name: toolName,
            tool_result: resultStr.slice(0, 1000),
          });
        }
      }
    });

    // Intercept subagent_ended — fires when a spawned subagent completes or fails
    // PluginHookSubagentEndedEvent: { targetSessionKey, targetKind?, reason?, outcome, error?, durationMs?, runId? }
    api.on("subagent_ended", async (event: any, ctx: any) => {
      const sk = ctx?.sessionKey || event?.sessionKey;

      // Use existing session only — never create a new run for subagent completion
      const run = sk ? sessions.get(sk) : null;
      if (!run) return;  // No session = already handled or orphan

      const success: boolean = event?.outcome === "ok" || event?.outcome === "completed";
      const errorMsg: string = event?.error || "";

      send({
        ...baseEventFromRun("agent_end", run),
        status: success ? "completed" : (errorMsg ? "error" : event?.outcome || "unknown"),
        error_message: errorMsg || undefined,
        error_type: !success && errorMsg ? "subagent_error" : undefined,
        tool_name: "subagent",
        tool_result: JSON.stringify({
          targetSessionKey: event?.targetSessionKey,
          outcome: event?.outcome,
          error: errorMsg,
        }),
      });

      // Emit agent_error for failed subagents
      if (!success && errorMsg) {
        send({
          ...baseEventFromRun("agent_error", run),
          error_type: "subagent_error",
          error_message: errorMsg,
          tool_name: "subagent",
        });
      }
    });

    // NOTE: "llm_error" is not a valid OpenClaw plugin hook name.
    // LLM errors are captured via llm_output (which fires on both success
    // and failure in newer OpenClaw versions) and after_tool_call for
    // tool-level errors.

    // Intercept message_sending — captures outgoing messages including error responses
    // PluginHookMessageSendingEvent: { to, content, replyToId?, channelId? }
    // This is where "Agent failed before reply: All models failed..." gets sent
    api.on("message_sending", async (event: any, ctx: any) => {
      const sk = ctx?.sessionKey || event?.sessionKey;
      const content: string = event?.content || "";

      // Detect error messages (OpenClaw prefixes with ⚠ or "Agent failed")
      const isErrorMessage = content.includes("Agent failed") ||
        content.includes("All models failed") ||
        content.includes("timed out") ||
        content.startsWith("⚠");

      if (isErrorMessage) {
        // Emit the ACTUAL error message as an agent_error event
        send({
          ...baseEvent("agent_error", sk),
          error_type: content.includes("timed out") ? "timeout" : "agent_failure",
          error_message: content,
          tool_name: "agent",
          tool_result: JSON.stringify({
            raw_error_message: content,
            to: event?.to,
            channel: ctx?.channelId || event?.channelId,
          }),
        });
      }

      // ── Semantic: message_draft ──
      // This captures the agent's draft before delivery — the "about to send" moment
      send({
        ...baseEvent("message_draft", sk),
        llm_output_full: content.slice(0, 8192),
        tool_name: `draft:${ctx?.channelId || event?.channelId || "unknown"}`,
        tool_args: JSON.stringify({
          to: event?.to,
          channel: ctx?.channelId || event?.channelId,
          is_error: isErrorMessage,
          content_length: content.length,
        }),
      });

      // Emit the agent's response
      send({
        ...baseEvent("agent_response", sk),
        llm_output_full: content.slice(0, 8192),
        tool_name: `response:${ctx?.channelId || event?.channelId || "unknown"}`,
        tool_result: JSON.stringify({
          to: event?.to,
          channel: ctx?.channelId || event?.channelId,
          is_error: isErrorMessage,
        }),
      });
    });

    // ──────────────────────────────────────────────────────────────
    // Phase 3: Session events
    // ──────────────────────────────────────────────────────────────

    // before_compaction — session is about to be compacted
    api.on("before_compaction", async (event: any, ctx: any) => {
      const sk = ctx?.sessionKey || event?.sessionKey;
      send({
        ...baseEvent("tool_call_start", sk),
        tool_name: "session:compaction",
        tool_args: JSON.stringify({ phase: "before" }),
      });
      // ── Semantic: compaction_start ──
      send({
        ...baseEvent("compaction_start", sk),
        tool_name: "session:compaction",
        tool_args: JSON.stringify({
          reason: event?.reason || "context_limit",
          message_count: event?.messageCount || event?.messages?.length || 0,
        }),
      });
    });

    // after_compaction — session compaction completed
    api.on("after_compaction", async (event: any, ctx: any) => {
      const sk = ctx?.sessionKey || event?.sessionKey;
      const summary = event?.summary?.slice?.(0, 2000) || "";

      send({
        ...baseEvent("tool_call_end", sk),
        tool_name: "session:compaction",
        tool_result: JSON.stringify({
          phase: "after",
          summary: summary.slice(0, 1000),
        }),
      });
      // ── Semantic: compaction_end ──
      send({
        ...baseEvent("compaction_end", sk),
        tool_name: "session:compaction",
        tool_result: JSON.stringify({
          summary_length: summary.length,
          summary_preview: summary.slice(0, 500),
        }),
      });
      // ── Semantic: context_truncated ──
      // Compaction always means context was truncated/summarized
      send({
        ...baseEvent("context_truncated", sk),
        tool_name: "session:context",
        tool_args: JSON.stringify({
          reason: "compaction",
          summary_preview: summary.slice(0, 500),
        }),
      });
    });

    // ──────────────────────────────────────────────────────────────
    // Phase 3b: Session lifecycle events
    // ──────────────────────────────────────────────────────────────

    // session_start — fires when a new session begins
    api.on("session_start", async (event: any, ctx: any) => {
      const sk = ctx?.sessionKey || event?.sessionKey;
      send({
        ...baseEvent("session_start", sk),
        tool_name: "session",
        tool_args: JSON.stringify({
          sessionId: ctx?.sessionId || event?.sessionId,
          trigger: ctx?.trigger || event?.trigger,
          channelId: ctx?.channelId || event?.channelId,
        }),
      });
    });

    // session_end — fires when a session ends
    api.on("session_end", async (event: any, ctx: any) => {
      const sk = ctx?.sessionKey || event?.sessionKey;
      send({
        ...baseEvent("session_end", sk),
        tool_name: "session",
        tool_result: JSON.stringify({
          sessionId: ctx?.sessionId || event?.sessionId,
          reason: event?.reason || "normal",
        }),
      });
      // ── Semantic: checkpoint_saved ──
      // Session end implies state was saved/checkpointed
      send({
        ...baseEvent("checkpoint_saved", sk),
        tool_name: "session:checkpoint",
        tool_result: JSON.stringify({
          sessionId: ctx?.sessionId || event?.sessionId,
          reason: event?.reason || "session_end",
        }),
      });
    });

    // ──────────────────────────────────────────────────────────────
    // Phase 3c: Subagent spawning events
    // ──────────────────────────────────────────────────────────────

    // subagent_spawning — fires when a subagent is about to be spawned
    api.on("subagent_spawning", async (event: any, ctx: any) => {
      const sk = ctx?.sessionKey || event?.sessionKey;
      send({
        ...baseEvent("tool_call_start", sk),
        tool_name: "subagent:spawn",
        tool_args: JSON.stringify({
          targetKind: event?.targetKind,
          targetSessionKey: event?.targetSessionKey,
          agentId: ctx?.agentId,
        }),
      });
    });

    // subagent_spawned — fires after subagent has been spawned
    api.on("subagent_spawned", async (event: any, ctx: any) => {
      const sk = ctx?.sessionKey || event?.sessionKey;
      send({
        ...baseEvent("tool_call_end", sk),
        tool_name: "subagent:spawn",
        tool_result: JSON.stringify({
          targetSessionKey: event?.targetSessionKey,
          targetKind: event?.targetKind,
          success: true,
        }),
      });
    });

    // ──────────────────────────────────────────────────────────────
    // Phase 3d: Model resolution, message write, tool result persist
    // ──────────────────────────────────────────────────────────────

    // before_model_resolve — fires before model provider is selected
    // Captures which model/provider the agent is about to use
    api.on("before_model_resolve", (event: any, ctx: any) => {
      const sk = ctx?.sessionKey || event?.sessionKey;
      send({
        ...baseEvent("model_resolve", sk),
        model: event?.model || event?.modelId || "",
        tool_name: "model:resolve",
        tool_args: JSON.stringify({
          requestedModel: event?.model || event?.modelId,
          requestedProvider: event?.provider || event?.providerId,
          taskType: event?.taskType,
        }),
      });
      // Return undefined — we observe only, don't override model selection
      return undefined;
    });

    // tool_result_persist — fires when a tool result is being written to the session transcript
    // This is SYNCHRONOUS — must not return a Promise
    api.on("tool_result_persist", (event: any, ctx: any) => {
      const sk = ctx?.sessionKey || event?.sessionKey;
      const message = event?.message;
      if (!message) return;

      // Extract tool result info from the message
      const toolName = message?.tool_use_id || message?.name || "unknown";
      const content = typeof message?.content === "string"
        ? message.content
        : JSON.stringify(message?.content || "");

      send({
        ...baseEvent("tool_result_persist", sk),
        tool_name: toolName,
        tool_result: content.slice(0, 4096),
        tool_args: JSON.stringify({
          role: message?.role,
          tool_use_id: message?.tool_use_id,
        }),
      });
      // Return the message unmodified
      return message;
    });

    // before_message_write — fires when a message is about to be written to session transcript
    // This captures the agent composing its response — the "writing" moment
    // This is SYNCHRONOUS — must not return a Promise
    api.on("before_message_write", (event: any, ctx: any) => {
      const sk = ctx?.sessionKey || event?.sessionKey;
      const message = event?.message;
      if (!message) return;

      const role: string = message?.role || "unknown";
      let content = "";
      if (typeof message?.content === "string") {
        content = message.content;
      } else if (Array.isArray(message?.content)) {
        // Content blocks — extract text blocks
        content = message.content
          .filter((b: any) => b?.type === "text")
          .map((b: any) => b?.text || "")
          .join("\n");
      }

      // Only emit for assistant messages (agent writing its response)
      if (role === "assistant" && content) {
        send({
          ...baseEvent("agent_response", sk),
          llm_output_full: content.slice(0, 8192),
          tool_name: `message_write:${role}`,
          tool_result: JSON.stringify({
            role,
            content_length: content.length,
            has_tool_use: Array.isArray(message?.content) &&
              message.content.some((b: any) => b?.type === "tool_use"),
          }),
        });
      }

      // Return the message unmodified
      return message;
    });

    // ──────────────────────────────────────────────────────────────
    // Phase 4: Diagnostic events — token usage & cost
    //
    // model.usage events include a sessionKey. We use it to map
    // the usage back to the correct ClawWatch run, preventing
    // cross-session cost/token leaking under concurrent load.
    // ──────────────────────────────────────────────────────────────

    const diagHandler = (event: any) => {
      if (event?.type !== "model.usage") return;

      // Resolve the correct run via sessionKey — the critical fix
      // for the concurrent session isolation problem
      const sk = event?.sessionKey;

      send({
        ...baseEvent("llm_call_end", sk),
        model: event?.modelId || "",
        input_tokens: event?.inputTokens || event?.usage?.input || 0,
        output_tokens: event?.outputTokens || event?.usage?.output || 0,
        duration_ms: event?.durationMs || 0,
        tool_name: "model.usage",
        tool_result: JSON.stringify({
          sessionKey: sk || "",
          provider: event?.providerId,
          model: event?.modelId,
          totalTokens: event?.totalTokens || 0,
          cachedTokens: event?.cachedTokens || 0,
          costUsd: event?.costUsd || 0,
          durationMs: event?.durationMs || 0,
        }),
      });
    };

    // Subscribe via both Symbol.for (survives bundler isolation)
    // and the string fallback key
    try {
      const g = globalThis as any;
      const symKey = Symbol.for("openclaw.diagnosticListeners");
      if (!g[symKey]) g[symKey] = new Set();
      g[symKey].add(diagHandler);

      const strKey = "__openclaw_diag_listeners";
      if (g[strKey] && g[strKey] !== g[symKey]) {
        g[strKey].add(diagHandler);
      }
    } catch {
      // Non-critical — diagnostic metrics won't be captured
    }

    console.log("[clawwatch] Plugin registered — streaming to", CLAWWATCH_URL);
    console.log(
      "[clawwatch] Concurrent session isolation: ENABLED (sessionKey→runId map)"
    );
  },
};
