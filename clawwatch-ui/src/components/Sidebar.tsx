// ── Sidebar Navigation ──────────────────────────────────────────
// Persistent left sidebar with primary nav, contextual run nav, and status footer.

import { NavLink, useMatch, useLocation } from 'react-router-dom';
import { useState, useEffect } from 'react';
import {
    Bot,
    List,
    Activity,
    ShieldAlert,
    DollarSign,
    PanelLeftClose,
    PanelLeft,
    Wifi,
    WifiOff,
} from 'lucide-react';
import { fetchHealth } from '../lib/api';
import '../sidebar.css';

const COLLAPSED_KEY = 'clawwatch_sidebar_collapsed';

export default function Sidebar() {
    const location = useLocation();
    const m1 = useMatch('/run/:runId');
    const m2 = useMatch('/run/:runId/review');
    const m3 = useMatch('/run/:runId/cost');
    const runMatch = m1 || m2 || m3;
    const runId = runMatch?.params?.runId;

    const [collapsed, setCollapsed] = useState(() => {
        try { return localStorage.getItem(COLLAPSED_KEY) === 'true'; }
        catch { return false; }
    });

    const [connected, setConnected] = useState(false);

    useEffect(() => {
        const check = async () => {
            const ok = await fetchHealth();
            setConnected(ok);
        };
        check();
        const interval = setInterval(check, 8000);
        return () => clearInterval(interval);
    }, []);

    const toggle = () => {
        const next = !collapsed;
        setCollapsed(next);
        try { localStorage.setItem(COLLAPSED_KEY, String(next)); }
        catch { /* ignore */ }
    };

    return (
        <aside className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''}`}>
            {/* ── Logo ── */}
            <div className="sidebar-logo">
                <NavLink to="/" style={{ textDecoration: 'none' }}>
                    {!collapsed && (
                        <span className="sidebar-logo-text">
                            Claw<span>Watch</span>
                        </span>
                    )}
                </NavLink>
            </div>

            {/* ── Primary Nav ── */}
            <nav className="sidebar-nav">
                <div className="sidebar-section">
                    {!collapsed && <div className="sidebar-section-label">Navigate</div>}

                    <NavLink
                        to="/"
                        className={({ isActive }) =>
                            `sidebar-item ${isActive && location.pathname === '/' ? 'sidebar-item--active' : ''}`
                        }
                        title="Agents"
                    >
                        <Bot size={18} className="sidebar-item-icon" />
                        {!collapsed && <span className="sidebar-item-text">Agents</span>}
                    </NavLink>

                    <NavLink
                        to="/runs"
                        className={({ isActive }) =>
                            `sidebar-item ${isActive ? 'sidebar-item--active' : ''}`
                        }
                        title="All Runs"
                    >
                        <List size={18} className="sidebar-item-icon" />
                        {!collapsed && <span className="sidebar-item-text">All Runs</span>}
                    </NavLink>
                </div>

                {/* ── Run Context (conditional) ── */}
                {runId && (
                    <div className="sidebar-section sidebar-section--run">
                        {!collapsed && (
                            <div className="sidebar-section-label sidebar-section-label--run">
                                <span className="sidebar-run-dot" />
                                Active Run
                            </div>
                        )}
                        {collapsed && <div className="sidebar-divider" />}

                        <NavLink
                            to={`/run/${runId}`}
                            end
                            className={({ isActive }) =>
                                `sidebar-item ${isActive ? 'sidebar-item--active' : ''}`
                            }
                            title="Timeline"
                        >
                            <Activity size={18} className="sidebar-item-icon" />
                            {!collapsed && <span className="sidebar-item-text">Timeline</span>}
                        </NavLink>

                        <NavLink
                            to={`/run/${runId}/review`}
                            className={({ isActive }) =>
                                `sidebar-item ${isActive ? 'sidebar-item--active' : ''}`
                            }
                            title="Risk Review"
                        >
                            <ShieldAlert size={18} className="sidebar-item-icon" />
                            {!collapsed && <span className="sidebar-item-text">Risk Review</span>}
                        </NavLink>

                        <NavLink
                            to={`/run/${runId}/cost`}
                            className={({ isActive }) =>
                                `sidebar-item ${isActive ? 'sidebar-item--active' : ''}`
                            }
                            title="Cost"
                        >
                            <DollarSign size={18} className="sidebar-item-icon" />
                            {!collapsed && <span className="sidebar-item-text">Cost</span>}
                        </NavLink>
                    </div>
                )}
            </nav>

            {/* ── Footer ── */}
            <div className="sidebar-footer">
                <div className="sidebar-status" title={connected ? 'Connected to backend' : 'Backend offline'}>
                    {connected
                        ? <Wifi size={14} className="sidebar-status-icon sidebar-status-icon--online" />
                        : <WifiOff size={14} className="sidebar-status-icon sidebar-status-icon--offline" />
                    }
                    {!collapsed && (
                        <span className={`sidebar-status-text ${connected ? 'sidebar-status-text--online' : ''}`}>
                            {connected ? 'Connected' : 'Offline'}
                        </span>
                    )}
                </div>
                <button
                    className="sidebar-collapse-btn"
                    onClick={toggle}
                    title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                >
                    {collapsed
                        ? <PanelLeft size={16} />
                        : <PanelLeftClose size={16} />
                    }
                </button>
            </div>
        </aside>
    );
}
