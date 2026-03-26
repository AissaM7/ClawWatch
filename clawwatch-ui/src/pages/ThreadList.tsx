import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import type { Thread } from '../lib/types';
import { fetchThreads, renameThread } from '../lib/api';
import {
    MessageSquare, Send, Terminal, Globe, Hash, Pencil, Check, X
} from 'lucide-react';

// ── Helpers ──────────────────────────────────────────────────────

function formatTime(ts: number): string {
    if (!ts) return '';
    return new Date(ts * 1000).toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit',
    });
}

function formatAge(ts: number): string {
    if (!ts) return '';
    const diffMs = Date.now() - ts * 1000;
    const diffH = Math.floor(diffMs / 3600000);
    if (diffH < 1) return 'less than 1h';
    if (diffH < 24) return `${diffH}h`;
    const diffD = Math.floor(diffH / 24);
    return `${diffD}d`;
}

/** Returns a lucide icon component for the channel type */
function ChannelIcon({ channel }: { channel: string }) {
    const ch = channel.toLowerCase();
    switch (ch) {
        case 'telegram': return <Send size={14} className="thread-channel-lucide" />;
        case 'discord': return <Hash size={14} className="thread-channel-lucide" />;
        case 'terminal': return <Terminal size={14} className="thread-channel-lucide" />;
        case 'webhook': return <Globe size={14} className="thread-channel-lucide" />;
        default: return <MessageSquare size={14} className="thread-channel-lucide" />;
    }
}

/** Returns a human-friendly default name for a channel */
function channelDefaultName(channel: string): string {
    switch (channel.toLowerCase()) {
        case 'telegram': return 'Telegram';
        case 'discord': return 'Discord';
        case 'terminal': return 'Terminal';
        case 'webhook': return 'Webhook';
        case 'direct': return 'Direct';
        default: return 'Channel';
    }
}

// ── Inline Editable Name ─────────────────────────────────────────

interface EditableNameProps {
    thread: Thread;
    onRename: (threadId: string, newName: string) => void;
}

function EditableName({ thread, onRename }: EditableNameProps) {
    const displayName = thread.display_name || channelDefaultName(thread.channel);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(displayName);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (editing && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [editing]);

    const startEditing = useCallback((e: React.MouseEvent) => {
        e.stopPropagation(); // Don't navigate when starting edit
        setDraft(displayName);
        setEditing(true);
    }, [displayName]);

    const commit = useCallback(() => {
        const trimmed = draft.trim();
        if (trimmed && trimmed !== displayName) {
            onRename(thread.thread_id, trimmed);
        }
        setEditing(false);
    }, [draft, displayName, thread.thread_id, onRename]);

    const cancel = useCallback(() => {
        setDraft(displayName);
        setEditing(false);
    }, [displayName]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') cancel();
    }, [commit, cancel]);

    if (editing) {
        return (
            <div className="thread-name-edit" onClick={e => e.stopPropagation()}>
                <input
                    ref={inputRef}
                    className="thread-name-input"
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onBlur={commit}
                    maxLength={64}
                />
                <button className="thread-name-btn thread-name-btn--confirm" onClick={commit} title="Save">
                    <Check size={13} />
                </button>
                <button className="thread-name-btn thread-name-btn--cancel" onClick={cancel} title="Cancel">
                    <X size={13} />
                </button>
            </div>
        );
    }

    return (
        <span className="thread-name-display" title="Click pencil to rename">
            <span className="thread-user">{displayName}</span>
            <button className="thread-edit-btn" onClick={startEditing} title="Rename thread">
                <Pencil size={11} />
            </button>
        </span>
    );
}

// ── localStorage helpers for display name persistence ────────────

const STORAGE_KEY = 'clawwatch_thread_names';

function loadSavedNames(): Record<string, string> {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch {
        return {};
    }
}

function saveName(threadId: string, name: string) {
    const names = loadSavedNames();
    names[threadId] = name;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
}

/** Merge saved display names into threads fetched from API */
function applyStoredNames(threads: Thread[]): Thread[] {
    const saved = loadSavedNames();
    return threads.map(t => {
        const storedName = saved[t.thread_id];
        if (storedName) {
            return { ...t, display_name: storedName };
        }
        return t;
    });
}

// ── Main Component ───────────────────────────────────────────────

export default function ThreadList() {
    const { agentId } = useParams<{ agentId: string }>();
    const [threads, setThreads] = useState<Thread[]>([]);
    const [loading, setLoading] = useState(true);
    const navigate = useNavigate();

    useEffect(() => {
        const load = async () => {
            try {
                const data = await fetchThreads(agentId);
                // Merge in any locally-saved display names
                setThreads(applyStoredNames(data));
            } catch {
                // API not ready 
            } finally {
                setLoading(false);
            }
        };
        load();
    }, [agentId]);

    const handleRename = useCallback(async (threadId: string, newName: string) => {
        // 1. Save to localStorage immediately (guaranteed persistence)
        saveName(threadId, newName);

        // 2. Update React state
        setThreads(prev => prev.map(t =>
            t.thread_id === threadId ? { ...t, display_name: newName } : t
        ));

        // 3. Best-effort backend save (may fail for synthetic threads)
        try {
            await renameThread(threadId, newName);
        } catch {
            // localStorage already has the name, so no rollback needed
        }
    }, []);

    if (loading) {
        return (
            <div className="waiting-state">
                <div className="waiting-icon" />
                <p>Loading threads...</p>
            </div>
        );
    }

    return (
        <div>
            <div className="page-header">
                <div className="breadcrumb">
                    <Link to="/">Agents</Link>
                    <span className="breadcrumb-sep">›</span>
                    <span>{agentId}</span>
                </div>
                <h1>{agentId} — Threads</h1>
                <p>{threads.length} thread{threads.length !== 1 ? 's' : ''}</p>
            </div>

            {threads.length === 0 ? (
                <div className="empty-state">
                    <h2>No threads yet</h2>
                    <p>Send a message to this agent to create a thread.</p>
                </div>
            ) : (
                <div className="thread-list">
                    {threads.map(thread => (
                        <div
                            key={thread.thread_id}
                            className="thread-card"
                            onClick={() => navigate(`/thread/${thread.thread_id}`)}
                        >
                            <div className="thread-card-header">
                                <ChannelIcon channel={thread.channel} />
                                <EditableName thread={thread} onRename={handleRename} />
                                <span className="thread-channel-badge">{thread.channel}</span>
                            </div>
                            <div className="thread-card-stats">
                                <span>{thread.task_count} task{thread.task_count !== 1 ? 's' : ''}</span>
                                <span>Thread age: {formatAge(thread.created_at)}</span>
                                <span>Last active: {formatTime(thread.last_active_at)}</span>
                                {thread.total_cost_usd > 0 && (
                                    <span>${thread.total_cost_usd.toFixed(3)}</span>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
