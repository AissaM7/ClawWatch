// ── Trace Tree Builder ─────────────────────────────────────────
// Transforms flat EnrichedEvent[] into a recursive TraceNode[] tree
// for the hierarchical waterfall view.

import type { EnrichedEvent } from './types';
import { estimateCost } from './cost';

// ── Types ────────────────────────────────────────────────────────

export type TraceNodeType =
    | 'root'          // top-level run container
    | 'prompt'        // user message / conversation turn
    | 'llm_attempt'   // single LLM call (may be a retry)
    | 'tool_call'     // tool invocation
    | 'system_group'  // auto-collapsed preprocess/bootstrap group
    | 'agent_status'  // agent_end / agent_start
    | 'event';        // leaf event (file, network, etc.)

export type TraceStatus = 'success' | 'error' | 'timeout' | 'halt' | 'running' | 'neutral';

export interface TraceNode {
    id: string;
    type: TraceNodeType;
    label: string;
    status: TraceStatus;
    depth: number;
    startMs: number;
    endMs: number;
    durationMs: number;
    model?: string;
    children: TraceNode[];
    events: EnrichedEvent[];  // raw events in this node
    isCollapsible: boolean;
    isSystemGroup: boolean;
    hasChildError: boolean;   // propagated from children
    // metrics
    llmCalls: number;
    toolCalls: number;
    costUsd: number;
    // for leaf events
    event?: EnrichedEvent;
}

// ── System tool names (auto-collapsed) ───────────────────────────

const SYSTEM_TOOLS = new Set(['preprocess', 'bootstrap', 'env', 'config']);

/** Channel tool names — llm_call_start events with these tool_names are user prompt boundaries */
const CHANNEL_TOOLS = new Set(['telegram', 'discord', 'terminal', 'webhook', 'direct', 'slack', 'whatsapp']);

/** Point-in-time event types — their backend duration_ms is cumulative run time, not event span */
const POINT_EVENT_TYPES = new Set(['agent_start', 'agent_end', 'agent_error', 'user_prompt']);
function isPointEvent(e: EnrichedEvent): boolean {
    return POINT_EVENT_TYPES.has(e.event_type);
}

// ── Status derivation ────────────────────────────────────────────

/**
 * Scope-aware agent_end status derivation.
 * 
 * Instead of greedily scanning backwards for ANY unmatched LLM start,
 * we find the scope boundary (previous agent_start/user_prompt) and then
 * check the LAST LLM call within that scope. If the last LLM call succeeded
 * (has a matching llm_call_end), this agent_end is a success — even if
 * earlier LLM calls in the same scope timed out.
 */
function deriveAgentEndStatus(event: EnrichedEvent, allEvents: EnrichedEvent[], idx: number): TraceStatus {
    const status = event.status?.toLowerCase() || '';
    // Only trust explicit error/failed status — NOT 'timeout' from backend
    // (backend may report timeout even when a later retry succeeded)
    if (status === 'error' || status === 'failed') return 'error';

    // Find scope boundary (most recent agent_start or user_prompt before this agent_end)
    let scopeStart = 0;
    for (let i = idx - 1; i >= 0; i--) {
        if (allEvents[i].event_type === 'agent_start' ||
            allEvents[i].event_type === 'user_prompt' ||
            allEvents[i].event_type === 'agent_end') {
            scopeStart = i + 1;
            break;
        }
    }

    // Collect all LLM starts and their matching ends within this scope
    const llmStarts: { idx: number; model: string; hasEnd: boolean; endOk: boolean }[] = [];
    for (let i = scopeStart; i < idx; i++) {
        const ev = allEvents[i];
        if (ev.event_type === 'llm_call_start') {
            llmStarts.push({ idx: i, model: ev.model || '', hasEnd: false, endOk: false });
        }
        if (ev.event_type === 'llm_call_end') {
            // Match to the most recent unmatched LLM start with same model
            for (let k = llmStarts.length - 1; k >= 0; k--) {
                if (!llmStarts[k].hasEnd && llmStarts[k].model === ev.model) {
                    llmStarts[k].hasEnd = true;
                    llmStarts[k].endOk = !ev.error_message;
                    break;
                }
            }
        }
        if (ev.event_type === 'llm_error') {
            for (let k = llmStarts.length - 1; k >= 0; k--) {
                if (!llmStarts[k].hasEnd && llmStarts[k].model === ev.model) {
                    llmStarts[k].hasEnd = true;
                    llmStarts[k].endOk = false;
                    break;
                }
            }
        }
    }

    // Check for successful tool calls after the last LLM call
    const hasToolCalls = allEvents.slice(scopeStart, idx).some(
        e => e.event_type === 'tool_call_start' && !SYSTEM_TOOLS.has(e.tool_name || '')
    );

    if (llmStarts.length === 0) {
        // No LLM calls in scope — neutral halt
        return status === 'completed' || status === 'ok' ? 'success' : 'halt';
    }

    // Check the LAST LLM call — this is the definitive one
    const lastLlm = llmStarts[llmStarts.length - 1];

    if (lastLlm.hasEnd && lastLlm.endOk) {
        // Last LLM call completed successfully
        return 'success';
    }

    if (hasToolCalls) {
        // Tool calls happened after LLM calls — the work was done
        return 'success';
    }

    if (!lastLlm.hasEnd) {
        // Last LLM call truly has no end event — real timeout
        return 'timeout';
    }

    if (lastLlm.hasEnd && !lastLlm.endOk) {
        // Last LLM call ended with error
        return 'error';
    }

    // Check if ALL LLM calls failed (all prior retries timed out)
    const allFailed = llmStarts.every(l => !l.hasEnd || !l.endOk);
    if (allFailed) return 'timeout';

    return status === 'completed' || status === 'ok' ? 'success' : 'halt';
}

