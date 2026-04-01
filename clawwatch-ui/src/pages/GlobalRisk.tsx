// ── Global Risk Dashboard ────────────────────────────────────────
// Cross-run risk aggregation: top flagged events, risk distribution.

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ClawEvent, EnrichedEvent } from '../lib/types';
import { fetchRuns, fetchRunEvents } from '../lib/api';
import { scoreEvent } from '../lib/risk';
import { scoreGoalAlignment } from '../lib/goalAlignment';
import { buildDescription, formatOffset } from '../lib/descriptions';
import { ShieldAlert, ArrowRight, CheckCircle2 } from 'lucide-react';

function enrichEvents(events: ClawEvent[], goal: string): EnrichedEvent[] {
    return events.map(e => ({
        ...e,
        risk: scoreEvent(e, events),
        goal_alignment: scoreGoalAlignment(e, goal),
        description: buildDescription(e),
    }));
}

interface FlaggedEvent extends EnrichedEvent {
    _runId: string;
    _agentName: string;
}

export default function GlobalRisk() {
    const navigate = useNavigate();
    const [loading, setLoading] = useState(true);
    const [flaggedEvents, setFlaggedEvents] = useState<FlaggedEvent[]>([]);
    const [riskDistro, setRiskDistro] = useState({ safe: 0, low: 0, medium: 0, high: 0, critical: 0 });
    const [runCount, setRunCount] = useState(0);

    useEffect(() => {
        const load = async () => {
            try {
                const runs = await fetchRuns();
                setRunCount(runs.length);

                // Fetch events for all runs (limit to most recent 20 for perf)
                const recentRuns = [...runs].sort((a, b) => b.started_at - a.started_at).slice(0, 20);
                const allFlagged: FlaggedEvent[] = [];
                const distro = { safe: 0, low: 0, medium: 0, high: 0, critical: 0 };

                await Promise.all(recentRuns.map(async (run) => {
                    try {
                        const raw = await fetchRunEvents(run.run_id);
                        const enriched = enrichEvents(raw, run.goal);
                        for (const e of enriched) {
                            distro[e.risk.level]++;
                            if (e.risk.requires_review) {
                                allFlagged.push({ ...e, _runId: run.run_id, _agentName: run.agent_name });
                            }
                        }
                    } catch { /* skip */ }
                }));

                allFlagged.sort((a, b) => b.risk.score - a.risk.score);
                setFlaggedEvents(allFlagged.slice(0, 50));
                setRiskDistro(distro);
            } catch { /* skip */ }
            finally { setLoading(false); }
        };
        load();
    }, []);

    if (loading) {
        return (
            <div className="waiting-state">
                <div className="waiting-icon" />
                <p>Analyzing risk across runs…</p>
            </div>
        );
    }

    const totalEvents = Object.values(riskDistro).reduce((s, v) => s + v, 0);

    return (
        <div className="global-page">
            <div className="global-page-header">
                <h1><ShieldAlert size={24} /> Risk Overview</h1>
                <p>{flaggedEvents.length} flagged events across {runCount} runs</p>
            </div>

            {/* Risk Distribution */}
            <div className="global-kpis">
                {(['critical', 'high', 'medium', 'low', 'safe'] as const).map(level => (
                    <div key={level} className={`global-kpi global-kpi--${level}`}>
                        <div className="global-kpi-value">{riskDistro[level]}</div>
                        <div className="global-kpi-label">{level.charAt(0).toUpperCase() + level.slice(1)}</div>
                        <div className="global-kpi-pct">
                            {totalEvents > 0 ? Math.round((riskDistro[level] / totalEvents) * 100) : 0}%
                        </div>
                    </div>
                ))}
            </div>

            {/* Risk Bar */}
            {totalEvents > 0 && (
                <div className="global-risk-bar">
                    {riskDistro.critical > 0 && <div className="grb-seg grb-seg--critical" style={{ width: `${(riskDistro.critical / totalEvents) * 100}%` }} />}
                    {riskDistro.high > 0 && <div className="grb-seg grb-seg--high" style={{ width: `${(riskDistro.high / totalEvents) * 100}%` }} />}
                    {riskDistro.medium > 0 && <div className="grb-seg grb-seg--medium" style={{ width: `${(riskDistro.medium / totalEvents) * 100}%` }} />}
                    {riskDistro.low > 0 && <div className="grb-seg grb-seg--low" style={{ width: `${(riskDistro.low / totalEvents) * 100}%` }} />}
                    {riskDistro.safe > 0 && <div className="grb-seg grb-seg--safe" style={{ width: `${(riskDistro.safe / totalEvents) * 100}%` }} />}
                </div>
            )}

            {/* Flagged Events */}
            <div className="global-section">
                <div className="global-section-title">Top Flagged Events</div>
                {flaggedEvents.length === 0 ? (
                    <div className="global-empty">
                        <CheckCircle2 size={20} />
                        <span>No events requiring review across all runs.</span>
                    </div>
                ) : (
                    <div className="global-event-list">
                        {flaggedEvents.map(event => (
                            <div
                                key={event.event_id}
                                className="global-event-row"
                                onClick={() => navigate(`/run/${event._runId}`)}
                            >
                                <span className={`risk-badge risk-badge--${event.risk.level}`}>
                                    {event.risk.level}
                                </span>
                                <div className="global-event-body">
                                    <div className="global-event-desc">{event.description}</div>
                                    <div className="global-event-meta">
                                        {event._agentName} · {event.event_type} · {formatOffset(event.run_offset_ms)}
                                    </div>
                                </div>
                                <div className="global-event-score">
                                    {event.risk.score.toFixed(1)}
                                </div>
                                <ArrowRight size={14} className="global-event-arrow" />
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
