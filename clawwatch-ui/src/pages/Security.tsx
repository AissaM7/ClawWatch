// ── Security Dashboard ───────────────────────────────────────────
// Server-side security detection: scan, filter, acknowledge events.

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SecurityEvent, SecurityStats } from '../lib/types';
import {
    scanSecurity, fetchSecurityEvents, fetchSecurityStats,
    acknowledgeSecurityEvent, markSecurityEventSafe,
} from '../lib/api';
import {
    Shield, ShieldAlert, ShieldCheck,
    Scan, FileWarning, Globe, Terminal,
    ArrowRight, Check, Key, Eye, EyeOff,
    RefreshCw, AlertTriangle, Loader2,
    ChevronRight, ChevronDown
} from 'lucide-react';

type FilterTab = 'all' | 'critical' | 'high' | 'medium' | 'low' | 'unacknowledged';

const SEVERITY_COLORS: Record<string, string> = {
    critical: '#ef4444',
    high: '#f97316',
    medium: '#eab308',
    low: '#3b82f6',
    info: '#6b7280',
};

const SEVERITY_BG: Record<string, string> = {
    critical: 'rgba(239,68,68,0.12)',
    high: 'rgba(249,115,22,0.10)',
    medium: 'rgba(234,179,8,0.08)',
    low: 'rgba(59,130,246,0.08)',
    info: 'rgba(107,114,128,0.06)',
};

function getCategoryIcon(eventType: string) {
    if (eventType.includes('CREDENTIAL') || eventType.includes('REPEATED_CREDENTIAL'))
        return Key;
    if (eventType.includes('FILE') || eventType.includes('DESTRUCTIVE') || eventType.includes('MASS'))
        return FileWarning;
    if (eventType.includes('NETWORK') || eventType.includes('EXFIL') || eventType.includes('DOWNLOAD') || eventType.includes('PORT'))
        return Globe;
    if (eventType.includes('SHELL') || eventType.includes('PROCESS') || eventType.includes('DATABASE'))
        return Terminal;
    if (eventType.includes('CONFIG') || eventType.includes('HIDDEN') || eventType.includes('CROSS'))
        return AlertTriangle;
    return ShieldAlert;
}