function deriveLlmStatus(_startEvent: EnrichedEvent, endEvent: EnrichedEvent | null): TraceStatus {
    if (!endEvent) return 'timeout';
    if (endEvent.event_type === 'llm_error') return 'error';
    if (endEvent.error_message) return 'error';
    return 'success';
}

// ── Helpers ──────────────────────────────────────────────────────

function shortModel(model?: string): string {
    if (!model) return 'model';
    const base = model.split('/').pop() || model;
    return base.length > 25 ? base.slice(0, 25) : base;
}

function propagateErrors(node: TraceNode): boolean {
    let hasError = node.status === 'error' || node.status === 'timeout';
    for (const child of node.children) {
        if (propagateErrors(child)) hasError = true;
    }
    node.hasChildError = hasError;
    return hasError;
}

/**
 * Finalize prompt node status based on its children.
 * 
 * Uses the LAST agent_status child to determine the turn's final status.
 * A successful last step overrides earlier failures (retry recovery).
 */
function finalizePromptStatus(promptNode: TraceNode): void {
    // Find the last agent_status child (the definitive verdict)
    let lastAgentStatus: TraceNode | null = null;
    let hasSuccessfulLlm = false;
    let hasSuccessfulTool = false;
    let hasTimeout = false;
    let hasError = false;

    for (const child of promptNode.children) {
        if (child.type === 'agent_status') {
            lastAgentStatus = child;
        }
        if (child.type === 'llm_attempt' && child.status === 'success') {
            hasSuccessfulLlm = true;
        }
        if (child.type === 'tool_call' && child.status === 'success') {
            hasSuccessfulTool = true;
        }
        if (child.type === 'llm_attempt' && child.status === 'timeout') {
            hasTimeout = true;
        }
        if (child.type === 'llm_attempt' && child.status === 'error') {
            hasError = true;
        }
    }

    // The last agent_end verdict wins
    if (lastAgentStatus) {
        if (lastAgentStatus.status === 'success') {
            promptNode.status = 'success';
            return;
        }
        if (lastAgentStatus.status === 'halt') {
            // Check if any child succeeded — if so, the turn was productive
            if (hasSuccessfulLlm || hasSuccessfulTool) {
                promptNode.status = 'success';
            } else {
                promptNode.status = 'halt';
            }
            return;
        }
    }

    // No agent_end found — infer from children
    if (hasSuccessfulTool) {
        promptNode.status = 'success';
    } else if (hasSuccessfulLlm) {
        promptNode.status = 'success';
    } else if (hasTimeout || hasError) {
        promptNode.status = hasError ? 'error' : 'timeout';
    }
    // else: stays 'running'

    // If the turn concluded but OpenClaw didn't emit an explicit agent_end
    // (e.g., in continuous gateway mode), inject a synthetic completion node.
    if (promptNode.status !== 'running') {
        const hasCompletionNode = promptNode.children.some(c => c.type === 'agent_status');
        if (!hasCompletionNode) {
            const lastChildMs = promptNode.children.length > 0
                ? promptNode.children[promptNode.children.length - 1].endMs
                : promptNode.endMs;

            promptNode.children.push({
                id: `synth-end-${promptNode.id}`,
                type: 'agent_status',
                label: promptNode.status === 'success' ? 'Completed' : (promptNode.status === 'timeout' ? 'Timed Out' : 'Failed'),
                status: promptNode.status,
                depth: promptNode.depth + 1,
                startMs: lastChildMs,
                endMs: lastChildMs,
                durationMs: 0,
                children: [],
                events: [],
                isCollapsible: false,
                isSystemGroup: false,
                hasChildError: false,
                llmCalls: 0,
                toolCalls: 0,
                costUsd: 0,
            });
        }
    }
}

