// ── MiniMap Semantic Chunking Algorithm ─────────────────────────
// Transforms TraceNode[] into Chapter[] — a Hierarchy of Intent.
// Each user prompt becomes a Chapter containing compressed nodes.

import type { TraceNode, TraceStatus } from './traceTree';
import { formatTraceDuration } from './traceTree';

// ── Types ────────────────────────────────────────────────────────

export type MiniMapNodeKind =
    | 'start'          // run start
    | 'user_prompt'    // user message anchor
    | 'llm_flash'      // gemini flash / fast model
    | 'llm_pro'        // gemini pro / heavy model
    | 'llm_generic'    // unknown model
    | 'tool_call'      // tool invocation
    | 'end_success'    // agent ended successfully
    | 'end_fail'       // agent ended with error/timeout
    | 'end_halt';      // agent halted

export interface MiniMapNode {
    id: string;
    kind: MiniMapNodeKind;
    label: string;
    snippet: string;
    status: TraceStatus;
    count: number;
    startMs: number;
    durationMs: number;
    durationText: string;
    model?: string;
    traceNodeId: string;
    toolName?: string;
}

export type ChapterHealth = 'healthy' | 'flaky' | 'failed';

export interface Chapter {
    id: string;
    title: string;
    health: number;
    healthLabel: ChapterHealth;
    status: TraceStatus;
    durationMs: number;
    durationText: string;
    stepCount: number;
    errorCount: number;
    timeoutCount: number;
    successCount: number;
    llmModels: string[];
    nodes: MiniMapNode[];
    traceNodeId: string;
    startMs: number;
    parentChapterId?: string;   // Future: swarm delegation
}

// ── Helpers ──────────────────────────────────────────────────────

function classifyModel(model?: string): 'flash' | 'pro' | 'generic' {
    if (!model) return 'generic';
    const m = model.toLowerCase();
    if (m.includes('flash')) return 'flash';
    if (m.includes('pro') || m.includes('opus') || m.includes('sonnet')) return 'pro';
    return 'generic';
}

function nodeToKind(node: TraceNode): MiniMapNodeKind {
    switch (node.type) {
        case 'prompt':
            return 'user_prompt';
        case 'llm_attempt': {
            const mc = classifyModel(node.model);
            return mc === 'flash' ? 'llm_flash' : mc === 'pro' ? 'llm_pro' : 'llm_generic';
        }
        case 'tool_call':
            return 'tool_call';
        case 'agent_status':
            if (node.status === 'success') return 'end_success';
            if (node.status === 'halt') return 'end_halt';
            return 'end_fail';
        default:
            return 'tool_call';
    }
}

function nodeSnippet(node: TraceNode): string {
    if (node.type === 'prompt') {
        return node.label.length > 50 ? node.label.slice(0, 50) + '…' : node.label;
    }
    if (node.type === 'llm_attempt') {
        return `${node.model || 'LLM'} → ${formatTraceDuration(node.durationMs)}`;
    }
    if (node.type === 'tool_call') {
        const ev = node.event;
        if (ev?.tool_name) return ev.tool_name + (ev.tool_args ? `(${ev.tool_args.slice(0, 30)})` : '');
        return node.label;
    }
    return node.label.slice(0, 40);
}

// ── Health Score ─────────────────────────────────────────────────

function computeHealth(successCount: number, errorCount: number, totalSteps: number): { health: number; label: ChapterHealth } {
    if (totalSteps === 0) return { health: 1, label: 'healthy' };
    const h = (successCount - errorCount * 2) / totalSteps;
    const clamped = Math.max(0, Math.min(1, h));
    if (clamped >= 0.8) return { health: clamped, label: 'healthy' };
    if (clamped >= 0.5) return { health: clamped, label: 'flaky' };
    return { health: clamped, label: 'failed' };
}

// ── Compress children into MiniMapNode[] ────────────────────────

