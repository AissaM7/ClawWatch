import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Run, ClawEvent } from '../lib/types';
import { fetchRuns, fetchHealth, createSSEConnection } from '../lib/api';

function formatDuration(startTs: number, endTs: number | null): string {
  const end = endTs || Date.now() / 1000;
  const seconds = Math.floor(end - startTs);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit',
  });
}

export default function RunList() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  // Health check
  useEffect(() => {
    const check = async () => setConnected(await fetchHealth());
    check();
    const interval = setInterval(check, 5000);
    return () => clearInterval(interval);
  }, []);

  // Initial Load
  useEffect(() => {
    const load = async () => {
      try {
        const data = await fetchRuns();
        setRuns(data);
      } catch {
        // error handled silently
      } finally {
        setLoading(false);
      }
    };
    load();
    const interval = setInterval(async () => {
      try { const data = await fetchRuns(); setRuns(data); } catch { }
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  // SSE for live updates
  useEffect(() => {
    const cleanup = createSSEConnection((event: ClawEvent) => {
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
    });
    return cleanup;
  }, []);

  if (loading) {
    return (
      <div className="waiting-state">
        <div className="waiting-icon" />
        <p>Initializing...</p>
      </div>
    );
  }

  // KPI Calculations
  const totalRuns = runs.length;
  const activeNow = runs.filter(r => r.status === 'running').length;
  const errorCount = runs.filter(r => r.status === 'error').length;
  const completedCount = runs.filter(r => r.status === 'completed').length;
  const successRate = (completedCount + errorCount) > 0
    ? Math.round((completedCount / (completedCount + errorCount)) * 100)
    : 0;
  const uniqueAgentsCount = new Set(runs.map(r => r.agent_name)).size;

  return (
    <div style={{ padding: '0 20px 40px 20px', maxWidth: 1200, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* Dynamic Style Injection for KPI pills */}
      <style>{`
        .rl-kpis { display: flex; gap: 16px; margin-top: 8px; flex-wrap: wrap; margin-bottom: 8px; }
        .rl-kpi { display: flex; align-items: baseline; gap: 10px; background: rgba(14,14,18,0.4); border: 1px solid rgba(255,255,255,0.08); padding: 12px 20px; border-radius: 12px; flex: 1; min-width: 140px; }
        .rl-kpi-value { font-size: 24px; font-weight: 700; font-family: 'Outfit', sans-serif; color: rgba(255,255,255,0.95); line-height: 1; }
        .rl-kpi-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: rgba(255,255,255,0.4); font-weight: 600; }
        .rl-kpi--live { border-color: rgba(0,212,255,0.3); background: rgba(0,212,255,0.05); }
        .rl-kpi--error { border-color: rgba(255,45,85,0.3); background: rgba(255,45,85,0.05); }
        .rl-kpi-dot { width: 8px; height: 8px; border-radius: 50%; background: #00D4FF; display: inline-block; animation: live-pulse 1.4s infinite; margin-right: -4px; }
        .rl-run-row { display: flex; align-items: center; padding: 12px 16px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04); border-radius: 8px; cursor: pointer; transition: background 0.2s; }
        .rl-run-row:hover { background: rgba(255,255,255,0.04); }
      `}</style>

      {/* Header */}
      <div>
        <h1 style={{ fontSize: '24px', fontWeight: 600, fontFamily: 'Outfit', color: '#fff', margin: '0 0 6px 0' }}>Runs</h1>
        <p style={{ margin: 0, fontSize: '13px', color: 'rgba(255,255,255,0.5)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          {connected ? (
            <><span className="status-dot running" /> Connected</>
          ) : (
            <><span className="status-dot error" /> Offline</>
          )}
          <span style={{ opacity: 0.5 }}>·</span> {uniqueAgentsCount} agent{uniqueAgentsCount !== 1 ? 's' : ''}
          <span style={{ opacity: 0.5 }}>·</span> {runs.length} run{runs.length !== 1 ? 's' : ''}
        </p>
      </div>

      {/* KPI Cards */}
      <div className="rl-kpis">
        <div className="rl-kpi">
          <span className="rl-kpi-value">{totalRuns}</span>
          <span className="rl-kpi-label">Total Runs</span>
        </div>
        <div className={`rl-kpi ${activeNow > 0 ? 'rl-kpi--live' : ''}`}>
          {activeNow > 0 && <span className="rl-kpi-dot" />}
          <span className="rl-kpi-value">{activeNow}</span>
          <span className="rl-kpi-label">Active Now</span>
        </div>
        <div className="rl-kpi">
          <span className="rl-kpi-value">{successRate}%</span>
          <span className="rl-kpi-label">Success Rate</span>
        </div>
        <div className={`rl-kpi ${errorCount > 0 ? 'rl-kpi--error' : ''}`}>
          <span className="rl-kpi-value">{errorCount}</span>
          <span className="rl-kpi-label">Errors</span>
        </div>
      </div>

      {/* Run List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {runs.map(run => (
          <div key={run.run_id} className="rl-run-row" onClick={() => navigate(`/run/${run.run_id}`)}>
            <span className={`status-dot ${run.status === 'running' ? 'running' : run.status === 'error' ? 'error' : 'completed'}`} style={{ marginRight: '12px' }} />
            <span style={{ width: '120px', fontSize: '12px', opacity: 0.6 }}>{run.agent_name}</span>
            <span style={{ flex: 1, fontFamily: 'Outfit', fontSize: '13px', opacity: 0.8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: '20px' }}>
              {run.goal || 'Awaiting prompt...'}
            </span>
            <span style={{ width: '80px', textAlign: 'right', fontSize: '12px', opacity: 0.6 }}>
              <b style={{ color: '#fff', fontWeight: 500, paddingRight: 4 }}>{run.event_count || 0}</b>events
            </span>
            <span style={{ width: '80px', textAlign: 'right', fontSize: '12px', opacity: 0.6 }}>
              <b style={{ color: '#fff', fontWeight: 500 }}>{formatDuration(run.started_at, run.ended_at)}</b>
            </span>
            <span style={{ width: '80px', textAlign: 'right', fontSize: '12px', opacity: 0.6 }}>
              {formatTime(run.started_at)}
            </span>
            <span style={{ opacity: 0.3, paddingLeft: '16px' }}>→</span>
          </div>
        ))}
      </div>
    </div>
  );
}
