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

// ─── Plugin Entry ───────────────────────────────────────────────────

export default {
  id: "clawwatch",

  register(api: any) {
    // ──────────────────────────────────────────────────────────────
    // Phase 1: Infrastructure — command & message events via hooks
    // ──────────────────────────────────────────────────────────────

    // New session = new run (scoped to sessionKey)
    //
    // IMPORTANT: This hook fires TWICE per inbound message — once in the
    // gateway dispatch context and once in the agent process context.
    // Using getOrCreateRun() ensures both fires get the SAME run_id,
    // preventing duplicate run records.
    api.on("command:new", async (event: any) => {
      const sk = event?.sessionKey;
      const existing = sk ? sessions.get(sk) : undefined;
      if (existing) {
        // Session already has a run — this is the second fire (agent process).
        // Just emit an agent_start under the SAME run_id for event tracking.
        // No new run is created.
        return;
      }
      // First fire (or no sessionKey) — create a new run
      const run = resetRun(sk);
      send({
        ...baseEvent("agent_start", sk),
        run_id: run.runId,
        agent_name: "openclaw",
        goal: "",
        status: "running",
      });
    });

    api.on("command:stop", async (event: any) => {
      const sk = event?.sessionKey;
      send({
        ...baseEvent("agent_end", sk),
        status: "completed",
      });
      // NOTE: Do NOT delete the session here. The agent_end hook may fire
      // after this, and it needs the session to resolve the correct run_id.
      // Session cleanup happens in the agent_end handler or via TTL eviction.
    });

    api.on("command:reset", async (event: any) => {
      const sk = event?.sessionKey;
      // End the current run
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

    // message:received — emit user_prompt event with full message text.
    // Does NOT create a new run — runs are only created by command:new.
    api.on("message:received", async (event: any) => {
      const sk = event?.sessionKey;
      const content = event?.context?.content || event?.content || event?.text || "";
      const channel = event?.context?.channelId || "unknown";
      const userId = event?.context?.from || event?.context?.userId || "unknown";

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

    api.on("message:sent", async (event: any) => {
      const sk = event?.sessionKey;
      const content = event?.context?.content || "";
      send({
        ...baseEvent("tool_call_end", sk),
        tool_name: `message:${event?.context?.channelId || "unknown"}`,
        tool_result: JSON.stringify({
          direction: "outbound",
          to: event?.context?.to,
          channel: event?.context?.channelId,
          success: event?.context?.success,
          content: content.slice(0, 4096),
        }),
      });
    });

    // ──────────────────────────────────────────────────────────────
    // Phase 2: Deep Agent Loop — LLM & Tool hooks
    // ──────────────────────────────────────────────────────────────

    // Intercept LLM input (prompts sent to provider)
    // PluginHookLlmInputEvent: { runId, sessionId, provider, model, systemPrompt?, prompt, historyMessages, imagesCount }
    api.on("llm_input", async (event: any) => {
      const sk = event?.sessionKey;

      // Extract the user's prompt — event.prompt is the confirmed field
      const rawPrompt: string = event?.prompt || "";
      const messages: any[] = event?.historyMessages || [];

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

      // NOTE: user_prompt is already emitted by message:received — do NOT duplicate here

      send({
        ...baseEvent("llm_call_start", sk),
        model: event?.model || "",
        prompt_preview: preview,
        tool_name: "llm",
        tool_args: JSON.stringify({
          model: event?.model,
          provider: event?.provider,
          message_count: messages.length,
          system_prompt_length: (event?.systemPrompt || "").length || 0,
          images_count: event?.imagesCount || 0,
        }),
      });
    });

    // Intercept LLM output (completions from provider)
    // PluginHookLlmOutputEvent: { runId, sessionId, provider, model, assistantTexts: string[], lastAssistant?, usage?: { input, output, cacheRead } }
    api.on("llm_output", async (event: any) => {
      const sk = event?.sessionKey;

      // assistantTexts is the correct field — it's a string array
      const assistantTexts: string[] = event?.assistantTexts || [];
      const outputText = assistantTexts.join("\n") || "";

      // Also try lastAssistant as fallback
      let fullOutput = outputText;
      if (!fullOutput && event?.lastAssistant) {
        const la = event.lastAssistant;
        fullOutput = typeof la === "string" ? la : (la?.content || la?.text || JSON.stringify(la));
      }

      send({
        ...baseEvent("llm_call_end", sk),
        model: event?.model || "",
        llm_output_full: fullOutput.slice(0, 8192),
        input_tokens: event?.usage?.input || event?.usage?.inputTokens || 0,
        output_tokens: event?.usage?.output || event?.usage?.outputTokens || 0,
        tool_name: "llm",
        tool_result: JSON.stringify({
          model: event?.model,
          provider: event?.provider,
          output_length: fullOutput.length,
          cache_read: event?.usage?.cacheRead || 0,
        }),
      });
    });

    // Intercept tool calls BEFORE execution (sequential — can block)
    api.on("before_tool_call", async (event: any) => {
      const sk = event?.sessionKey;
      const toolName = event?.name || event?.toolName || "unknown";
      const toolArgs = event?.params || event?.args || event?.input || {};

      send({
        ...baseEvent("tool_call_start", sk),
        tool_name: toolName,
        tool_args: JSON.stringify(toolArgs).slice(0, 4096),
        call_id: event?.callId || event?.tool_use_id || "",
      });

      // Optional: return { block: true, blockReason: "..." } for high-risk
      // For now, we observe only — blocking will be added once risk rules
      // are evaluated server-side
      return undefined;
    });

    // Intercept tool results AFTER execution
    api.on("tool_result_received", async (event: any) => {
      const sk = event?.sessionKey;
      const toolName = event?.name || event?.toolName || "unknown";
      const result = event?.result || event?.output || "";
      const resultStr =
        typeof result === "string" ? result : JSON.stringify(result);

      send({
        ...baseEvent("tool_call_end", sk),
        tool_name: toolName,
        tool_result: resultStr.slice(0, 4096),
        call_id: event?.callId || event?.tool_use_id || "",
        duration_ms: event?.durationMs || event?.duration || 0,
        error_type: event?.error ? "tool_error" : undefined,
        error_message: event?.error
          ? typeof event.error === "string"
            ? event.error
            : event.error.message || String(event.error)
          : undefined,
      });
    });

    // Intercept agent_end — fires when agent finishes (success, error, timeout, killed)
    // PluginHookAgentEndEvent: { messages: unknown[], success: boolean, error?: string, durationMs?: number }
    // PluginHookAgentContext: { agentId, sessionKey, sessionId, workspaceDir, messageProvider, trigger, channelId }
    api.on("agent_end", async (event: any, ctx: any) => {
      const sk = ctx?.sessionKey || event?.sessionKey;

      // CRITICAL: Use existing session only — never create a new run for agent_end.
      // If command:stop already emitted agent_end and this is a duplicate fire,
      // the session will still exist (we no longer delete in command:stop).
      // If somehow the session is gone, skip to avoid creating orphan runs.
      const run = sk ? sessions.get(sk) : null;
      if (!run) {
        // Session already gone — either already handled or no session.
        // Skip to prevent creating an orphan run.
        return;
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
        // as what the agent "said" — even if message_sending also fires,
        // this ensures the error is captured at the agent_end moment
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

      // NOW safe to clean up the session — all events have been emitted
      if (sk) sessions.delete(sk);
    });

    // Intercept after_tool_call — standard plugin hook with error field
    // PluginHookAfterToolCallEvent: { toolName, params, runId?, toolCallId?, result?, error?, durationMs? }
    // PluginHookToolContext: { agentId, sessionKey, sessionId }
    api.on("after_tool_call", async (event: any, ctx: any) => {
      const sk = ctx?.sessionKey || event?.sessionKey;
      const toolName = event?.toolName || "unknown";
      const error = event?.error;
      const result = event?.result || "";
      const resultStr =
        typeof result === "string" ? result : JSON.stringify(result);

      if (error) {
        // Emit a tool_error event for failed tool calls
        const errorMsg =
          typeof error === "string" ? error : (error.message || String(error));
        send({
          ...baseEvent("tool_error", sk),
          tool_name: toolName,
          error_type: "tool_error",
          error_message: errorMsg,
          call_id: event?.toolCallId || "",
          duration_ms: event?.durationMs || 0,
        });
      }
      // Note: don't emit tool_call_end here to avoid duplicates with tool_result_received
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

    // ──────────────────────────────────────────────────────────────
    // Phase 2b: LLM Error hook — captures timeouts and failures
    //
    // OpenClaw's llm_output hook only fires on SUCCESS. When an LLM
    // call times out or fails, NO llm_output fires. We need a
    // dedicated error handler.
    // ──────────────────────────────────────────────────────────────
    api.on("llm_error", async (event: any, ctx: any) => {
      const sk = ctx?.sessionKey || event?.sessionKey;
      const model = event?.model || event?.modelId || "";
      const provider = event?.provider || event?.providerId || "";
      const errorMsg = event?.error
        ? typeof event.error === "string" ? event.error : (event.error.message || String(event.error))
        : "LLM call failed";
      const durationMs = event?.durationMs || 0;

      // Determine error type
      let errorType = "llm_error";
      if (errorMsg.includes("timed out") || errorMsg.includes("timeout")) {
        errorType = "timeout";
      } else if (errorMsg.includes("rate limit")) {
        errorType = "rate_limit";
      }

      send({
        ...baseEvent("llm_error", sk),
        model,
        error_type: errorType,
        error_message: errorMsg,
        duration_ms: durationMs,
        tool_name: "llm",
        tool_result: JSON.stringify({
          model,
          provider,
          error: errorMsg,
          error_type: errorType,
        }),
      });
    });

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

    api.on("session:compact:before", async (event: any) => {
      const sk = event?.sessionKey;
      send({
        ...baseEvent("tool_call_start", sk),
        tool_name: "session:compaction",
        tool_args: JSON.stringify({ phase: "before" }),
      });
    });

    api.on("session:compact:after", async (event: any) => {
      const sk = event?.sessionKey;
      send({
        ...baseEvent("tool_call_end", sk),
        tool_name: "session:compaction",
        tool_result: JSON.stringify({
          phase: "after",
          summary: event?.context?.summary?.slice?.(0, 1000) || "",
        }),
      });
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