function computeMetrics(node: TraceNode): void {
    let llm = 0, tool = 0, cost = 0;
    for (const e of node.events) {
        if (e.event_type === 'llm_call_end') {
            llm++;
            cost += estimateCost(e.model || '', e.input_tokens || 0, e.output_tokens || 0);
        }
        if (e.event_type === 'tool_call_start') tool++;
    }
    for (const child of node.children) {
        computeMetrics(child);
        llm += child.llmCalls;
        tool += child.toolCalls;
        cost += child.costUsd;
    }
    node.llmCalls = llm;
    node.toolCalls = tool;
    node.costUsd = cost;
}

// ── Main builder ─────────────────────────────────────────────────

export function buildTraceTree(enrichedEvents: EnrichedEvent[]): TraceNode[] {
    if (enrichedEvents.length === 0) return [];

    const minOffset = enrichedEvents[0].run_offset_ms;
    const maxOffset = Math.max(
        ...enrichedEvents.map(e => e.run_offset_ms + (e.duration_ms || 0))
    );

    // We build a flat list of "logical nodes" then nest them
    const rootChildren: TraceNode[] = [];
    let currentPromptNode: TraceNode | null = null;
    let systemBuffer: EnrichedEvent[] = [];
    let llmAttemptCounter = 0;

    const flushSystemBuffer = (parentChildren: TraceNode[], depth: number) => {
        if (systemBuffer.length === 0) return;
        const events = [...systemBuffer];
        const start = Math.min(...events.map(e => e.run_offset_ms));
        const end = Math.max(...events.map(e => e.run_offset_ms + (e.duration_ms || 0)));
        parentChildren.push({
            id: `sys-${events[0].event_id}`,
            type: 'system_group',
            label: `System Initialization (${events.length} events)`,
            status: 'neutral',
            depth,
            startMs: start,
            endMs: end,
            durationMs: end - start,
            children: events.map((e, _i) => ({
                id: e.event_id,
                type: 'event' as TraceNodeType,
                label: `${e.tool_name || e.event_type}`,
                status: 'neutral' as TraceStatus,
                depth: depth + 1,
                startMs: e.run_offset_ms,
                endMs: e.run_offset_ms + (e.duration_ms || 0),
                durationMs: e.duration_ms || 0,
                children: [],
                events: [e],
                isCollapsible: false,
                isSystemGroup: false,
                hasChildError: false,
                llmCalls: 0,
                toolCalls: 0,
                costUsd: 0,
                event: e,
            })),
            events,
            isCollapsible: true,
            isSystemGroup: true,
            hasChildError: false,
            llmCalls: 0,
            toolCalls: 0,
            costUsd: 0,
        });
        systemBuffer = [];
    };

    const getTargetChildren = () => currentPromptNode ? currentPromptNode.children : rootChildren;
    const getDepth = () => currentPromptNode ? 1 : 0;

    // Track whether we've seen an agent_end (to detect new turns on agent_start)
    let lastEventWasAgentEnd = false;
    // Track the last user_prompt text so we can deduplicate the
    // llm_call_start with channel that carries the same prompt
    let lastUserPromptText = '';
    // Flag: suppress the next llm_call_start with channel after a user_prompt
    // (they always represent the same turn, even with slightly different text)
    let justSawUserPrompt = false;
    // Buffer for agent_end events — defer until after message lifecycle events
    let pendingAgentEnd: EnrichedEvent | null = null;
    let pendingAgentEndIndex = -1;

    const flushPendingAgentEnd = () => {
        if (!pendingAgentEnd) return;
        const event = pendingAgentEnd;
        const idx = pendingAgentEndIndex;
        pendingAgentEnd = null;
        pendingAgentEndIndex = -1;
        const tgt = getTargetChildren();
        const d = getDepth();

        const status = deriveAgentEndStatus(event, enrichedEvents, idx);
        const statusLabel = status === 'timeout' ? 'LLM Timeout'
            : status === 'error' ? 'Execution Failed'
                : status === 'success' ? 'Completed'
                    : status === 'halt' ? 'System Halt'
                        : 'Agent Finished';

        const agentNode: TraceNode = {
            id: event.event_id,
            type: 'agent_status',
            label: statusLabel,
            status,
            depth: d + 1,
            startMs: event.run_offset_ms,
            endMs: event.run_offset_ms,
            durationMs: 0,
            children: [],
            events: [event],
            isCollapsible: false,
            isSystemGroup: false,
            hasChildError: status === 'error' || status === 'timeout',
            llmCalls: 0,
            toolCalls: 0,
            costUsd: 0,
            event,
        };
        tgt.push(agentNode);

        if (currentPromptNode) {
            currentPromptNode.events.push(event);
            currentPromptNode.endMs = Math.max(currentPromptNode.endMs, event.run_offset_ms);
        }
    };

    for (let i = 0; i < enrichedEvents.length; i++) {
        const event = enrichedEvents[i];
        const targetChildren = getTargetChildren();
        const depth = getDepth();

        // ── user_prompt → new conversation turn ──
        if (event.event_type === 'user_prompt') {
            // Flush any pending agent_end before starting new turn
            flushPendingAgentEnd();
            // Finalize previous prompt before creating new one
            if (currentPromptNode) finalizePromptStatus(currentPromptNode);
            // Flush any pending system buffer
            flushSystemBuffer(getTargetChildren(), getDepth());
            llmAttemptCounter = 0;

            const promptText = event.prompt_preview || event.goal || 'User prompt';
            lastUserPromptText = promptText;
            justSawUserPrompt = true;
            currentPromptNode = {
                id: `prompt-${event.event_id}`,
                type: 'prompt',
                label: promptText,
                status: 'running',
                depth: 0,
                startMs: event.run_offset_ms,
                endMs: event.run_offset_ms,
                durationMs: 0,
                children: [],
                events: [event],
                isCollapsible: true,
                isSystemGroup: false,
                hasChildError: false,
                llmCalls: 0,
                toolCalls: 0,
                costUsd: 0,
            };
            rootChildren.push(currentPromptNode);
            lastEventWasAgentEnd = false;
            continue;
        }

        // ── agent_start after agent_end → new conversation turn ──
        // This catches the restart-after-failure pattern where the agent
        // restarts without a new user_prompt event.
        if (event.event_type === 'agent_start' && lastEventWasAgentEnd && !currentPromptNode) {
            // Finalize previous prompt before creating new one
            flushSystemBuffer(getTargetChildren(), getDepth());
            llmAttemptCounter = 0;

            const promptText = event.goal || event.prompt_preview || 'Agent Restart';
            currentPromptNode = {
                id: `prompt-${event.event_id}`,
                type: 'prompt',
                label: promptText,
                status: 'running',
                depth: 0,
                startMs: event.run_offset_ms,
                endMs: event.run_offset_ms,
                durationMs: 0,
                children: [],
                events: [event],
                isCollapsible: true,
                isSystemGroup: false,
                hasChildError: false,
                llmCalls: 0,
                toolCalls: 0,
                costUsd: 0,
            };
            rootChildren.push(currentPromptNode);
            lastEventWasAgentEnd = false;
            continue;
        }

        // Track agent_end for turn boundary detection
        lastEventWasAgentEnd = event.event_type === 'agent_end';

        // ── llm_call_start with channel tool_name → user prompt boundary ──
        // The OpenClaw backend sends user prompts as llm_call_start events
        // with tool_name matching a channel (telegram, discord, etc.)
        // and prompt_preview containing the user's actual message text.
        if (event.event_type === 'llm_call_start' &&
            event.tool_name && CHANNEL_TOOLS.has(event.tool_name.toLowerCase())) {
            const promptText = event.prompt_preview || event.goal || 'User prompt';

            // If we JUST saw a user_prompt event, this channel llm_call_start
            // is always the same turn — skip it unconditionally to prevent duplicates
            // (the texts may differ slightly due to truncation/formatting)
            if (justSawUserPrompt && currentPromptNode) {
                justSawUserPrompt = false;
                continue;
            }

            // Legacy fallback: also deduplicate by exact text match
            if (currentPromptNode && promptText === lastUserPromptText) {
                continue;
            }

            // Only create a new turn if the prompt text differs from the current turn
            // (or if there's no current turn yet)
            if (!currentPromptNode || promptText !== currentPromptNode.label) {
                flushPendingAgentEnd();
                if (currentPromptNode) finalizePromptStatus(currentPromptNode);
                flushSystemBuffer(getTargetChildren(), getDepth());
                llmAttemptCounter = 0;
                lastUserPromptText = promptText;

                currentPromptNode = {
                    id: `prompt-${event.event_id}`,
                    type: 'prompt',
                    label: promptText,
                    status: 'running',
                    depth: 0,
                    startMs: event.run_offset_ms,
                    endMs: event.run_offset_ms,
                    durationMs: 0,
                    children: [],
                    events: [event],
                    isCollapsible: true,
                    isSystemGroup: false,
                    hasChildError: false,
                    llmCalls: 0,
                    toolCalls: 0,
                    costUsd: 0,
                };
                rootChildren.push(currentPromptNode);
                lastEventWasAgentEnd = false;
            }
            // Skip — don't process as a regular llm_call_start
            continue;
        }

        // Reset the justSawUserPrompt flag on any non-channel event
        justSawUserPrompt = false;

        // ── System tools (preprocess, bootstrap) → buffer ──
        if ((event.event_type === 'tool_call_start' || event.event_type === 'tool_call_end') &&
            event.tool_name && SYSTEM_TOOLS.has(event.tool_name)) {
            systemBuffer.push(event);
            if (currentPromptNode) {
                currentPromptNode.events.push(event);
                currentPromptNode.endMs = Math.max(currentPromptNode.endMs, event.run_offset_ms + (event.duration_ms || 0));
            }
            continue;
        }

        // Flush system buffer before non-system events
        flushSystemBuffer(targetChildren, depth);

        // ── LLM call start → new LLM attempt node ──
        if (event.event_type === 'llm_call_start') {
            llmAttemptCounter++;
            const model = shortModel(event.model);

            // Find matching end event
            let endEvent: EnrichedEvent | null = null;
            let endIdx = -1;
            for (let j = i + 1; j < enrichedEvents.length; j++) {
                const candidate = enrichedEvents[j];
                if ((candidate.event_type === 'llm_call_end' || candidate.event_type === 'llm_error') &&
                    candidate.model === event.model) {
                    endEvent = candidate;
                    endIdx = j;
                    break;
                }
                // Stop at next user_prompt or llm_call_start with different model
                if (candidate.event_type === 'user_prompt') break;
            }

            const endMs = endEvent
                ? endEvent.run_offset_ms + (endEvent.duration_ms || 0)
                : event.run_offset_ms + (event.duration_ms || 0);

            const status = deriveLlmStatus(event, endEvent);
            const attemptLabel = llmAttemptCounter > 1
                ? `LLM Attempt ${llmAttemptCounter} → ${model}`
                : `LLM Call → ${model}`;

            const statusSuffix = status === 'timeout' ? ' · Timed Out'
                : status === 'error' ? ' · Error'
                    : '';

            const llmNode: TraceNode = {
                id: `llm-${event.event_id}`,
                type: 'llm_attempt',
                label: `${attemptLabel}${statusSuffix}`,
                status,
                depth: depth + 1,
                startMs: event.run_offset_ms,
                endMs,
                durationMs: endMs - event.run_offset_ms,
                model: event.model,
                children: [],
                events: endEvent ? [event, endEvent] : [event],
                isCollapsible: false,
                isSystemGroup: false,
                hasChildError: status === 'error' || status === 'timeout',
                llmCalls: endEvent?.event_type === 'llm_call_end' ? 1 : 0,
                toolCalls: 0,
                costUsd: endEvent ? estimateCost(endEvent.model || '', endEvent.input_tokens || 0, endEvent.output_tokens || 0) : 0,
                event: endEvent || event,
            };

            targetChildren.push(llmNode);

            // Update parent
            if (currentPromptNode) {
                currentPromptNode.events.push(event);
                if (endEvent) currentPromptNode.events.push(endEvent);
                currentPromptNode.endMs = Math.max(currentPromptNode.endMs, endMs);
            }

            // Skip the end event since we've consumed it
            if (endIdx > 0) {
                // Mark it consumed — we'll skip llm_call_end/llm_error separately
            }
            continue;
        }

        // ── Skip already-consumed llm_call_end ──
        if (event.event_type === 'llm_call_end' || event.event_type === 'llm_error') {
            // Check if this was already consumed by an llm_call_start
            const wasConsumed = targetChildren.some(child =>
                child.type === 'llm_attempt' && child.events.some(e => e.event_id === event.event_id)
            );
            if (wasConsumed) continue;
            // Otherwise add as standalone event
        }

        // ── Tool calls (non-system) ──
        if (event.event_type === 'tool_call_start') {
            const toolName = event.tool_name || 'tool';
            let args = '';
            try {
                const parsed = JSON.parse(event.tool_args || '{}');
                const firstVal = Object.values(parsed).find(v => typeof v === 'string' && (v as string).length > 2);
                if (firstVal) args = `(${String(firstVal).slice(0, 40)})`;
            } catch { /* skip */ }

            const endMs = event.run_offset_ms + (event.duration_ms || 0);
            const toolNode: TraceNode = {
                id: event.event_id,
                type: 'tool_call',
                label: `${toolName}${args}`,
                status: 'success',
                depth: depth + 1,
                startMs: event.run_offset_ms,
                endMs,
                durationMs: event.duration_ms || 0,
                children: [],
                events: [event],
                isCollapsible: false,
                isSystemGroup: false,
                hasChildError: false,
                llmCalls: 0,
                toolCalls: 1,
                costUsd: 0,
                event,
            };
            targetChildren.push(toolNode);

            if (currentPromptNode) {
                currentPromptNode.events.push(event);
                currentPromptNode.endMs = Math.max(currentPromptNode.endMs, endMs);
            }
            continue;
        }

        // ── agent_end → buffer it (flush after message lifecycle events) ──
        if (event.event_type === 'agent_end') {
            // Buffer agent_end so it appears AFTER any message_draft / message_delivered
            // events that fire after the agent framework marks the turn complete.
            pendingAgentEnd = event;
            pendingAgentEndIndex = i;
            lastEventWasAgentEnd = true;
            continue;
        }

        // If we have a pending agent_end and the current event is NOT part of
        // the message delivery lifecycle, flush the agent_end now.
        const MESSAGE_LIFECYCLE = new Set([
            'message_draft', 'message_delivered', 'message_failed',
            'channel_switch', 'agent_response', 'decision_point',
            'rate_limit_hit', 'tool_result_persist',
        ]);
        if (pendingAgentEnd && event.event_type !== 'tool_call_end'
            && !MESSAGE_LIFECYCLE.has(event.event_type)
            && event.event_type !== 'llm_call_end'
            && event.event_type !== 'llm_error') {
            flushPendingAgentEnd();
        }

        // ── Generic leaf event ──
        const pointEvent = isPointEvent(event);
        const leafDurationMs = pointEvent ? 0 : (event.duration_ms || 0);
        const leafNode: TraceNode = {
            id: event.event_id,
            type: 'event',
            label: event.description || event.event_type,
            status: 'neutral',
            depth: depth + 1,
            startMs: event.run_offset_ms,
            endMs: event.run_offset_ms + leafDurationMs,
            durationMs: leafDurationMs,
            children: [],
            events: [event],
            isCollapsible: false,
            isSystemGroup: false,
            hasChildError: false,
            llmCalls: 0,
            toolCalls: 0,
            costUsd: 0,
            event,
        };
        targetChildren.push(leafNode);

        if (currentPromptNode) {
            currentPromptNode.events.push(event);
            currentPromptNode.endMs = Math.max(currentPromptNode.endMs, event.run_offset_ms);
        }
    }

    // Flush remaining system buffer
    flushSystemBuffer(getTargetChildren(), getDepth());

    // Flush any pending agent_end
    flushPendingAgentEnd();

    // Finalize the last prompt node's status
    if (currentPromptNode) finalizePromptStatus(currentPromptNode);

    // If no user_prompt was found, all events are at root level
    // Wrap them in a synthetic prompt node using the first event's goal
    if (rootChildren.length > 0 && !rootChildren.some(n => n.type === 'prompt')) {
        const firstEvent = enrichedEvents[0];
        const promptText = firstEvent.goal || firstEvent.prompt_preview || 'Agent Execution';
        const syntheticPrompt: TraceNode = {
            id: 'synthetic-root',
            type: 'prompt',
            label: promptText,
            status: 'running',
            depth: 0,
            startMs: minOffset,
            endMs: maxOffset,
            durationMs: maxOffset - minOffset,
            children: rootChildren.map(c => ({ ...c, depth: c.depth + 1 })),
            events: enrichedEvents,
            isCollapsible: true,
            isSystemGroup: false,
            hasChildError: false,
            llmCalls: 0,
            toolCalls: 0,
            costUsd: 0,
        };

        // Finalize status using the same logic as real prompts
        finalizePromptStatus(syntheticPrompt);

        computeMetrics(syntheticPrompt);
        propagateErrors(syntheticPrompt);
        syntheticPrompt.durationMs = syntheticPrompt.endMs - syntheticPrompt.startMs;
        return [syntheticPrompt];
    }

    // Compute metrics and propagate errors
    for (const node of rootChildren) {
        computeMetrics(node);
        propagateErrors(node);
        node.durationMs = node.endMs - node.startMs;
    }

    return rootChildren;
}

