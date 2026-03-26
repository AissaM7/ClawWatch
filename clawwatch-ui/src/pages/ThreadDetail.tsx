import { useState, useEffect } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import type { Task } from '../lib/types';
import { fetchThreadTasks } from '../lib/api';

function formatDuration(ms: number | null): string {
    if (!ms) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function formatTime(ts: number): string {
    if (!ts) return '';
    return new Date(ts * 1000).toLocaleString([], {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

function statusDotClass(status: string): string {
    switch (status) {
        case 'active': return 'running';
        case 'completed': return 'completed';
        case 'error': return 'error';
        case 'abandoned': return 'abandoned';
        default: return 'completed';
    }
}

export default function ThreadDetail() {
    const { threadId } = useParams<{ threadId: string }>();
    const [tasks, setTasks] = useState<Task[]>([]);
    const [loading, setLoading] = useState(true);
    const navigate = useNavigate();

    useEffect(() => {
        const load = async () => {
            if (!threadId) return;
            try {
                const data = await fetchThreadTasks(threadId);
                setTasks(data);
            } catch {
                // API not ready
            } finally {
                setLoading(false);
            }
        };
        load();
    }, [threadId]);

    if (loading) {
        return (
            <div className="waiting-state">
                <div className="waiting-icon" />
                <p>Loading tasks...</p>
            </div>
        );
    }

    return (
        <div>
            <div className="page-header">
                <div className="breadcrumb">
                    <Link to="/">Agents</Link>
                    <span className="breadcrumb-sep">›</span>
                    <Link to="#" onClick={(e) => { e.preventDefault(); navigate(-1); }}>Threads</Link>
                    <span className="breadcrumb-sep">›</span>
                    <span>Thread Detail</span>
                </div>
                <h1>Thread Tasks</h1>
                <p>{tasks.length} task{tasks.length !== 1 ? 's' : ''}</p>
            </div>

            {tasks.length === 0 ? (
                <div className="empty-state">
                    <h2>No tasks yet</h2>
                    <p>Tasks will appear here when messages are exchanged.</p>
                </div>
            ) : (
                <div className="task-list">
                    {tasks.map((task, idx) => (
                        <div key={task.task_id}>
                            {idx > 0 && (
                                <div className="task-divider">
                                    <span className="task-divider-line" />
                                    <span className="task-divider-label">
                                        NEW TASK · {formatTimeBetween(tasks[idx - 1].opened_at, task.opened_at)}
                                    </span>
                                    <span className="task-divider-line" />
                                </div>
                            )}
                            <div
                                className={`task-card task-status-${task.status}`}
                                onClick={() => navigate(`/run/${task.run_id}`)}
                            >
                                <div className="task-card-header">
                                    <span className={`status-dot ${statusDotClass(task.status)}`} />
                                    <span className="task-index">Task {tasks.length - idx}</span>
                                    <span className="task-status-badge">{task.status}</span>
                                </div>
                                <div className="task-card-prompt">
                                    {task.opening_prompt || 'No prompt recorded'}
                                </div>
                                <div className="task-card-metrics">
                                    <span>{task.exchange_count} exchange{task.exchange_count !== 1 ? 's' : ''}</span>
                                    <span>{task.llm_call_count} LLM call{task.llm_call_count !== 1 ? 's' : ''}</span>
                                    <span>{task.tool_call_count} tool call{task.tool_call_count !== 1 ? 's' : ''}</span>
                                    {task.error_count > 0 && (
                                        <span className="task-error-count">{task.error_count} error{task.error_count !== 1 ? 's' : ''}</span>
                                    )}
                                    <span>{formatDuration(task.duration_ms)}</span>
                                    <span>{formatTime(task.opened_at)}</span>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function formatTimeBetween(ts1: number, ts2: number): string {
    const diffS = Math.abs(ts2 - ts1);
    if (diffS < 60) return `${Math.floor(diffS)}S LATER`;
    if (diffS < 3600) return `${Math.floor(diffS / 60)}M LATER`;
    if (diffS < 86400) return `${Math.floor(diffS / 3600)}H LATER`;
    return `${Math.floor(diffS / 86400)}D LATER`;
}
