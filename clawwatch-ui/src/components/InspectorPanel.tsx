// ── InspectorPanel: Tabbed Detail Panel ─────────────────────────
// Slide-in panel showing detailed event information with tabs for
// Input, Output, Metadata, and Raw JSON.

import { useState } from 'react';
import {
    AlertTriangle, ShieldCheck, X, Clock, Coins, Cpu
} from 'lucide-react';
import type { TraceNode } from '../lib/traceTree';
import { estimateCost } from '../lib/cost';
import { formatTraceDuration } from '../lib/traceTree';
import { markSecurityEventSafe } from '../lib/api';

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
    const [markSafeState, setMarkSafeState] = useState<'idle' | 'loading' | 'done'>('idle');

    const handleMarkSafe = async (eventId: string) => {
        setMarkSafeState('loading');
        try {
            await markSecurityEventSafe(eventId);
            setMarkSafeState('done');
        } catch {
            setMarkSafeState('idle');
        }
    };

    // Determine available tabs
    const hasInput = !!(primaryEvent.prompt_preview || primaryEvent.tool_args);
    const hasOutput = !!(primaryEvent.llm_output_full || primaryEvent.tool_result ||
        primaryEvent.error_message || primaryEvent.error_traceback);

    const tabs: TabDef[] = [
        { id: 'metadata', label: 'Metadata', available: true },
        { id: 'input', label: 'Input', available: hasInput },
        { id: 'output', label: 'Output', available: hasOutput },
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

                        {/* Security events */}
                        {primaryEvent.security_events && primaryEvent.security_events.length > 0 && (
                            <div className="inspector-section">
                                <div className="inspector-section-label">SECURITY ALERTS</div>
                                <div className="inspector-rules">
                                    {primaryEvent.security_events.map((se, i) => {
                                        const secColor = se.severity === 'critical' ? '#ef4444' : se.severity === 'high' ? '#f97316' : se.severity === 'medium' ? '#eab308' : '#3b82f6';
                                        return (
                                            <div key={i} className={`inspector-rule inspector-rule--${se.severity}`} style={{ marginBottom: '12px', borderLeft: `2px solid ${secColor}`, paddingLeft: '8px' }}>
                                                <div className="inspector-rule-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                                                    <span className="inspector-rule-name" style={{ fontWeight: 600, color: '#fff' }}>{se.label}</span>
                                                    <span className={`inspector-rule-level inspector-rule-level--${se.severity}`} style={{ fontSize: '9px', padding: '2px 6px', borderRadius: '4px', textTransform: 'uppercase', background: `${secColor}33`, color: secColor }}>
                                                        {se.severity}
                                                    </span>
                                                </div>
                                                <div className="inspector-rule-desc" style={{
                                                    fontSize: '10px',
                                                    color: 'rgba(255,255,255,0.7)',
                                                    fontFamily: 'var(--font-mono)',
                                                    whiteSpace: 'pre-wrap',
                                                    wordBreak: 'break-word',
                                                    maxHeight: '150px',
                                                    overflowY: 'auto',
                                                    background: 'rgba(0,0,0,0.3)',
                                                    padding: '8px',
                                                    borderRadius: '4px',
                                                    border: '1px solid rgba(255,255,255,0.05)'
                                                }}>
                                                    {se.description}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {/* Risk rules */}
                        {primaryEvent.risk && primaryEvent.risk.rules.length > 0 && (
                            <div className="inspector-section">
                                <div className="inspector-section-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <span>RISK RULES</span>
                                    {markSafeState !== 'done' ? (
                                        <button
                                            onClick={() => handleMarkSafe(primaryEvent.event_id)}
                                            style={{
                                                background: 'transparent', border: '1px solid currentColor', color: 'inherit',
                                                padding: '2px 8px', borderRadius: '4px', fontSize: '10px', cursor: 'pointer',
                                                display: 'flex', alignItems: 'center', gap: '4px', opacity: 0.7
                                            }}
                                            disabled={markSafeState === 'loading'}
                                        >
                                            <ShieldCheck size={10} /> {markSafeState === 'loading' ? 'Marking...' : 'Mark Safe'}
                                        </button>
                                    ) : (
                                        <span style={{ fontSize: '10px', color: '#10b981', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                            <ShieldCheck size={10} /> Marked Safe
                                        </span>
                                    )}
                                </div>
                                {primaryEvent.risk.rules.map((rule, i) => {
                                    const rColor = rule.level === 'critical' ? '#ef4444' : rule.level === 'high' ? '#f97316' : rule.level === 'medium' ? '#eab308' : '#3b82f6';
                                    return (
                                        <div key={i} className={`inspector-rule inspector-rule--${rule.level}`} style={{ marginBottom: '12px', borderLeft: `2px solid ${rColor}`, paddingLeft: '8px' }}>
                                            <div className="inspector-rule-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                                                <span className="inspector-rule-name" style={{ fontWeight: 600, color: '#fff' }}>{rule.name}</span>
                                                <span className={`inspector-rule-level inspector-rule-level--${rule.level}`} style={{ fontSize: '9px', padding: '2px 6px', borderRadius: '4px', textTransform: 'uppercase', background: `${rColor}33`, color: rColor }}>
                                                    {rule.level.toUpperCase()}
                                                </span>
                                            </div>
                                            <div className="inspector-rule-desc" style={{
                                                fontSize: '10px',
                                                color: 'rgba(255,255,255,0.7)',
                                                fontFamily: 'var(--font-mono)',
                                                whiteSpace: 'pre-wrap',
                                                wordBreak: 'break-word',
                                                maxHeight: '150px',
                                                overflowY: 'auto',
                                                background: 'rgba(0,0,0,0.3)',
                                                padding: '8px',
                                                borderRadius: '4px',
                                                border: '1px solid rgba(255,255,255,0.05)'
                                            }}>{rule.explanation}</div>
                                        </div>
                                    );
                                })}
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
    if (!value) return null;
    return (
        <div className="inspector-meta-row" style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            padding: '8px 12px',
            background: 'rgba(255,255,255,0.02)',
            borderRadius: '4px',
            marginBottom: '6px',
            border: '1px solid rgba(255,255,255,0.05)'
        }}>
            <span className="inspector-meta-label" style={{
                color: 'rgba(255,255,255,0.5)',
                fontSize: '10px',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                flexShrink: 0,
                marginRight: '16px'
            }}>{label}</span>
            <span className={`inspector-meta-value${mono ? ' inspector-meta-value--mono' : ''}`} style={{
                color: 'rgba(255,255,255,0.95)',
                fontSize: '11px',
                fontFamily: mono ? 'var(--font-mono)' : 'inherit',
                wordBreak: 'break-all',
                textAlign: 'right'
            }}>
                {value}
            </span>
        </div>
    );
}
