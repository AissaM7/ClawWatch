// ── TraceRow: Recursive Trace Row Component ─────────────────────
// Renders a single row in the hierarchical trace tree with nesting
// lines, icons, status badges, and waterfall duration bars.

import React from 'react';
import {
    Cpu, Wrench, Settings2, Terminal, AlertCircle, AlertTriangle,
    ChevronRight, ChevronDown, Play, Square, FileText,
    Globe, Zap, Search, Brain, MessageSquare, Send, XCircle,
    Eye, Shield, Clock, RefreshCw, ArrowRightLeft, Users,
    Database, Bookmark, CheckCircle, GitBranch, Target,
    PenTool, Layers, Lock, UserCheck, AlertOctagon, Gauge,
    Archive, Radio
} from 'lucide-react';
import type { FlatTraceRow, TraceNodeType, TraceStatus } from '../lib/traceTree';
import { formatTraceDuration } from '../lib/traceTree';

// ── Icon mapping ─────────────────────────────────────────────────

function getNodeIcon(type: TraceNodeType, status: TraceStatus, eventType?: string) {
    const size = 14;
    const strokeWidth = 1.8;
    const props = { size, strokeWidth };

    switch (type) {
        case 'prompt':
            return <Terminal {...props} className="trace-icon trace-icon--prompt" />;
        case 'llm_attempt':
            if (status === 'error' || status === 'timeout')
                return <AlertCircle {...props} className="trace-icon trace-icon--error" />;
            return <Cpu {...props} className="trace-icon trace-icon--llm" />;
        case 'tool_call':
            return <Wrench {...props} className="trace-icon trace-icon--tool" />;
        case 'system_group':
            return <Settings2 {...props} className="trace-icon trace-icon--system" />;
        case 'agent_status':
            if (status === 'error' || status === 'timeout')
                return <AlertCircle {...props} className="trace-icon trace-icon--error" />;
            if (status === 'halt')
                return <AlertTriangle {...props} className="trace-icon trace-icon--halt" />;
            if (status === 'success')
                return <CheckCircle {...props} className="trace-icon trace-icon--success" />;
            return <Square {...props} className="trace-icon trace-icon--neutral" />;
        case 'event':
            return getSemanticIcon(eventType, props);
        default:
            return <Play {...props} className="trace-icon trace-icon--neutral" />;
    }
}

// ── Semantic event icon mapping ──────────────────────────────────