function compressChildren(children: TraceNode[]): {
    nodes: MiniMapNode[];
    successCount: number;
    errorCount: number;
    timeoutCount: number;
    models: Set<string>;
} {
    const nodes: MiniMapNode[] = [];
    let successCount = 0;
    let errorCount = 0;
    let timeoutCount = 0;
    const models = new Set<string>();

    let i = 0;
    while (i < children.length) {
        const child = children[i];

        if (child.type === 'system_group') { i++; continue; }

        const kind = nodeToKind(child);

        // Track status counts
        if (child.status === 'success') successCount++;
        if (child.status === 'error') errorCount++;
        if (child.status === 'timeout') timeoutCount++;

        // LLM compression
        if (kind === 'llm_flash' || kind === 'llm_pro' || kind === 'llm_generic') {
            if (child.model) models.add(child.model.split('/').pop() || child.model);

            let count = 1;
            let lastNode = child;
            while (i + count < children.length) {
                const next = children[i + count];
                if (next.type === 'system_group') { count++; continue; }
                if (next.type === 'llm_attempt' && nodeToKind(next) === kind) {
                    if (next.status === 'success') successCount++;
                    if (next.status === 'error') errorCount++;
                    if (next.status === 'timeout') timeoutCount++;
                    lastNode = next;
                    count++;
                } else break;
            }

            const llmCount = children.slice(i, i + count).filter(n => n.type === 'llm_attempt').length;

            nodes.push({
                id: `minimap-${child.id}`,
                kind,
                label: llmCount > 1
                    ? `${child.model?.split('/').pop() || 'LLM'} ×${llmCount}`
                    : child.model?.split('/').pop() || 'LLM Call',
                snippet: llmCount > 1
                    ? `${llmCount} attempts · ${nodeSnippet(lastNode)}`
                    : nodeSnippet(child),
                status: lastNode.status,
                count: llmCount,
                startMs: child.startMs,
                durationMs: lastNode.endMs - child.startMs,
                durationText: formatTraceDuration(lastNode.endMs - child.startMs),
                model: child.model,
                traceNodeId: child.id,
            });
            i += count;
            continue;
        }

        // Tool calls — compress consecutive same-tool calls into one node
        if (kind === 'tool_call') {
            const toolName = child.event?.tool_name || child.label;
            let count = 1;
            let lastToolNode = child;

            // Merge consecutive tool_call children with the same tool name
            while (i + count < children.length) {
                const next = children[i + count];
                if (next.type === 'system_group') { count++; continue; }
                // Also skip over 'event' type nodes (semantic leaf events)
                if (next.type === 'event') { count++; continue; }
                if (next.type === 'tool_call') {
                    const nextToolName = next.event?.tool_name || next.label;
                    if (nextToolName === toolName) {
                        if (next.status === 'success') successCount++;
                        if (next.status === 'error') errorCount++;
                        if (next.status === 'timeout') timeoutCount++;
                        lastToolNode = next;
                        count++;
                        continue;
                    }
                }
                break;
            }

            const toolCount = children.slice(i, i + count).filter(n => n.type === 'tool_call').length;

            nodes.push({
                id: `minimap-${child.id}`,
                kind,
                label: toolCount > 1
                    ? `${toolName} ×${toolCount}`
                    : toolName,
                snippet: toolCount > 1
                    ? `${toolCount} calls · ${nodeSnippet(lastToolNode)}`
                    : nodeSnippet(child),
                status: lastToolNode.status,
                count: toolCount,
                startMs: child.startMs,
                durationMs: lastToolNode.endMs - child.startMs,
                durationText: formatTraceDuration(lastToolNode.endMs - child.startMs),
                traceNodeId: child.id,
                toolName: child.event?.tool_name,
            });
            i += count;
            continue;
        }

        // Agent status
        if (child.type === 'agent_status') {
            nodes.push({
                id: `minimap-${child.id}`,
                kind,
                label: child.label,
                snippet: child.label,
                status: child.status,
                count: 1,
                startMs: child.startMs,
                durationMs: child.durationMs,
                durationText: formatTraceDuration(child.durationMs),
                traceNodeId: child.id,
            });
            i++;
            continue;
        }

        // Skip semantic leaf events (they're noise in the minimap)
        i++;
    }

    return { nodes, successCount, errorCount, timeoutCount, models };
}

// ── Main: Compress Trace → Chapters ─────────────────────────────
// Only prompt-type top-level nodes become chapters.
// Non-prompt nodes are folded into the nearest prompt chapter.