function formatTime(ts: number | null): string {
    if (!ts) return '—';
    const d = new Date(ts * 1000);
    return d.toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

function SecurityEventCard({
    evt, handleAcknowledge, handleMarkSafe, navigate
}: {
    evt: SecurityEvent;
    handleAcknowledge: (id: string) => void;
    handleMarkSafe: (id: string) => void;
    navigate: (path: string) => void;
}) {
    const [isExpanded, setIsExpanded] = useState(false);
    const CatIcon = getCategoryIcon(evt.event_type);
    const isAcked = !!evt.acknowledged;

    return (
        <div
            className={`sec-event-card${isAcked ? ' sec-event-card--acked' : ''}`}
            style={{
                borderLeft: `3px solid ${SEVERITY_COLORS[evt.severity] || '#555'}`,
                background: SEVERITY_BG[evt.severity] || 'transparent',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px'
            }}
        >
            <div
                className="sec-event-head"
                onClick={() => setIsExpanded(!isExpanded)}
                style={{ cursor: 'pointer', userSelect: 'none' }}
                title="Click to expand/collapse details"
            >
                <CatIcon size={16} style={{ color: SEVERITY_COLORS[evt.severity], flexShrink: 0, marginTop: '2px' }} />
                <div className="sec-event-info" style={{ flex: 1, minWidth: 0 }}>
                    <div className="sec-event-label">{evt.label}</div>
                    {!isExpanded && (
                        <div className="sec-event-desc" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', opacity: 0.7 }}>
                            {evt.description}
                        </div>
                    )}
                </div>
                <div className="sec-event-actions" onClick={(e) => e.stopPropagation()}>
                    <span
                        className="sec-severity-pill"
                        style={{ background: SEVERITY_COLORS[evt.severity] }}
                    >
                        {evt.severity}
                    </span>
                    {!isAcked && (
                        <button
                            className="sec-ack-btn"
                            title="Acknowledge"
                            onClick={() => handleAcknowledge(evt.id)}
                        >
                            <Check size={14} />
                        </button>
                    )}
                    <button
                        title="Mark as Safe (Skip List)"
                        onClick={() => handleMarkSafe(evt.id)}
                        style={{
                            background: 'transparent',
                            border: '1px solid currentColor',
                            color: 'inherit',
                            opacity: 0.7,
                            display: 'flex', alignItems: 'center', gap: '4px',
                            padding: '2px 8px', borderRadius: '4px', fontSize: '11px',
                            cursor: 'pointer', marginLeft: isAcked ? 8 : 4
                        }}
                    >
                        <ShieldCheck size={12} /> Safe
                    </button>
                    {isAcked && (
                        <span className="sec-acked-badge">
                            <Eye size={12} /> Acked
                        </span>
                    )}
                    <button style={{ background: 'transparent', border: 'none', color: 'var(--text-tertiary)', padding: 4, cursor: 'pointer' }}>
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                </div>
            </div>

            {isExpanded && (
                <div className="sec-event-body" style={{
                    borderTop: '1px solid rgba(255,255,255,0.06)',
                    paddingTop: '12px',
                    display: 'flex', flexDirection: 'column', gap: '8px'
                }}>
                    <div className="sec-event-desc" style={{ opacity: 0.9 }}>
                        {evt.description}
                    </div>
                    {evt.raw_command && (
                        <code className="sec-event-cmd" style={{
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                            maxHeight: '400px',
                            overflowY: 'auto'
                        }}>
                            {evt.raw_command}
                        </code>
                    )}
                </div>
            )}

            <div className="sec-event-footer" style={{ marginTop: '0px' }}>
                <span className="sec-event-meta">
                    {evt.agent_id} · {formatTime(evt.run_timestamp || evt.detected_at)}
                </span>
                <button
                    className="sec-go-run-btn"
                    onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/run/${evt.run_id}`);
                    }}
                >
                    View Run <ArrowRight size={12} />
                </button>
            </div>
        </div>
    );
}

export default function Security() {
    const navigate = useNavigate();
    const [loading, setLoading] = useState(true);
    const [scanning, setScanning] = useState(false);
    const [events, setEvents] = useState<SecurityEvent[]>([]);
    const [stats, setStats] = useState<SecurityStats | null>(null);
    const [filter, setFilter] = useState<FilterTab>('all');
    const [scanToast, setScanToast] = useState<string | null>(null);

    const loadData = useCallback(async () => {
        try {
            const [evts, st] = await Promise.all([
                fetchSecurityEvents({ limit: 200 }),
                fetchSecurityStats(),
            ]);
            // Filter out SCAN_CLEAN sentinel entries
            setEvents(evts.filter(e => e.event_type !== 'SCAN_CLEAN'));
            setStats(st);
        } catch { /* skip */ }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { loadData(); }, [loadData]);

    // Auto-scan on mount if there are unscanned runs
    useEffect(() => {
        if (stats && stats.unscanned_runs_count > 0 && !scanning) {
            handleScan();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stats?.unscanned_runs_count]);

    const handleScan = async () => {
        setScanning(true);
        setScanToast(null);
        try {
            const result = await scanSecurity();
            setScanToast(
                `Scanned ${result.runs_scanned} runs — found ${result.events_found} security events`
            );
            await loadData();
        } catch {
            setScanToast('Scan failed — check backend connection');
        } finally {
            setScanning(false);
            setTimeout(() => setScanToast(null), 5000);
        }
    };

    const handleAcknowledge = async (eventId: string) => {
        try {
            await acknowledgeSecurityEvent(eventId);
            setEvents(prev =>
                prev.map(e => e.id === eventId ? { ...e, acknowledged: true } : e)
            );
        } catch { /* skip */ }
    };

    const handleMarkSafe = async (eventId: string) => {
        try {
            await markSecurityEventSafe(eventId);
            setEvents(prev => prev.filter(e => e.id !== eventId));
            setScanToast('Pattern added to local skip list. False positives hidden.');
            setTimeout(() => setScanToast(null), 5000);
        } catch { /* skip */ }
    };

    const filtered = useMemo(() => {
        const evts = events.filter(e => !e.is_false_positive);
        if (filter === 'all') return evts;
        if (filter === 'unacknowledged') return evts.filter(e => !e.acknowledged);
        return evts.filter(e => e.severity === filter);
    }, [events, filter]);

    if (loading) {
        return (
            <div className="waiting-state">
                <div className="waiting-icon" />
                <p>Loading security data…</p>
            </div>
        );
    }

    const s = stats || {
        total_events: 0, critical_count: 0, high_count: 0,
        medium_count: 0, low_count: 0,
        credential_access_count: 0, destructive_ops_count: 0,
        network_risk_count: 0, subprocess_count: 0,
        runs_affected: 0, last_scan_at: null, unscanned_runs_count: 0,
    };

    return (
        <div className="global-page">
            {/* Header */}
            <div className="global-page-header">
                <h1><Shield size={24} /> Security</h1>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <p>{filtered.length} events across {s.runs_affected} runs</p>
                    <button
                        className="sec-scan-btn"
                        onClick={handleScan}
                        disabled={scanning}
                    >
                        {scanning ? (
                            <><Loader2 size={14} className="sec-spin" /> Scanning…</>
                        ) : (
                            <><Scan size={14} /> Scan Now</>
                        )}
                    </button>
                </div>
            </div>

            {/* Toast */}
            {scanToast && (
                <div className="sec-toast">
                    <RefreshCw size={14} />
                    {scanToast}
                </div>
            )}

            {/* KPI Cards */}
            <div className="global-kpis">
                <div className="global-kpi global-kpi--red">
                    <div className="global-kpi-value">{s.critical_count}</div>
                    <div className="global-kpi-label">Critical</div>
                </div>
                <div className="global-kpi global-kpi--orange">
                    <div className="global-kpi-value">{s.high_count}</div>
                    <div className="global-kpi-label">High Risk</div>
                </div>
                <div className="global-kpi global-kpi--gold">
                    <div className="global-kpi-value">{s.medium_count + s.low_count}</div>
                    <div className="global-kpi-label">Warnings</div>
                </div>
                <div className="global-kpi" style={{ borderColor: 'var(--color-credential, #a78bfa)' }}>
                    <div className="global-kpi-value">{s.credential_access_count}</div>
                    <div className="global-kpi-label">Credential Access</div>
                </div>
                <div className="global-kpi" style={{ borderColor: 'var(--color-destructive, #fb923c)' }}>
                    <div className="global-kpi-value">{s.destructive_ops_count}</div>
                    <div className="global-kpi-label">Destructive Ops</div>
                </div>
                <div className="global-kpi global-kpi--blue">
                    <div className="global-kpi-value">{s.network_risk_count}</div>
                    <div className="global-kpi-label">Network Risk</div>
                </div>
            </div>

            {/* Filter Tabs */}
            <div className="sec-filter-tabs">
                {(['all', 'critical', 'high', 'medium', 'low', 'unacknowledged'] as FilterTab[]).map(tab => (
                    <button
                        key={tab}
                        className={`sec-filter-tab${filter === tab ? ' sec-filter-tab--active' : ''}`}
                        onClick={() => setFilter(tab)}
                        data-severity={tab}
                    >
                        {tab === 'unacknowledged' ? (
                            <><EyeOff size={12} /> Unreviewed</>
                        ) : (
                            tab.charAt(0).toUpperCase() + tab.slice(1)
                        )}
                        {tab !== 'all' && tab !== 'unacknowledged' && (
                            <span className="sec-filter-count" style={{ background: SEVERITY_COLORS[tab] }}>
                                {events.filter(e => e.severity === tab).length}
                            </span>
                        )}
                    </button>
                ))}
            </div>

            {/* Event Feed */}
            <div className="global-section">
                <div className="global-section-title">
                    Security Events
                    {s.unscanned_runs_count > 0 && (
                        <span className="sec-unscan-badge">
                            {s.unscanned_runs_count} unscanned
                        </span>
                    )}
                </div>

                {filtered.length === 0 ? (
                    <div className="global-empty">
                        <ShieldCheck size={20} />
                        <span>
                            {filter === 'all'
                                ? 'No security events detected. All clear.'
                                : `No ${filter} events found.`}
                        </span>
                    </div>
                ) : (
                    <div className="sec-events-feed">
                        {filtered.map(evt => (
                            <SecurityEventCard
                                key={evt.id}
                                evt={evt}
                                handleAcknowledge={handleAcknowledge}
                                handleMarkSafe={handleMarkSafe}
                                navigate={navigate}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
