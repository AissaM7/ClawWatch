import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Run } from '../lib/types';
import type { ClawEvent } from '../lib/types';
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

  // Check server health
  useEffect(() => {
    const check = async () => {
      const ok = await fetchHealth();
      setConnected(ok);
    };
    check();
    const interval = setInterval(check, 5000);
    return () => clearInterval(interval);
  }, []);

  // Load runs from REST API (persisted data)
  useEffect(() => {
    const load = async () => {
      try {
        const data = await fetchRuns();
        setRuns(data);
      } catch {
        // Server may not be ready yet
      } finally {
        setLoading(false);
      }
    };
    load();
    // Poll every 10s to pick up new runs
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

  // SSE for live updates (merges into runs state)
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
            agent_name: event.agent_name,
            goal: event.goal,
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

  // Show loading only briefly — never block showing persisted runs
  if (loading) {
    return (
      <div className="waiting-state">
        <div className="waiting-icon" />
        <p>Loading runs...</p>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="empty-state">
        <h2>No runs yet</h2>
        <p>
          {connected
            ? 'Run an OpenClaw agent with ClawWatch installed to see it here.'
            : 'Start the ClawWatch plugin server to begin observing agent runs.'
          }
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>Agent Runs</h1>
        <p>
          {connected && <span className="status-dot running" style={{ marginRight: 6 }} />}
          {connected ? 'Connected to agent' : 'Offline — viewing historical runs'}
          {' · '}{runs.length} run{runs.length !== 1 ? 's' : ''}
        </p>
      </div>

      <div className="run-list">
        {runs.map(run => (
          <div
            key={run.run_id}
            className="run-card"
            onClick={() => navigate(`/run/${run.run_id}`)}
          >
            <div className="run-card-header">
              <span className={`status-dot ${run.status === 'running' ? 'running' : run.status === 'error' ? 'error' : 'completed'}`} />
              <span className="agent-name">{run.agent_name}</span>
            </div>
            <div className="run-card-goal">{run.goal || 'Awaiting prompt...'}</div>
            <div className="run-card-stats">
              <span>{run.event_count || 0} events</span>
              <span>{formatDuration(run.started_at, run.ended_at)}</span>
              <span>{formatTime(run.started_at)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