export function compressTraceToChapters(tree: TraceNode[]): Chapter[] {
    const chapters: Chapter[] = [];

    // Collect orphan non-prompt nodes that appear before the first prompt
    let orphanBuffer: TraceNode[] = [];

    for (let ci = 0; ci < tree.length; ci++) {
        const node = tree[ci];

        // Non-prompt top-level nodes → buffer them for folding
        if (node.type !== 'prompt') {
            if (chapters.length > 0) {
                // Fold into the most recent chapter
                const lastChapter = chapters[chapters.length - 1];
                const { nodes: extraNodes, successCount, errorCount, timeoutCount, models } = compressChildren([node]);
                lastChapter.nodes.push(...extraNodes);
                lastChapter.stepCount += extraNodes.length;
                lastChapter.errorCount += errorCount + timeoutCount;
                lastChapter.timeoutCount += timeoutCount;
                lastChapter.successCount += successCount;
                for (const m of models) {
                    if (!lastChapter.llmModels.includes(m)) lastChapter.llmModels.push(m);
                }
                const nodeEnd = node.endMs || node.startMs;
                lastChapter.durationMs = Math.max(lastChapter.durationMs, nodeEnd - lastChapter.startMs);
                lastChapter.durationText = formatTraceDuration(lastChapter.durationMs);
                const { health, label: healthLabel } = computeHealth(lastChapter.successCount, lastChapter.errorCount, lastChapter.stepCount);
                lastChapter.health = health;
                lastChapter.healthLabel = healthLabel;
            } else {
                // No chapter yet — buffer for later
                orphanBuffer.push(node);
            }
            continue;
        }

        // This is a prompt node → create a chapter
        const promptNode = node;

        // Build title from prompt text
        const title = promptNode.label.length > 55
            ? promptNode.label.slice(0, 55) + '…'
            : promptNode.label;

        // Include any buffered orphan nodes as extra children
        const allChildren = [...orphanBuffer, ...promptNode.children];
        orphanBuffer = [];

        // Compress children
        const { nodes, successCount, errorCount, timeoutCount, models } = compressChildren(allChildren);

        // Total steps = LLM + tool nodes (not system)
        const stepCount = nodes.length;
        const totalErrors = errorCount + timeoutCount;

        // Health score
        const { health, label: healthLabel } = computeHealth(successCount, totalErrors, stepCount);

        // Duration
        const endMs = promptNode.endMs || promptNode.startMs;
        const durationMs = endMs - promptNode.startMs;

        chapters.push({
            id: `chapter-${ci}`,
            title,
            health,
            healthLabel,
            status: promptNode.status,
            durationMs,
            durationText: formatTraceDuration(durationMs),
            stepCount,
            errorCount: totalErrors,
            timeoutCount,
            successCount,
            llmModels: Array.from(models),
            nodes,
            traceNodeId: promptNode.id,
            startMs: promptNode.startMs,
        });
    }

    // If there are still orphan nodes and no chapters were created,
    // create a single synthetic chapter for them
    if (orphanBuffer.length > 0 && chapters.length === 0) {
        const { nodes, successCount, errorCount, timeoutCount, models } = compressChildren(orphanBuffer);
        const stepCount = nodes.length;
        const totalErrors = errorCount + timeoutCount;
        const { health, label: healthLabel } = computeHealth(successCount, totalErrors, stepCount);
        const startMs = orphanBuffer[0].startMs;
        const endMs = orphanBuffer[orphanBuffer.length - 1].endMs || startMs;

        chapters.push({
            id: 'chapter-orphan',
            title: 'Agent Execution',
            health,
            healthLabel,
            status: orphanBuffer[orphanBuffer.length - 1].status,
            durationMs: endMs - startMs,
            durationText: formatTraceDuration(endMs - startMs),
            stepCount,
            errorCount: totalErrors,
            timeoutCount,
            successCount,
            llmModels: Array.from(models),
            nodes,
            traceNodeId: orphanBuffer[0].id,
            startMs,
        });
    }

    return chapters;
}

// Keep the old export for backward compat (used nowhere now, but safe)
export function compressTraceToMiniMap(tree: TraceNode[]): MiniMapNode[] {
    const chapters = compressTraceToChapters(tree);
    return chapters.flatMap(ch => ch.nodes);
}
