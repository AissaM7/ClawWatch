// ── Agent Dashboard ──────────────────────────────────────────────
// Rich operational overview for a single agent.
// Computes ALL metrics from raw event data (task API fields are 0).

import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import type { Agent, Thread, Run, ClawEvent } from '../lib/types';
import { fetchAgents, fetchThreads, fetchRuns, fetchRunEvents } from '../lib/api';
import { estimateCost, formatCost } from '../lib/cost';
import {
    Bot, CheckCircle2, XCircle, AlertTriangle,
    Cpu, Wrench, DollarSign, MessageSquare,
    Activity, ShieldAlert, TrendingUp, ArrowRight,
    Clock, Zap, Send, Terminal, Globe, Hash,
} from 'lucide-react';
import '../agent-dashboard.css';

// ── Types ────────────────────────────────────────────────────────

interface RunMetrics {
    run: Run;
    llmCalls: number;
    toolCalls: number;
    toolErrors: number;
    models: string[];
    toolNames: string[];
    cost: number;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    goalSnippet: string;
}

// ── Helpers ──────────────────────────────────────────────────────

function formatDuration(ms: number | null): string {
    if (!ms) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function formatAge(ts: number): string {
    if (!ts) return '';
    const diffMs = Date.now() - ts * 1000;
    const diffH = Math.floor(diffMs / 3600000);
    if (diffH < 1) return 'just now';
    if (diffH < 24) return `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    return `${diffD}d ago`;
}

function formatTime(ts: number): string {
    if (!ts) return '';
    return new Date(ts * 1000).toLocaleString([], {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

function ChannelIcon({ channel }: { channel: string }) {
    switch (channel) {
        case 'telegram': return <Send size={14} />;
        case 'cli': return <Terminal size={14} />;
        case 'web': return <Globe size={14} />;
        default: return <Hash size={14} />;
    }
}

/** Compute per-run metrics from raw events */
function computeRunMetrics(run: Run, events: ClawEvent[]): RunMetrics {
    const llmStarts = events.filter(e => e.event_type === 'llm_call_start');
    const llmEnds = events.filter(e => e.event_type === 'llm_call_end');
    const toolStarts = events.filter(e => e.event_type === 'tool_call_start');
    const toolErrors = events.filter(e => e.event_type === 'tool_error');

    const models = [...new Set([
        ...llmStarts.map(e => e.model).filter(Boolean),
        ...llmEnds.map(e => e.model).filter(Boolean),
    ])] as string[];

    const toolNames = [...new Set(toolStarts.map(e => e.tool_name).filter(Boolean))] as string[];

    // Compute cost from LLM end events (tokens)
    let totalCost = 0;
    let inputTok = 0;
    let outputTok = 0;
    for (const e of llmEnds) {
        const inT = e.input_tokens || 0;
        const outT = e.output_tokens || 0;
        inputTok += inT;
        outputTok += outT;
        if (inT > 0 || outT > 0) {
            totalCost += estimateCost(e.model || 'unknown', inT, outT);
        }
    }

    // Duration from run timestamps (only count if run has ended)
    const durationMs = run.ended_at
        ? (run.ended_at - run.started_at) * 1000
        : 0;

    // Goal - take the first meaningful goal text, truncated
    const goalSnippet = (run.goal || '').split('\n')[0].slice(0, 100);

    return {
        run,
        llmCalls: llmStarts.length,
        toolCalls: toolStarts.length,
        toolErrors: toolErrors.length,
        models,
        toolNames,
        cost: totalCost,
        inputTokens: inputTok,
        outputTokens: outputTok,
        durationMs,
        goalSnippet,
    };
}

// ── Main Component ───────────────────────────────────────────────

export default function AgentDashboard() {
    const { agentId } = useParams<{ agentId: string }>();
    const navigate = useNavigate();
    const [agent, setAgent] = useState<Agent | null>(null);
    const [threads, setThreads] = useState<Thread[]>([]);
    const [runMetrics, setRunMetrics] = useState<RunMetrics[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!agentId) return;
        const load = async () => {
            try {
                const [agents, threadList, allRuns] = await Promise.all([
                    fetchAgents(),
                    fetchThreads(agentId),
                    fetchRuns(),
                ]);
                const a = agents.find(x => x.agent_id === agentId) || null;
                setAgent(a);
                setThreads(threadList);

                // Filter runs for this agent
                const agentRuns = allRuns.filter(r => r.agent_name === agentId);

                // Fetch events for all runs concurrently
                const runEventPairs = await Promise.all(
                    agentRuns.map(async (run) => {
                        try {
                            const events = await fetchRunEvents(run.run_id);
                            return { run, events };
                        } catch {
                            return { run, events: [] as ClawEvent[] };
                        }
                    })
                );

                // Compute per-run metrics
                const metrics = runEventPairs.map(({ run, events }) =>
                    computeRunMetrics(run, events)
                );
                setRunMetrics(metrics);
            } catch {
                // API not available
            } finally {
                setLoading(false);
            }
        };
        load();
    }, [agentId]);

    // ── Aggregate metrics across all runs ────────────────────────

    const agg = useMemo(() => {
        const totalRuns = runMetrics.length;
        const completedRuns = runMetrics.filter(m => m.run.status === 'completed').length;
        const errorRuns = runMetrics.filter(m => m.run.status === 'error').length;
        const runningRuns = runMetrics.filter(m => m.run.status === 'running').length;
        const completionRate = totalRuns > 0
            ? Math.round((completedRuns / totalRuns) * 100)
            : 0;

        const totalLLM = runMetrics.reduce((s, m) => s + m.llmCalls, 0);
        const totalTools = runMetrics.reduce((s, m) => s + m.toolCalls, 0);
        const totalToolErrors = runMetrics.reduce((s, m) => s + m.toolErrors, 0);
        const totalCost = runMetrics.reduce((s, m) => s + m.cost, 0);
        const totalInputTokens = runMetrics.reduce((s, m) => s + m.inputTokens, 0);
        const totalOutputTokens = runMetrics.reduce((s, m) => s + m.outputTokens, 0);
        const totalDuration = runMetrics.reduce((s, m) => s + m.durationMs, 0);

        // Unique models and tools across all runs
        const allModels = [...new Set(runMetrics.flatMap(m => m.models))];
        const allToolNames = [...new Set(runMetrics.flatMap(m => m.toolNames))];

        // Risk: count runs that have tool_error events
        const riskyRuns = runMetrics.filter(m => m.toolErrors > 0).length;

        return {
            totalRuns, completedRuns, errorRuns, runningRuns, completionRate,
            totalLLM, totalTools, totalToolErrors, totalCost,
            totalInputTokens, totalOutputTokens, totalDuration,
            allModels, allToolNames, riskyRuns,
        };
    }, [runMetrics]);

    // Per-run LLM call counts for activity chart (sorted by time)
    const activityData = useMemo(() => {
        return [...runMetrics]
            .sort((a, b) => a.run.started_at - b.run.started_at)
            .map(m => ({ llm: m.llmCalls, tools: m.toolCalls, goal: m.goalSnippet }));
    }, [runMetrics]);

    // Per-run tool call counts for tool activity chart
    const toolActivityData = useMemo(() => {
        return [...runMetrics]
            .sort((a, b) => a.run.started_at - b.run.started_at)
            .map(m => m.toolCalls);
    }, [runMetrics]);

    // Recent runs sorted by start time
    const recentRuns = useMemo(() => {
        return [...runMetrics]
            .sort((a, b) => b.run.started_at - a.run.started_at)
            .slice(0, 8);
    }, [runMetrics]);

    if (loading) {
        return (
            <div className="waiting-state">
                <div className="waiting-icon" />
                <p>Loading dashboard…</p>
            </div>
        );
    }

    return (
        <div className="agent-dash">
            {/* ── Header ── */}
            <div className="agent-dash-header">
                <div className="agent-dash-header-left">
                    <div className="breadcrumb">
                        <Link to="/agents">Agents</Link>
                        <span className="breadcrumb-sep">›</span>
                        <span>{agentId}</span>
                    </div>
                    <h1>
                        <Bot size={28} className="agent-dash-header-icon" />
                        {agentId}
                    </h1>
                    <p className="agent-dash-subtitle">
                        {threads.length} thread{threads.length !== 1 ? 's' : ''}
                        {' · '}{agg.totalRuns} run{agg.totalRuns !== 1 ? 's' : ''}
                        {' · '}{agg.allModels.length > 0 ? agg.allModels.join(', ') : 'no models'}
                        {agent && <> · Last active {formatAge(agent.last_active_at)}</>}
                    </p>
                </div>
            </div>

            {/* ── Hero KPI Cards ── */}
            <div className="agent-dash-kpis">
                <div className="kpi-card kpi-card--primary">
                    <div className="kpi-icon-wrap kpi-icon-wrap--green">
                        <CheckCircle2 size={20} />
                    </div>
                    <div className="kpi-body">
                        <div className="kpi-value">{agg.completionRate}%</div>
                        <div className="kpi-label">Run Completion</div>
                        <div className="kpi-detail">{agg.completedRuns}/{agg.totalRuns} runs</div>
                    </div>
                </div>

                <div className="kpi-card">
                    <div className="kpi-icon-wrap kpi-icon-wrap--purple">
                        <Cpu size={20} />
                    </div>
                    <div className="kpi-body">
                        <div className="kpi-value">{agg.totalLLM}</div>
                        <div className="kpi-label">LLM Calls</div>
                        <div className="kpi-detail">{agg.allModels.length} model{agg.allModels.length !== 1 ? 's' : ''}</div>
                    </div>
                </div>

                <div className="kpi-card">
                    <div className="kpi-icon-wrap kpi-icon-wrap--cyan">
                        <Wrench size={20} />
                    </div>
                    <div className="kpi-body">
                        <div className="kpi-value">{agg.totalTools}</div>
                        <div className="kpi-label">Tool Calls</div>
                        <div className="kpi-detail">{agg.allToolNames.length} unique tools</div>
                    </div>
                </div>

                <div className="kpi-card">
                    <div className="kpi-icon-wrap kpi-icon-wrap--orange">
                        <ShieldAlert size={20} />
                    </div>
                    <div className="kpi-body">
                        <div className="kpi-value">{agg.totalToolErrors}</div>
                        <div className="kpi-label">Errors</div>
                        <div className="kpi-detail">{agg.riskyRuns} run{agg.riskyRuns !== 1 ? 's' : ''} with errors</div>
                    </div>
                </div>

                <div className="kpi-card">
                    <div className="kpi-icon-wrap kpi-icon-wrap--gold">
                        <DollarSign size={20} />
                    </div>
                    <div className="kpi-body">
                        <div className="kpi-value">{formatCost(agg.totalCost)}</div>
                        <div className="kpi-label">Est. Cost</div>
                        <div className="kpi-detail">{formatDuration(agg.totalDuration)} total runtime</div>
                    </div>
                </div>

                <div className="kpi-card">
                    <div className="kpi-icon-wrap kpi-icon-wrap--blue">
                        <TrendingUp size={20} />
                    </div>
                    <div className="kpi-body">
                        <div className="kpi-value">{agg.totalRuns}</div>
                        <div className="kpi-label">Total Runs</div>
                        <div className="kpi-detail">
                            {agg.runningRuns > 0 && <span className="kpi-running">{agg.runningRuns} running</span>}
                            {agg.runningRuns === 0 && `${agg.errorRuns} failed`}
                        </div>
                    </div>
                </div>
            </div>

            {/* ── Analytics Row ── */}
            <div className="agent-dash-analytics">
                {/* Run Status Breakdown */}
                <div className="analytics-card">
                    <div className="analytics-card-header">
                        <Activity size={14} />
                        <span>Run Status</span>
                    </div>
                    <div className="status-bar-container">
                        <div className="status-bar">
                            {agg.completedRuns > 0 && (
                                <div
                                    className="status-bar-seg status-bar-seg--ok"
                                    style={{ width: `${(agg.completedRuns / agg.totalRuns) * 100}%` }}
                                    title={`${agg.completedRuns} completed`}
                                />
                            )}
                            {agg.runningRuns > 0 && (
                                <div
                                    className="status-bar-seg status-bar-seg--active"
                                    style={{ width: `${(agg.runningRuns / agg.totalRuns) * 100}%` }}
                                    title={`${agg.runningRuns} running`}
                                />
                            )}
                            {agg.errorRuns > 0 && (
                                <div
                                    className="status-bar-seg status-bar-seg--error"
                                    style={{ width: `${(agg.errorRuns / agg.totalRuns) * 100}%` }}
                                    title={`${agg.errorRuns} errors`}
                                />
                            )}
                        </div>
                        <div className="status-bar-legend">
                            {agg.completedRuns > 0 && <span className="legend-item"><span className="legend-dot legend-dot--ok" />{agg.completedRuns} completed</span>}
                            {agg.runningRuns > 0 && <span className="legend-item"><span className="legend-dot legend-dot--active" />{agg.runningRuns} running</span>}
                            {agg.errorRuns > 0 && <span className="legend-item"><span className="legend-dot legend-dot--error" />{agg.errorRuns} error</span>}
                        </div>
                    </div>
                </div>

                {/* LLM Activity per Run */}
                <div className="analytics-card">
                    <div className="analytics-card-header">
                        <Zap size={14} />
                        <span>LLM Calls by Run</span>
                    </div>
                    {activityData.some(d => d.llm > 0) ? (
                        <div className="activity-bars">
                            {activityData.map((d, i) => {
                                const max = Math.max(...activityData.map(x => x.llm), 1);
                                return (
                                    <div
                                        key={i}
                                        className="activity-bar activity-bar--llm"
                                        style={{ height: `${Math.max(4, (d.llm / max) * 100)}%` }}
                                        title={`${d.goal || `Run ${i + 1}`}: ${d.llm} LLM calls`}
                                    />
                                );
                            })}
                        </div>
                    ) : (
                        <div className="analytics-empty">No LLM activity</div>
                    )}
                </div>

                {/* Tool Activity per Run */}
                <div className="analytics-card">
                    <div className="analytics-card-header">
                        <Wrench size={14} />
                        <span>Tool Calls by Run</span>
                    </div>
                    {toolActivityData.some(v => v > 0) ? (
                        <div className="activity-bars">
                            {toolActivityData.map((v, i) => {
                                const max = Math.max(...toolActivityData, 1);
                                return (
                                    <div
                                        key={i}
                                        className="activity-bar activity-bar--tool"
                                        style={{ height: `${Math.max(4, (v / max) * 100)}%` }}
                                        title={`Run ${i + 1}: ${v} tool calls`}
                                    />
                                );
                            })}
                        </div>
                    ) : (
                        <div className="analytics-empty">No tool activity</div>
                    )}
                </div>
            </div>

            {/* ── Model & Tool Breakdown ── */}
            <div className="agent-dash-analytics">
                <div className="analytics-card">
                    <div className="analytics-card-header">
                        <Cpu size={14} />
                        <span>Models Used</span>
                    </div>
                    {agg.allModels.length > 0 ? (
                        <div className="tag-cloud">
                            {agg.allModels.map(m => (
                                <span key={m} className="tag tag--model">{m}</span>
                            ))}
                        </div>
                    ) : (
                        <div className="analytics-empty">No models detected</div>
                    )}
                </div>

                <div className="analytics-card analytics-card--wide">
                    <div className="analytics-card-header">
                        <Wrench size={14} />
                        <span>Tool Inventory ({agg.allToolNames.length})</span>
                    </div>
                    {agg.allToolNames.length > 0 ? (
                        <div className="tag-cloud">
                            {agg.allToolNames.map(t => (
                                <span key={t} className="tag tag--tool">{t}</span>
                            ))}
                        </div>
                    ) : (
                        <div className="analytics-empty">No tools detected</div>
                    )}
                </div>
            </div>

            {/* ── Threads Section ── */}
            <div className="agent-dash-section">
                <div className="agent-dash-section-header">
                    <MessageSquare size={16} />
                    <span>Threads</span>
                    <span className="section-count">{threads.length}</span>
                </div>
                <div className="thread-cards">
                    {threads.map(thread => (
                        <div
                            key={thread.thread_id}
                            className="thread-card"
                            onClick={() => navigate(`/thread/${thread.thread_id}`)}
                        >
                            <div className="thread-card-left">
                                <ChannelIcon channel={thread.channel} />
                                <span className="thread-card-name">
                                    {thread.display_name || thread.channel || 'Thread'}
                                </span>
                                <span className="thread-card-badge">{thread.channel.toUpperCase()}</span>
                            </div>
                            <div className="thread-card-stats">
                                <span>{thread.task_count} task{thread.task_count !== 1 ? 's' : ''}</span>
                                <span>{formatAge(thread.last_active_at)}</span>
                                <ArrowRight size={14} className="thread-card-arrow" />
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* ── Recent Runs Section ── */}
            <div className="agent-dash-section">
                <div className="agent-dash-section-header">
                    <Clock size={16} />
                    <span>Recent Runs</span>
                    <span className="section-count">{recentRuns.length}</span>
                </div>
                <div className="recent-tasks">
                    {recentRuns.map((rm) => (
                        <div
                            key={rm.run.run_id}
                            className="recent-task-row"
                            onClick={() => navigate(`/run/${rm.run.run_id}`)}
                        >
                            <div className="recent-task-status">
                                {rm.run.status === 'completed' && <CheckCircle2 size={14} className="rt-icon rt-icon--ok" />}
                                {rm.run.status === 'error' && <XCircle size={14} className="rt-icon rt-icon--error" />}
                                {rm.run.status === 'running' && <Activity size={14} className="rt-icon rt-icon--active" />}
                                {rm.run.status === 'unknown' && <AlertTriangle size={14} className="rt-icon rt-icon--warn" />}
                            </div>
                            <div className="recent-task-body">
                                <div className="recent-task-prompt">
                                    {rm.goalSnippet || 'No goal'}
                                </div>
                                <div className="recent-task-meta">
                                    <span>{rm.llmCalls} LLM</span>
                                    <span>{rm.toolCalls} tools</span>
                                    {rm.toolErrors > 0 && <span className="kpi-critical">{rm.toolErrors} err</span>}
                                    <span>{formatDuration(rm.durationMs)}</span>
                                    <span>{formatTime(rm.run.started_at)}</span>
                                </div>
                            </div>
                            <ArrowRight size={14} className="recent-task-arrow" />
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
