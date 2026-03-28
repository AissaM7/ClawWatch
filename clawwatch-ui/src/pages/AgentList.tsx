import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Agent } from '../lib/types';
import { fetchAgents, fetchHealth } from '../lib/api';

function formatTime(ts: number): string {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffH = Math.floor(diffMs / 3600000);
    if (diffH < 1) return 'just now';
    if (diffH < 24) return `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    return `${diffD}d ago`;
}

export default function AgentList() {
    const [agents, setAgents] = useState<Agent[]>([]);
    const [connected, setConnected] = useState(false);
    const [loading, setLoading] = useState(true);
    const navigate = useNavigate();

    useEffect(() => {
        const check = async () => {
            const ok = await fetchHealth();
            setConnected(ok);
        };
        check();
        const interval = setInterval(check, 5000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        const load = async () => {
            try {
                const data = await fetchAgents();
                setAgents(data);
            } catch {
                // Server may not be ready
            } finally {
                setLoading(false);
            }
        };
        load();
        const interval = setInterval(load, 10000);
        return () => clearInterval(interval);
    }, []);

    if (loading) {
        return (
            <div className="waiting-state">
                <div className="waiting-icon" />
                <p>Loading agents...</p>
            </div>
        );
    }

    if (agents.length === 0) {
        return (
            <div className="empty-state">
                <h2>No agents registered</h2>
                <p>
                    {connected
                        ? 'Run an OpenClaw agent with ClawWatch installed to see it here.'
                        : 'Start the ClawWatch plugin server to begin observing agent runs.'}
                </p>
            </div>
        );
    }

    return (
        <div>
            <div className="page-header">
                <h1>Agents</h1>
                <p>
                    {connected && <span className="status-dot running" style={{ marginRight: 6 }} />}
                    {connected ? 'Connected' : 'Offline'}{' · '}
                    {agents.length} agent{agents.length !== 1 ? 's' : ''}
                </p>
            </div>

            <div className="agent-list">
                {agents.map(agent => (
                    <div
                        key={agent.agent_id}
                        className="agent-card"
                        onClick={() => navigate(`/agent/${encodeURIComponent(agent.agent_id)}`)}
                    >
                        <div className="agent-card-header">
                            <span className="status-dot running" />
                            <span className="agent-name">{agent.agent_id}</span>
                        </div>
                        <div className="agent-card-goal" style={{ opacity: 0.7 }}>
                            {agent.thread_count} thread{agent.thread_count !== 1 ? 's' : ''}{' · '}
                            {agent.total_tasks} task{agent.total_tasks !== 1 ? 's' : ''}
                        </div>
                        <div className="agent-card-stats">
                            <span>Last active {formatTime(agent.last_active_at)}</span>
                            {agent.total_cost_usd > 0 && (
                                <span>${agent.total_cost_usd.toFixed(3)}</span>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
