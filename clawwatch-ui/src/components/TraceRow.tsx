// ── TraceRow: Recursive Trace Row Component ─────────────────────
// Renders a single row in the hierarchical trace tree with nesting
// lines, icons, status badges, and waterfall duration bars.

import React from 'react';
import {
    Cpu, Wrench, Settings2, Terminal, AlertCircle, AlertTriangle,
    ChevronRight, ChevronDown, Play, Square, FileText,
    Globe, Zap
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
                return <Square {...props} className="trace-icon trace-icon--success" />;
            return <Square {...props} className="trace-icon trace-icon--neutral" />;
        case 'event':
            if (eventType?.startsWith('file_'))
                return <FileText {...props} className="trace-icon trace-icon--file" />;
            if (eventType?.startsWith('network_'))
                return <Globe {...props} className="trace-icon trace-icon--net" />;
            if (eventType?.startsWith('subprocess'))
                return <Zap {...props} className="trace-icon trace-icon--sub" />;
            return <Play {...props} className="trace-icon trace-icon--neutral" />;
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
