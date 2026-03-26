// ── InspectorPanel: Tabbed Detail Panel ─────────────────────────
// Slide-in panel showing detailed event information with tabs for
// Input, Output, Metadata, and Raw JSON.

import { useState } from 'react';
import { X, Clock, Coins, Cpu, AlertTriangle, ShieldCheck } from 'lucide-react';
import type { TraceNode } from '../lib/traceTree';
import { estimateCost } from '../lib/cost';
import { formatTraceDuration } from '../lib/traceTree';

// ── Tab types ────────────────────────────────────────────────────

type TabId = 'input' | 'output' | 'metadata' | 'raw';

interface TabDef {
    id: TabId;
    label: string;
    available: boolean;
}

// ── Main Component ───────────────────────────────────────────────

interface InspectorPanelProps {
    node: TraceNode;
    onClose: () => void;
}

export default function InspectorPanel({ node, onClose }: InspectorPanelProps) {
    const primaryEvent = node.event || node.events[0];
    if (!primaryEvent) return null;

    const [activeTab, setActiveTab] = useState<TabId>('input');

    // Determine available tabs
    const hasInput = !!(primaryEvent.prompt_preview || primaryEvent.tool_args);
    const hasOutput = !!(primaryEvent.llm_output_full || primaryEvent.tool_result ||
        primaryEvent.error_message || primaryEvent.error_traceback);

    const tabs: TabDef[] = [
        { id: 'input', label: 'Input', available: hasInput },
        { id: 'output', label: 'Output', available: hasOutput },
        { id: 'metadata', label: 'Metadata', available: true },
        { id: 'raw', label: 'Raw JSON', available: true },
    ];

    // Auto-select first available tab
    const selectedTab = tabs.find(t => t.id === activeTab)?.available
        ? activeTab
        : tabs.find(t => t.available)?.id || 'metadata';

    // Cost calculation
    const cost = primaryEvent.event_type === 'llm_call_end'
        ? estimateCost(primaryEvent.model || '', primaryEvent.input_tokens || 0, primaryEvent.output_tokens || 0)
        : 0;

    // Format tool args
    const formattedToolArgs = (() => {
        if (!primaryEvent.tool_args) return null;
        try {
            return JSON.stringify(JSON.parse(primaryEvent.tool_args), null, 2);
        } catch {
            return primaryEvent.tool_args;
        }
    })();

    // Status styling
    const statusClass = node.status === 'error' || node.status === 'timeout'
        ? 'inspector-status--error'
        : node.status === 'success'
            ? 'inspector-status--success'
            : 'inspector-status--neutral';

    const statusLabel = node.status === 'timeout' ? 'Timed Out'
        : node.status === 'error' ? 'Error'
            : node.status === 'success' ? 'Success'
                : node.status === 'running' ? 'Running'
                    : 'Neutral';

    return (
        <div className="inspector-panel">
            {/* ── Header ── */}
            <div className="inspector-header">
                <div className="inspector-header-top">
                    <div className="inspector-header-left">
                        <span className={`inspector-status ${statusClass}`}>{statusLabel}</span>
                        <span className="inspector-event-type">{primaryEvent.event_type}</span>
                    </div>
                    <button className="inspector-close" onClick={onClose}>
                        <X size={16} strokeWidth={2} />
                    </button>
                </div>
                <h2 className="inspector-title">{node.label}</h2>

                {/* Quick stats */}
                <div className="inspector-stats">
                    {node.durationMs > 0 && (
                        <span className="inspector-stat">
                            <Clock size={12} />
                            {formatTraceDuration(node.durationMs)}
                        </span>
                    )}
                    {primaryEvent.input_tokens != null && (
                        <span className="inspector-stat">
                            ↑ {primaryEvent.input_tokens.toLocaleString()} tok
                        </span>
                    )}
                    {primaryEvent.output_tokens != null && (
                        <span className="inspector-stat">
                            ↓ {primaryEvent.output_tokens.toLocaleString()} tok
                        </span>
                    )}
                    {cost > 0 && (
                        <span className="inspector-stat">
                            <Coins size={12} />
                            ${cost.toFixed(4)}
                        </span>
                    )}
                    {primaryEvent.model && (
                        <span className="inspector-stat">
                            <Cpu size={12} />
                            {primaryEvent.model.split('/').pop()}
                        </span>
                    )}
                    {primaryEvent.risk && primaryEvent.risk.level !== 'safe' && (
                        <span className={`inspector-stat inspector-stat--risk-${primaryEvent.risk.level}`}>
                            <AlertTriangle size={12} />
                            {primaryEvent.risk.level}
                        </span>
                    )}
                </div>
            </div>

            {/* ── Tabs ── */}
            <div className="inspector-tabs">
                {tabs.filter(t => t.available).map(tab => (
                    <button
                        key={tab.id}
                        className={`inspector-tab${selectedTab === tab.id ? ' inspector-tab--active' : ''}`}
                        onClick={() => setActiveTab(tab.id)}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>

            {/* ── Tab Content ── */}
            <div className="inspector-body">
                {selectedTab === 'input' && (
                    <div className="inspector-content">
                        {primaryEvent.prompt_preview && (
                            <div className="inspector-section">
                                <div className="inspector-section-label">PROMPT</div>
                                <pre className="inspector-code">{primaryEvent.prompt_preview}</pre>
                            </div>
                        )}
                        {formattedToolArgs && (
                            <div className="inspector-section">
                                <div className="inspector-section-label">ARGUMENTS</div>
                                <pre className="inspector-code">{formattedToolArgs}</pre>
                            </div>
                        )}
                        {!primaryEvent.prompt_preview && !formattedToolArgs && (
                            <div className="inspector-empty">No input data available</div>
                        )}
                    </div>
                )}

                {selectedTab === 'output' && (
                    <div className="inspector-content">
                        {primaryEvent.llm_output_full && (
                            <div className="inspector-section">
                                <div className="inspector-section-label">LLM OUTPUT</div>
                                <pre className="inspector-code">{primaryEvent.llm_output_full.slice(0, 8192)}</pre>
                            </div>
                        )}
                        {primaryEvent.tool_result && (
                            <div className="inspector-section">
                                <div className="inspector-section-label">TOOL RESULT</div>
                                <pre className="inspector-code">{primaryEvent.tool_result.slice(0, 4096)}</pre>
                            </div>
                        )}
                        {(primaryEvent.error_message || primaryEvent.error_traceback) && (
                            <div className="inspector-section inspector-section--error">
                                <div className="inspector-section-label">ERROR</div>
                                {primaryEvent.error_message && (
                                    <pre className="inspector-code inspector-code--error">
                                        {primaryEvent.error_message}
                                    </pre>
                                )}
                                {primaryEvent.error_traceback && (
                                    <pre className="inspector-code inspector-code--error">
                                        {primaryEvent.error_traceback}
                                    </pre>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {selectedTab === 'metadata' && (
                    <div className="inspector-content">
                        <div className="inspector-section">
                            <div className="inspector-section-label">EVENT DETAILS</div>
                            <div className="inspector-meta-grid">
                                <MetaRow label="Event ID" value={primaryEvent.event_id} mono />
                                <MetaRow label="Run ID" value={primaryEvent.run_id} mono />
                                <MetaRow label="Type" value={primaryEvent.event_type} />
                                <MetaRow label="Sequence" value={String(primaryEvent.sequence_num)} />
                                {primaryEvent.model && <MetaRow label="Model" value={primaryEvent.model} />}
                                {primaryEvent.tool_name && <MetaRow label="Tool" value={primaryEvent.tool_name} />}
                                {primaryEvent.duration_ms != null && (
                                    <MetaRow label="Duration" value={formatTraceDuration(primaryEvent.duration_ms)} />
                                )}
                                {primaryEvent.file_path && <MetaRow label="File" value={primaryEvent.file_path} mono />}
                                {primaryEvent.url && <MetaRow label="URL" value={primaryEvent.url} mono />}
                            </div>
                        </div>

                        {/* Goal alignment */}
                        {primaryEvent.goal_alignment && (
                            <div className="inspector-section">
                                <div className="inspector-section-label">GOAL ALIGNMENT</div>
                                <div className="inspector-meta-grid">
                                    <MetaRow label="Score" value={`${primaryEvent.goal_alignment.score}/100`} />
                                    <MetaRow label="Status" value={primaryEvent.goal_alignment.is_on_goal ? 'On-Goal' : 'Off-Goal'} />
                                    {primaryEvent.goal_alignment.matched_tokens.length > 0 && (
                                        <MetaRow label="Matched" value={primaryEvent.goal_alignment.matched_tokens.slice(0, 5).join(', ')} />
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Risk rules */}
                        {primaryEvent.risk && primaryEvent.risk.rules.length > 0 && (
                            <div className="inspector-section">
                                <div className="inspector-section-label">RISK RULES</div>
                                {primaryEvent.risk.rules.map((rule, i) => (
                                    <div key={i} className={`inspector-risk-rule inspector-risk-rule--${rule.level}`}>
                                        <ShieldCheck size={12} />
                                        <span className="inspector-risk-name">{rule.name}</span>
                                        <span className="inspector-risk-expl">{rule.explanation}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {selectedTab === 'raw' && (
                    <div className="inspector-content">
                        <pre className="inspector-code inspector-code--json">
                            {JSON.stringify(primaryEvent, null, 2)}
                        </pre>
                    </div>
                )}
            </div>
        </div>
    );
}

// ── MetaRow helper ───────────────────────────────────────────────

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
    return (
        <div className="inspector-meta-row">
            <span className="inspector-meta-label">{label}</span>
            <span className={`inspector-meta-value${mono ? ' inspector-meta-value--mono' : ''}`}>
                {value}
            </span>
        </div>
    );
}