function getSemanticIcon(eventType: string | undefined, props: { size: number; strokeWidth: number }) {
    if (!eventType) return <Play {...props} className="trace-icon trace-icon--neutral" />;

    switch (eventType) {
        // 🔧 File I/O
        case 'file_read':
            return <FileText {...props} className="trace-icon trace-icon--file" />;
        case 'file_write':
            return <PenTool {...props} className="trace-icon trace-icon--file" />;

        // ⚡ Code Execution
        case 'code_executed':
            return <Terminal {...props} className="trace-icon trace-icon--code" />;

        // 🌐 Web / Browser
        case 'browser_navigate':
            return <Globe {...props} className="trace-icon trace-icon--net" />;
        case 'browser_screenshot':
            return <Eye {...props} className="trace-icon trace-icon--net" />;
        case 'knowledge_retrieval':
            return <Search {...props} className="trace-icon trace-icon--search" />;
        case 'api_call':
            return <Globe {...props} className="trace-icon trace-icon--net" />;

        // 🧠 Reasoning & Planning
        case 'thinking_start':
        case 'thinking_end':
            return <Brain {...props} className="trace-icon trace-icon--reasoning" />;
        case 'plan_created':
            return <Target {...props} className="trace-icon trace-icon--reasoning" />;
        case 'plan_step_start':
        case 'plan_step_end':
            return <GitBranch {...props} className="trace-icon trace-icon--reasoning" />;
        case 'decision_point':
            return <ArrowRightLeft {...props} className="trace-icon trace-icon--reasoning" />;

        // 💬 Message Lifecycle
        case 'message_draft':
            return <PenTool {...props} className="trace-icon trace-icon--message" />;
        case 'message_delivered':
            return <Send {...props} className="trace-icon trace-icon--message-ok" />;
        case 'message_failed':
            return <XCircle {...props} className="trace-icon trace-icon--error" />;
        case 'channel_switch':
            return <Radio {...props} className="trace-icon trace-icon--message" />;
        case 'agent_response':
            return <MessageSquare {...props} className="trace-icon trace-icon--message" />;

        // 💰 Cost & Performance
        case 'token_usage':
            return <Gauge {...props} className="trace-icon trace-icon--cost" />;
        case 'latency_warning':
            return <Clock {...props} className="trace-icon trace-icon--warning" />;
        case 'context_window_usage':
            return <Layers {...props} className="trace-icon trace-icon--warning" />;
        case 'rate_limit_hit':
            return <AlertOctagon {...props} className="trace-icon trace-icon--error" />;

        // 🔄 Retry & Recovery
        case 'llm_retry':
        case 'tool_retry':
            return <RefreshCw {...props} className="trace-icon trace-icon--retry" />;
        case 'fallback_triggered':
            return <ArrowRightLeft {...props} className="trace-icon trace-icon--warning" />;
        case 'checkpoint_saved':
            return <Bookmark {...props} className="trace-icon trace-icon--system" />;

        // 🔒 Safety & Guardrails
        case 'content_filtered':
            return <Shield {...props} className="trace-icon trace-icon--safety" />;
        case 'pii_detected':
            return <Shield {...props} className="trace-icon trace-icon--safety" />;
        case 'tool_blocked':
            return <Lock {...props} className="trace-icon trace-icon--safety" />;
        case 'permission_escalation':
            return <AlertTriangle {...props} className="trace-icon trace-icon--safety" />;
        case 'human_approval_requested':
            return <UserCheck {...props} className="trace-icon trace-icon--safety" />;
        case 'human_approval_received':
            return <CheckCircle {...props} className="trace-icon trace-icon--safety" />;
        case 'handoff_to_human':
            return <Users {...props} className="trace-icon trace-icon--safety" />;

        // 👥 Multi-Agent
        case 'subagent_delegated':
            return <Users {...props} className="trace-icon trace-icon--agent" />;
        case 'subagent_result_received':
            return <Users {...props} className="trace-icon trace-icon--agent" />;
        case 'agent_collaboration':
            return <Users {...props} className="trace-icon trace-icon--agent" />;

        // 📋 Context & Memory
        case 'memory_read':
            return <Database {...props} className="trace-icon trace-icon--memory" />;
        case 'memory_write':
            return <Database {...props} className="trace-icon trace-icon--memory" />;
        case 'compaction_start':
        case 'compaction_end':
            return <Archive {...props} className="trace-icon trace-icon--system" />;
        case 'context_truncated':
            return <Layers {...props} className="trace-icon trace-icon--warning" />;

        // Session events
        case 'session_start':
        case 'session_end':
            return <Zap {...props} className="trace-icon trace-icon--system" />;
        case 'model_resolve':
            return <Settings2 {...props} className="trace-icon trace-icon--system" />;
        case 'tool_result_persist':
            return <Database {...props} className="trace-icon trace-icon--system" />;

        // Existing events
        case 'user_prompt':
            return <Terminal {...props} className="trace-icon trace-icon--prompt" />;
        case 'agent_start':
            return <Play {...props} className="trace-icon trace-icon--success" />;
        case 'agent_end':
            return <Square {...props} className="trace-icon trace-icon--success" />;
        case 'agent_error':
            return <AlertCircle {...props} className="trace-icon trace-icon--error" />;

        default:
            return <Play {...props} className="trace-icon trace-icon--neutral" />;
    }
}

// ── Status badge ─────────────────────────────────────────────────

function StatusBadge({ status }: { status: TraceStatus }) {
    if (status === 'neutral' || status === 'running') return null;

    const config = {
        success: { label: 'OK', cls: 'trace-badge--success' },
        error: { label: 'ERROR', cls: 'trace-badge--error' },
        timeout: { label: 'TIMEOUT', cls: 'trace-badge--timeout' },
        halt: { label: 'HALT', cls: 'trace-badge--halt' },
    }[status];

    if (!config) return null;

    return <span className={`trace-badge ${config.cls}`}>{config.label}</span>;
}

// ── Model badge ──────────────────────────────────────────────────

function ModelBadge({ model }: { model?: string }) {
    if (!model) return null;
    const name = model.split('/').pop() || model;
    return <span className="trace-model-badge">{name}</span>;
}

// ── Main TraceRow Component ──────────────────────────────────────

