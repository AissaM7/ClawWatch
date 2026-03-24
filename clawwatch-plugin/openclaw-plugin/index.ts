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
    api.on("command:new", async (event: any) => {
      const sk = event?.sessionKey;
      const run = resetRun(sk);
      send({
        ...baseEvent("agent_start", sk),
        run_id: run.runId,
        agent_name: "openclaw",
        goal: event?.context?.workspaceDir || "interactive session",
        status: "running",
      });
    });

    api.on("command:stop", async (event: any) => {
      const sk = event?.sessionKey;
      send({
        ...baseEvent("agent_end", sk),
        status: "completed",
      });
      // Clean up the session entry
      if (sk) sessions.delete(sk);
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

    api.on("gateway:startup", async (_event: any) => {
      const run = resetRun(undefined);
      send({
        ...baseEvent("agent_start", undefined),
        run_id: run.runId,
        agent_name: "openclaw-gateway",
        goal: "gateway started",
        status: "running",
      });
    });

    api.on("message:received", async (event: any) => {
      const sk = event?.sessionKey;
      const content = event?.context?.content || event?.content || event?.text || "";

      // Emit a user_prompt event with the ACTUAL user message
      if (content) {
        send({
          ...baseEvent("user_prompt", sk),
          prompt_preview: content.slice(0, 2048),
          goal: content.slice(0, 200),
          tool_name: `message:${event?.context?.channelId || "unknown"}`,
          tool_args: JSON.stringify({
            direction: "inbound",
            from: event?.context?.from,
            channel: event?.context?.channelId,
          }),
        });
      }

      // Also log it as a tool_call_start for event tracking
      send({
        ...baseEvent("tool_call_start", sk),
        tool_name: `message:${event?.context?.channelId || "unknown"}`,
        tool_args: JSON.stringify({
          direction: "inbound",
          from: event?.context?.from,
          channel: event?.context?.channelId,
          content: content.slice(0, 2048),
        }),
        goal: content.slice(0, 200),
      });
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
    api.on("llm_input", async (event: any) => {
      const sk = event?.sessionKey;

      // Extract the user's prompt — event.prompt is the confirmed field
      const rawPrompt: string =
        event?.prompt ||
        event?.userMessage ||
        event?.content ||
        event?.text ||
        "";

      // Also check messages array as fallback
      const messages: any[] = (
        event?.messages ||
        event?.historyMessages ||
        event?.input?.messages ||
        []
      ).filter?.((m: any) => m) || [];

      let userPrompt = "";

      if (rawPrompt) {
        userPrompt = stripOpenClawMetadata(rawPrompt);
      }

      // Fallback: try messages array for last user message
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

      // Emit a user_prompt event with the cleaned prompt
      if (preview) {
        send({
          ...baseEvent("user_prompt", sk),
          prompt_preview: preview,
          goal: preview.slice(0, 200),
        });
      }

      send({
        ...baseEvent("llm_call_start", sk),
        model: event?.modelId || event?.model || "",
        prompt_preview: preview,
        tool_name: "llm",
        tool_args: JSON.stringify({
          model: event?.modelId || event?.model,
          provider: event?.providerId || event?.provider,
          message_count: messages.length,
          system_prompt_length:
            (event?.systemPrompt || "").length ||
            messages.find((m: any) => m.role === "system")?.content?.length ||
            0,
        }),
      });
    });

    // Intercept LLM output (completions from provider)
    api.on("llm_output", async (event: any) => {
      const sk = event?.sessionKey;
      const content = event?.content || event?.text || "";
      const outputText =
        typeof content === "string" ? content : JSON.stringify(content);

      send({
        ...baseEvent("llm_call_end", sk),
        model: event?.modelId || event?.model || "",
        llm_output_full: outputText.slice(0, 8192),
        input_tokens: event?.usage?.inputTokens || event?.usage?.input || 0,
        output_tokens:
          event?.usage?.outputTokens || event?.usage?.output || 0,
        tool_name: "llm",
        tool_result: JSON.stringify({
          model: event?.modelId,
          provider: event?.providerId,
          stop_reason: event?.stopReason,
          output_length: outputText.length,
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