// ── Flatten for rendering ────────────────────────────────────────

export interface FlatTraceRow {
    node: TraceNode;
    depth: number;
    isLastChild: boolean;
    parentIsLast: boolean[];  // for drawing connector lines
}

export function flattenTraceTree(
    nodes: TraceNode[],
    expandedNodes: Set<string>,
    depth = 0,
    parentIsLast: boolean[] = [],
): FlatTraceRow[] {
    const rows: FlatTraceRow[] = [];

    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const isLast = i === nodes.length - 1;

        rows.push({
            node,
            depth,
            isLastChild: isLast,
            parentIsLast: [...parentIsLast],
        });

        // Only recurse if expanded and has children
        if (node.children.length > 0 && expandedNodes.has(node.id)) {
            const childRows = flattenTraceTree(
                node.children,
                expandedNodes,
                depth + 1,
                [...parentIsLast, isLast],
            );
            rows.push(...childRows);
        }
    }

    return rows;
}

// ── Collect all node IDs for "expand all" ────────────────────────

export function collectAllIds(nodes: TraceNode[]): Set<string> {
    const ids = new Set<string>();
    const walk = (ns: TraceNode[]) => {
        for (const n of ns) {
            if (n.children.length > 0) ids.add(n.id);
            walk(n.children);
        }
    };
    walk(nodes);
    return ids;
}

// ── Collect default expanded IDs (everything except system groups) ─

export function collectDefaultExpanded(nodes: TraceNode[]): Set<string> {
    const ids = new Set<string>();
    const walk = (ns: TraceNode[]) => {
        for (const n of ns) {
            if (n.children.length > 0 && !n.isSystemGroup) {
                ids.add(n.id);
            }
            walk(n.children);
        }
    };
    walk(nodes);
    return ids;
}

// ── Duration formatting ──────────────────────────────────────────

export function formatTraceDuration(ms: number): string {
    if (ms <= 0) return '0s';
    if (ms < 1000) return `${ms}ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(2)}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    if (minutes < 60) return `${minutes}m ${secs}s`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
}