interface TraceRowProps {
    row: FlatTraceRow;
    isExpanded: boolean;
    isSelected: boolean;
    onToggle: () => void;
    onSelect: () => void;
    totalDurationMs: number;
    minOffsetMs: number;
}

const TraceRow = React.memo(function TraceRow({
    row, isExpanded, isSelected, onToggle, onSelect, totalDurationMs, minOffsetMs,
}: TraceRowProps) {
    const { node, depth, isLastChild, parentIsLast } = row;
    const hasChildren = node.children.length > 0;

    // Waterfall bar positioning
    const barLeft = totalDurationMs > 0
        ? ((node.startMs - minOffsetMs) / totalDurationMs) * 100
        : 0;
    const barWidth = totalDurationMs > 0
        ? Math.max(0.5, (node.durationMs / totalDurationMs) * 100)
        : 0;

    const barColorClass = node.status === 'error' || node.status === 'timeout'
        ? 'trace-bar--error'
        : node.status === 'halt'
            ? 'trace-bar--halt'
            : node.status === 'success'
                ? 'trace-bar--success'
                : node.type === 'llm_attempt'
                    ? 'trace-bar--llm'
                    : node.type === 'system_group'
                        ? 'trace-bar--system'
                        : 'trace-bar--neutral';

    // Duration display
    const durationText = node.durationMs > 0 ? formatTraceDuration(node.durationMs) : '';

    return (
        <div
            className={`trace-row${isSelected ? ' trace-row--selected' : ''}${node.type === 'prompt' ? ' trace-row--prompt' : ''
                }`}
            data-trace-id={node.id}
            onClick={(e) => {
                e.stopPropagation();
                onSelect();
            }}
        >
            {/* ── Tree Column ── */}
            <div className="trace-tree-col" style={{ paddingLeft: depth * 20 }}>
                {/* Connector lines */}
                {depth > 0 && (
                    <div className="trace-connectors">
                        {Array.from({ length: depth }).map((_, d) => {
                            const isParentLast = d < parentIsLast.length ? parentIsLast[d] : false;
                            if (d === depth - 1) {
                                // Current level connector
                                return (
                                    <span
                                        key={d}
                                        className={`trace-connector ${isLastChild ? 'trace-connector--last' : 'trace-connector--mid'}`}
                                        style={{ left: d * 20 + 10 }}
                                    />
                                );
                            }
                            // Ancestor vertical lines
                            if (!isParentLast) {
                                return (
                                    <span
                                        key={d}
                                        className="trace-connector trace-connector--vert"
                                        style={{ left: d * 20 + 10 }}
                                    />
                                );
                            }
                            return null;
                        })}
                    </div>
                )}

                {/* Expand/collapse toggle */}
                {hasChildren ? (
                    <button
                        className="trace-toggle"
                        onClick={(e) => { e.stopPropagation(); onToggle(); }}
                    >
                        {isExpanded
                            ? <ChevronDown size={12} strokeWidth={2} />
                            : <ChevronRight size={12} strokeWidth={2} />
                        }
                    </button>
                ) : (
                    <span className="trace-toggle-spacer" />
                )}

                {/* Icon */}
                {getNodeIcon(node.type, node.status, node.event?.event_type)}

                {/* Label */}
                <span className="trace-label">{node.label}</span>

                {/* Model badge */}
                {node.type === 'llm_attempt' && <ModelBadge model={node.model} />}

                {/* Status badge */}
                <StatusBadge status={node.status} />

                {/* Error propagation dot */}
                {node.hasChildError && node.status !== 'error' && node.status !== 'timeout' && (
                    <span className="trace-error-dot" title="Contains errors" />
                )}
            </div>

            {/* ── Duration ── */}
            <div className="trace-dur-col">
                <span className="trace-dur-text">{durationText}</span>
            </div>

            {/* ── Waterfall Bar Column ── */}
            <div className="trace-bar-col">
                <div className="trace-bar-track">
                    {node.durationMs > 0 ? (
                        <div
                            className={`trace-bar ${barColorClass}`}
                            style={{ left: `${barLeft}%`, width: `${barWidth}%` }}
                        />
                    ) : (
                        <div
                            className="trace-bar-tick"
                            style={{ left: `${barLeft}%` }}
                        />
                    )}
                </div>
            </div>
        </div>
    );
});

export default TraceRow;
