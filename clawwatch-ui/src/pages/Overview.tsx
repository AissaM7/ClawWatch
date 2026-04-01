// ── Overview Dashboard ───────────────────────────────────────────
// Fleet-level view: KPIs + System Topology Brain Graph + recent runs + agent fleet.

import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Run, Agent, ClawEvent } from '../lib/types';
import { fetchRuns, fetchAgents, fetchHealth, createSSEConnection, fetchRunEvents } from '../lib/api';
import SystemTopology from '../components/BrainGraph/SystemTopology';
import {
    Activity, Bot, CheckCircle2, XCircle, AlertTriangle,
    TrendingUp, Zap,
    ArrowRight, Clock, Wifi, WifiOff, ShieldAlert,
} from 'lucide-react';

// ── Helpers ──────────────────────────────────────────────────────

function formatDuration(ms: number): string {
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
    return new Date(ts * 1000).toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit',
    });
}

function runDurationMs(run: Run): number {
    const end = run.ended_at || Date.now() / 1000;
    return (end - run.started_at) * 1000;
}

// ── Main Component ───────────────────────────────────────────────

export default function Overview() {
    const navigate = useNavigate();
    const [runs, setRuns] = useState<Run[]>([]);
    const [agents, setAgents] = useState<Agent[]>([]);
    const [connected, setConnected] = useState(false);
    const [loading, setLoading] = useState(true);

    // Brain Graph event state
    const [historicalEvents, setHistoricalEvents] = useState<ClawEvent[]>([]);
    const [liveEvents, setLiveEvents] = useState<ClawEvent[]>([]);
    const [isLive, setIsLive] = useState(false);

    // Initial data load
    useEffect(() => {
        const load = async () => {
            try {
                const [r, a, h] = await Promise.all([
                    fetchRuns(), fetchAgents(), fetchHealth(),
                ]);
                setRuns(r);
                setAgents(a);
                setConnected(h);

                // Seed the brain graph with events from recent runs
                if (r.length > 0) {
                    const sorted = [...r].sort((a, b) => b.started_at - a.started_at);
                    // Load events from up to the 5 most recent runs
                    const recentIds = sorted.slice(0, 5).map(run => run.run_id);
                    const allEventsArrays = await Promise.all(
                        recentIds.map(id => fetchRunEvents(id).catch(() => [] as ClawEvent[]))
                    );
                    const allEvents = allEventsArrays.flat();
                    setHistoricalEvents(allEvents);

                    // If there's an active run, mark as live
                    const activeRun = sorted.find(run => run.status === 'running');
                    if (activeRun) setIsLive(true);
                }
            } catch { /* server may not be ready */ }
            finally { setLoading(false); }
        };
        load();
        const interval = setInterval(async () => {
            try {
                const h = await fetchHealth();
                setConnected(h);
                if (!h) {
                    setIsLive(false);
                } else {
                    const [r, a] = await Promise.all([
                        fetchRuns(), fetchAgents(),
                    ]);
                    setRuns(r);
                    setAgents(a);
                }
            } catch {
                setConnected(false);
                setIsLive(false);
            }
        }, 15000);
        return () => clearInterval(interval);
    }, []);

    // SSE for live events → feed into brain graph
    useEffect(() => {
        const cleanup = createSSEConnection((event: ClawEvent) => {
            // Update runs list
            setRuns(prev => {
                const existing = prev.find(r => r.run_id === event.run_id);
                if (existing) {
                    return prev.map(r =>
                        r.run_id === event.run_id
                            ? { ...r, event_count: (r.event_count || 0) + 1, status: event.event_type === 'agent_end' ? (event.status || 'completed') : r.status }
                            : r
                    );
                }
                if (event.event_type === 'agent_start') {
                    return [{
                        run_id: event.run_id,
                        agent_name: event.agent_name || 'agent',
                        goal: event.goal || 'Awaiting prompt...',
                        started_at: event.wall_ts,
                        ended_at: null,
                        status: 'running',
                        event_count: 1,
                        db_path: '',
                    }, ...prev];
                }
                return prev;
            });

            // Feed brain graph
            if (event.event_type === 'agent_start') {
                setIsLive(true);
            } else if (event.event_type === 'agent_end') {
                setIsLive(false);
            }
            setLiveEvents(prev => [...prev.slice(-999), event]);
        });
        return cleanup;
    }, []);

    // ── Aggregate KPIs ───────────────────────────────────────────
    const kpi = useMemo(() => {
        const total = runs.length;
        const running = runs.filter(r => r.status === 'running').length;
        const completed = runs.filter(r => r.status === 'completed').length;
        const errors = runs.filter(r => r.status === 'error').length;
        const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;
        const totalDurationMs = runs.reduce((s, r) => s + runDurationMs(r), 0);
        return { total, running, completed, errors, successRate, totalDurationMs };
    }, [runs]);

    // Recent runs (last 8)
    const recentRuns = useMemo(() =>
        [...runs].sort((a, b) => b.started_at - a.started_at).slice(0, 8),
        [runs]
    );

    if (loading) {
        return (
            <div className="waiting-state">
                <div className="waiting-icon" />
                <p>Loading overview…</p>
            </div>
        );
    }

    return (
        <div className="overview-page">
            {/* ── Header ── */}
            <div className="overview-header">
                <div>
                    <h1>Overview</h1>
                    <p className="overview-subtitle">
                        {connected
                            ? <><Wifi size={12} className="overview-online-icon" /> Connected</>
                            : <><WifiOff size={12} /> Offline</>
                        }
                        {' · '}{agents.length} agent{agents.length !== 1 ? 's' : ''}
                        {' · '}{runs.length} run{runs.length !== 1 ? 's' : ''}
                    </p>
                </div>
            </div>

            {/* ── KPI Row ── */}
            <div className="overview-kpis">
                <div className="ov-kpi ov-kpi--primary" onClick={() => navigate('/runs')}>
                    <div className="ov-kpi-icon ov-kpi-icon--blue"><TrendingUp size={20} /></div>
                    <div className="ov-kpi-body">
                        <div className="ov-kpi-value">{kpi.total}</div>
                        <div className="ov-kpi-label">Total Runs</div>
                    </div>
                </div>

                <div className="ov-kpi" onClick={() => navigate('/runs')}>
                    <div className="ov-kpi-icon ov-kpi-icon--green"><Activity size={20} /></div>
                    <div className="ov-kpi-body">
                        <div className="ov-kpi-value">{kpi.running}</div>
                        <div className="ov-kpi-label">Active Now</div>
                    </div>
                </div>

                <div className="ov-kpi">
                    <div className="ov-kpi-icon ov-kpi-icon--emerald"><CheckCircle2 size={20} /></div>
                    <div className="ov-kpi-body">
                        <div className="ov-kpi-value">{kpi.successRate}%</div>
                        <div className="ov-kpi-label">Success Rate</div>
                    </div>
                </div>

                <div className="ov-kpi" onClick={() => navigate('/security')}>
                    <div className="ov-kpi-icon ov-kpi-icon--red"><ShieldAlert size={20} /></div>
                    <div className="ov-kpi-body">
                        <div className="ov-kpi-value">{kpi.errors}</div>
                        <div className="ov-kpi-label">Errors</div>
                    </div>
                </div>

                <div className="ov-kpi">
                    <div className="ov-kpi-icon ov-kpi-icon--purple"><Clock size={20} /></div>
                    <div className="ov-kpi-body">
                        <div className="ov-kpi-value">{formatDuration(kpi.totalDurationMs)}</div>
                        <div className="ov-kpi-label">Total Runtime</div>
                    </div>
                </div>
            </div>

            {/* ── Brain Graph Hero ── */}
            <SystemTopology
                events={historicalEvents}
                liveEvents={liveEvents}
                isLive={isLive}
                connected={connected}
            />

            {/* ── Two-column layout ── */}
            <div className="overview-grid">
                {/* ── Recent Runs ── */}
                <div className="overview-card overview-card--wide">
                    <div className="overview-card-header">
                        <Zap size={15} />
                        <span>Recent Runs</span>
                        <button className="overview-card-link" onClick={() => navigate('/runs')}>
                            View all <ArrowRight size={12} />
                        </button>
                    </div>
                    <div className="overview-run-list">
                        {recentRuns.length === 0 && (
                            <div className="overview-empty">No runs recorded yet.</div>
                        )}
                        {recentRuns.map(run => (
                            <div
                                key={run.run_id}
                                className="ov-run-row"
                                onClick={() => navigate(`/run/${run.run_id}`)}
                            >
                                <div className="ov-run-status">
                                    {run.status === 'completed' && <CheckCircle2 size={14} className="ov-icon--ok" />}
                                    {run.status === 'error' && <XCircle size={14} className="ov-icon--error" />}
                                    {run.status === 'running' && <Activity size={14} className="ov-icon--active" />}
                                    {!['completed', 'error', 'running'].includes(run.status) && <AlertTriangle size={14} className="ov-icon--warn" />}
                                </div>
                                <div className="ov-run-body">
                                    <div className="ov-run-agent">{run.agent_name}</div>
                                    <div className="ov-run-goal">{run.goal || 'Awaiting prompt…'}</div>
                                </div>
                                <div className="ov-run-meta">
                                    <span>{run.event_count} events</span>
                                    <span>{formatTime(run.started_at)}</span>
                                </div>
                                <ArrowRight size={14} className="ov-run-arrow" />
                            </div>
                        ))}
                    </div>
                </div>

                {/* ── Agent Fleet ── */}
                <div className="overview-card">
                    <div className="overview-card-header">
                        <Bot size={15} />
                        <span>Agent Fleet</span>
                        <button className="overview-card-link" onClick={() => navigate('/agents')}>
                            View all <ArrowRight size={12} />
                        </button>
                    </div>
                    <div className="overview-agent-list">
                        {agents.length === 0 && (
                            <div className="overview-empty">No agents registered.</div>
                        )}
                        {agents.map(agent => {
                            const agentRuns = runs.filter(r => r.agent_name === agent.agent_id);
                            const activeRuns = agentRuns.filter(r => r.status === 'running').length;
                            return (
                                <div
                                    key={agent.agent_id}
                                    className="ov-agent-row"
                                    onClick={() => navigate(`/agent/${encodeURIComponent(agent.agent_id)}`)}
                                >
                                    <div className="ov-agent-dot-wrap">
                                        <span className={`ov-agent-dot ${activeRuns > 0 ? 'ov-agent-dot--active' : ''}`} />
                                    </div>
                                    <div className="ov-agent-body">
                                        <div className="ov-agent-name">{agent.agent_id}</div>
                                        <div className="ov-agent-meta">
                                            {agent.thread_count} thread{agent.thread_count !== 1 ? 's' : ''}
                                            {' · '}{agent.total_tasks} task{agent.total_tasks !== 1 ? 's' : ''}
                                            {' · '}{formatAge(agent.last_active_at)}
                                        </div>
                                    </div>
                                    <ArrowRight size={14} className="ov-agent-arrow" />
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
}
