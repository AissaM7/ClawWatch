// ── System Topology: Geometric Architecture + Subtle CSS Strobes ──

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import type { ClawEvent } from '../../lib/types';
import './SystemTopology.css';

// ── Color palette ───────────────────────────────────────────────
const COLORS = {
    brain: '#fd6567',
    brainCore: '#bc2c2c',
    brainSoft: '#f3d5de',
    brainDark: '#241117',
    llm: '#8B5CF6',     // Violet
    tool: '#F59E0B',    // Amber
    user: '#06b6d4',    // Cyan/Teal (instead of gray)
    output: '#10b981',  // Emerald Green (instead of gray)
    error: '#FF2D55',
};

const COL_USER = 80;
const COL_BRAIN = 260;
const COL_LLM = 500;
const COL_TOOL = 720;
const COL_RESP = 940;

// ── Types ───────────────────────────────────────────────────────
interface TopoNode {
    id: string;
    label: string;
    type: 'brain' | 'llm' | 'tool' | 'user' | 'output';
    x: number;
    y: number;
    width: number;
    height: number;
    metrics: {
        calls: number;
        errors: number;
        avgLatencyMs: number;
        lastActiveTs: number;
    };
}

interface TopoEdge {
    from: string;
    to: string;
    count: number;
}

const SYSTEM_TOOLS = new Set([
    'preprocess', 'bootstrap', 'env', 'config', 'model_resolve',
    'session_start', 'session_end', 'tool_result_persist',
]);

// ── SVG Icon Components ─────────────────────────────────────────

const BrainIcon = ({ x, y }: { x: number, y: number }) => (
    <g transform={`translate(${x}, ${y})`}>
        <g filter="url(#st-brain-glow)">
            <circle cx="0" cy="0" r="36" fill="none" stroke={COLORS.brainSoft} strokeWidth="0.8" strokeOpacity="0.25" strokeDasharray="6 4" />
            <circle cx="0" cy="0" r="28" fill="none" stroke={COLORS.brain} strokeWidth="1.5" strokeOpacity="0.5" />
            <circle cx="0" cy="0" r="22" fill={COLORS.brainDark} stroke={COLORS.brain} strokeWidth="1" strokeOpacity="0.6" />
            <circle className="brain-core" cx="0" cy="0" r="12" fill={COLORS.brainCore} />
            <circle className="brain-core" cx="0" cy="0" r="6" fill={COLORS.brain} fillOpacity="0.9" />
        </g>
    </g>
);

const LlmIcon = ({ x, y, color }: { x: number, y: number, color: string }) => (
    <g transform={`translate(${x}, ${y})`}>
        <g filter="url(#st-glow)">
            <polygon points="0,-24 21,-12 21,12 0,24 -21,12 -21,-12"
                fill={color} fillOpacity="0.06" stroke={color} strokeWidth="1.5" strokeOpacity="0.55" />
            <line x1="-11" y1="-7" x2="11" y2="7" stroke={color} strokeWidth="0.8" strokeOpacity="0.3" />
            <line x1="-11" y1="7" x2="11" y2="-7" stroke={color} strokeWidth="0.8" strokeOpacity="0.3" />
            <line x1="0" y1="-14" x2="0" y2="14" stroke={color} strokeWidth="0.8" strokeOpacity="0.3" />
            <circle cx="0" cy="0" r="4" fill={color} fillOpacity="0.7" />
            <circle cx="-11" cy="-7" r="2" fill={color} fillOpacity="0.5" />
            <circle cx="11" cy="7" r="2" fill={color} fillOpacity="0.5" />
            <circle cx="-11" cy="7" r="2" fill={color} fillOpacity="0.5" />
            <circle cx="11" cy="-7" r="2" fill={color} fillOpacity="0.5" />
        </g>
    </g>
);

const ToolIcon = ({ x, y, color }: { x: number, y: number, color: string }) => (
    <g transform={`translate(${x}, ${y})`}>
        <g filter="url(#st-glow)">
            <rect x="-20" y="-20" width="40" height="40" rx="5" fill={color} fillOpacity="0.04" stroke={color} strokeWidth="1" strokeOpacity="0.35" />
            <rect x="-13" y="-13" width="11" height="11" rx="2" fill={color} fillOpacity="0.55" />
            <rect x="2" y="-13" width="11" height="11" rx="2" fill={color} fillOpacity="0.2" />
            <rect x="-13" y="2" width="11" height="11" rx="2" fill={color} fillOpacity="0.2" />
            <rect x="2" y="2" width="11" height="11" rx="2" fill={color} fillOpacity="0.4" />
        </g>
    </g>
);

const IoIcon = ({ x, y, color }: { x: number, y: number, color: string }) => (
    <g transform={`translate(${x}, ${y})`}>
        <circle cx="0" cy="0" r="18" fill="none" stroke={color} strokeWidth="1.5" strokeOpacity="0.4" filter="url(#st-glow)" />
        <circle cx="0" cy="0" r="13" fill={color} fillOpacity="0.08" />
        <circle cx="0" cy="0" r="5" fill={color} fillOpacity="0.35" />
    </g>
);

// ── Derive topology ─────────────────────────────────────────────
function deriveTopology(events: ClawEvent[], svgH: number): {
    nodes: TopoNode[];
    edges: TopoEdge[];
} {
    const toolStats = new Map<string, { calls: number; errors: number; latencySum: number; latencyCount: number; lastTs: number }>();
    const llmStats = new Map<string, { calls: number; errors: number; latencySum: number; latencyCount: number; lastTs: number }>();
    let userPrompts = 0, responses = 0, userLastTs = 0, respLastTs = 0;

    for (const ev of events) {
        switch (ev.event_type) {
            case 'user_prompt': userPrompts++; userLastTs = Math.max(userLastTs, ev.wall_ts); break;
            case 'llm_call_start': {
                const m = (ev.model || 'unknown').split('/').pop() || 'unknown';
                const s = llmStats.get(m) || { calls: 0, errors: 0, latencySum: 0, latencyCount: 0, lastTs: 0 };
                s.calls++; s.lastTs = Math.max(s.lastTs, ev.wall_ts); llmStats.set(m, s); break;
            }
            case 'llm_call_end': {
                const m = (ev.model || 'unknown').split('/').pop() || 'unknown';
                const s = llmStats.get(m);
                if (s && ev.duration_ms) { s.latencySum += ev.duration_ms; s.latencyCount++; } break;
            }
            case 'llm_error': {
                const m = (ev.model || 'unknown').split('/').pop() || 'unknown';
                const s = llmStats.get(m); if (s) s.errors++; break;
            }
            case 'tool_call_start': {
                const n = ev.tool_name;
                if (!n || SYSTEM_TOOLS.has(n)) break;
                const s = toolStats.get(n) || { calls: 0, errors: 0, latencySum: 0, latencyCount: 0, lastTs: 0 };
                s.calls++; s.lastTs = Math.max(s.lastTs, ev.wall_ts); toolStats.set(n, s); break;
            }
            case 'tool_call_end': {
                const n = ev.tool_name;
                if (!n || SYSTEM_TOOLS.has(n)) break;
                const s = toolStats.get(n);
                if (s && ev.duration_ms) { s.latencySum += ev.duration_ms; s.latencyCount++; } break;
            }
            case 'tool_error': {
                const n = ev.tool_name;
                if (!n || SYSTEM_TOOLS.has(n)) break;
                const s = toolStats.get(n); if (s) s.errors++; break;
            }
            case 'agent_response': responses++; respLastTs = Math.max(respLastTs, ev.wall_ts); break;
        }
    }

    const nodes: TopoNode[] = [];
    const edges: TopoEdge[] = [];
    const cy = svgH / 2 + 10;

    nodes.push({
        id: 'user', label: 'User', type: 'user', x: COL_USER, y: cy, width: 36, height: 36,
        metrics: { calls: userPrompts, errors: 0, avgLatencyMs: 0, lastActiveTs: userLastTs }
    });
    nodes.push({
        id: 'brain', label: 'Open CLAW', type: 'brain', x: COL_BRAIN, y: cy, width: 72, height: 72,
        metrics: { calls: events.length, errors: 0, avgLatencyMs: 0, lastActiveTs: 0 }
    });
    edges.push({ from: 'user', to: 'brain', count: userPrompts });

    const llms = Array.from(llmStats.entries());
    const llmSpacing = 90;
    const llmStartY = cy - ((llms.length - 1) * llmSpacing) / 2;
    llms.forEach(([model, st], i) => {
        nodes.push({
            id: `llm:${model}`, label: model, type: 'llm', x: COL_LLM, y: llmStartY + i * llmSpacing, width: 42, height: 48,
            metrics: { calls: st.calls, errors: st.errors, avgLatencyMs: st.latencyCount > 0 ? st.latencySum / st.latencyCount : 0, lastActiveTs: st.lastTs }
        });
        edges.push({ from: 'brain', to: `llm:${model}`, count: st.calls });
    });

    const tools = Array.from(toolStats.entries()).sort((a, b) => b[1].calls - a[1].calls);
    const toolSpacing = 82;
    const toolStartY = cy - ((tools.length - 1) * toolSpacing) / 2;
    tools.forEach(([name, st], i) => {
        nodes.push({
            id: `tool:${name}`, label: name, type: 'tool', x: COL_TOOL, y: toolStartY + i * toolSpacing, width: 40, height: 40,
            metrics: { calls: st.calls, errors: st.errors, avgLatencyMs: st.latencyCount > 0 ? st.latencySum / st.latencyCount : 0, lastActiveTs: st.lastTs }
        });
        edges.push({ from: 'brain', to: `tool:${name}`, count: st.calls });
    });

    nodes.push({
        id: 'output', label: 'Response', type: 'output', x: COL_RESP, y: cy, width: 36, height: 36,
        metrics: { calls: responses, errors: 0, avgLatencyMs: 0, lastActiveTs: respLastTs }
    });
    edges.push({ from: 'brain', to: 'output', count: responses });

    return { nodes, edges };
}

// ── Map event → edge keys for activation ────────────────────────
function eventToEdgeKeys(ev: ClawEvent): string[] {
    switch (ev.event_type) {
        case 'user_prompt': return ['user->brain'];
        case 'llm_call_start':
        case 'llm_call_end': {
            const m = (ev.model || 'unknown').split('/').pop() || 'unknown';
            return [`brain->llm:${m}`];
        }
        case 'tool_call_start':
        case 'tool_call_end': {
            const n = ev.tool_name;
            if (!n || SYSTEM_TOOLS.has(n)) return [];
            return [`brain->tool:${n}`];
        }
        case 'agent_response': return ['brain->output'];
        default: return [];
    }
}

// ── Props ───────────────────────────────────────────────────────
interface SystemTopologyProps {
    events: ClawEvent[];
    liveEvents: ClawEvent[];
    isLive: boolean;
    connected?: boolean;
}

// ── Component ───────────────────────────────────────────────────
export default function SystemTopology({ events, liveEvents, isLive, connected = true }: SystemTopologyProps) {
    const allEvents = useMemo(() => [...events, ...liveEvents], [events, liveEvents]);

    const svgW = 1020;
    const svgH = 460;

    const { nodes, edges } = useMemo(
        () => deriveTopology(allEvents, svgH),
        [allEvents, svgH]
    );

    // ── Active edges: simple Set<edgeKey> + setTimeout for cleanup ─
    // No rAF, no per-frame state. CSS handles the smooth transitions.
    const [activeEdges, setActiveEdges] = useState<Set<string>>(new Set());
    const [activeNodes, setActiveNodes] = useState<Set<string>>(new Set());
    const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    const prevLiveCountRef = useRef(liveEvents.length);

    const FADE_DURATION = 3500; // total visible time before CSS fades it out

    useEffect(() => {
        const prevCount = prevLiveCountRef.current;
        const newEvents = liveEvents.slice(prevCount);
        prevLiveCountRef.current = liveEvents.length;

        if (newEvents.length === 0) return;

        const edgesToActivate = new Set<string>();
        const nodesToActivate = new Set<string>();

        for (const ev of newEvents) {
            const keys = eventToEdgeKeys(ev);
            for (const k of keys) {
                edgesToActivate.add(k);
                // Extract target node from edge key
                const target = k.split('->')[1];
                if (target) nodesToActivate.add(target);
                // Also activate source
                const source = k.split('->')[0];
                if (source) nodesToActivate.add(source);
            }
        }

        if (edgesToActivate.size === 0) return;

        // Activate edges
        setActiveEdges(prev => {
            const next = new Set(prev);
            edgesToActivate.forEach(k => next.add(k));
            return next;
        });
        setActiveNodes(prev => {
            const next = new Set(prev);
            nodesToActivate.forEach(k => next.add(k));
            return next;
        });

        // Schedule deactivation — each edge gets its own timer
        // If a new event fires on an already-active edge, the timer resets
        for (const k of edgesToActivate) {
            const existing = timersRef.current.get(k);
            if (existing) clearTimeout(existing);

            const timer = setTimeout(() => {
                setActiveEdges(prev => {
                    const next = new Set(prev);
                    next.delete(k);
                    return next;
                });
                const target = k.split('->')[1];
                const source = k.split('->')[0];
                if (target) setActiveNodes(prev => { const n = new Set(prev); n.delete(target); return n; });
                if (source) setActiveNodes(prev => { const n = new Set(prev); n.delete(source); return n; });
                timersRef.current.delete(k);
            }, FADE_DURATION);

            timersRef.current.set(k, timer);
        }
    }, [liveEvents]); // eslint-disable-line react-hooks/exhaustive-deps

    // Cleanup timers on unmount
    useEffect(() => {
        return () => {
            timersRef.current.forEach(t => clearTimeout(t));
        };
    }, []);

    // Stats
    const llmCount = nodes.filter(n => n.type === 'llm').length;
    const toolCountVal = nodes.filter(n => n.type === 'tool').length;
    const totalCalls = nodes.filter(n => n.type === 'tool' || n.type === 'llm').reduce((s, n) => s + n.metrics.calls, 0);

    // Interaction State
    const [hoveredNode, setHoveredNode] = useState<string | null>(null);
    const [tooltip, setTooltip] = useState<{
        visible: boolean; x: number; y: number; node: TopoNode | null;
    }>({ visible: false, x: 0, y: 0, node: null });

    const handleNodeEnter = useCallback((node: TopoNode, e: React.MouseEvent) => {
        setHoveredNode(node.id);
        const rect = (e.currentTarget as SVGElement).closest('.sys-topo')?.getBoundingClientRect();
        if (!rect) return;
        setTooltip({ visible: true, x: e.clientX - rect.left + 24, y: e.clientY - rect.top - 16, node });
    }, []);

    const handleNodeLeave = useCallback(() => {
        setHoveredNode(null);
        setTooltip(prev => ({ ...prev, visible: false }));
    }, []);

    const hasData = allEvents.length > 0;

    if (!hasData) {
        return (
            <div className="sys-topo">
                <div className="sys-topo-header">
                    <span className="sys-topo-title">System Architecture</span>
                </div>
                <div className="sys-topo-empty">
                    <div className="sys-topo-empty-ring" />
                    <div className="sys-topo-empty-text">Awaiting system initialization…</div>
                    <div className="sys-topo-empty-sub">Run an active agent to visualize capabilities</div>
                </div>
            </div>
        );
    }

    const maxEdgeCalls = Math.max(...edges.map(e => e.count), 1);
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const colorFor = (type: TopoNode['type']) => {
        switch (type) {
            case 'brain': return COLORS.brain;
            case 'llm': return COLORS.llm;
            case 'tool': return COLORS.tool;
            default: return COLORS.user;
        }
    };

    // Compute edge bezier params
    const edgePaths = edges.map(edge => {
        const from = nodeMap.get(edge.from);
        const to = nodeMap.get(edge.to);
        if (!from || !to) return null;
        const cpX1 = from.x + (to.x - from.x) * 0.4;
        const cpX2 = from.x + (to.x - from.x) * 0.6;
        const d = `M ${from.x} ${from.y} C ${cpX1} ${from.y}, ${cpX2} ${to.y}, ${to.x} ${to.y}`;
        return { ...edge, d, fromNode: from, toNode: to, key: `${edge.from}->${edge.to}` };
    }).filter(Boolean) as Array<TopoEdge & { d: string; fromNode: TopoNode; toNode: TopoNode; key: string }>;

    return (
        <div className="sys-topo">
            {/* Header */}
            <div className="sys-topo-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span className="sys-topo-title">System Architecture</span>
                    {!connected ? (
                        <span className="sys-topo-disconnected">
                            <span className="sys-topo-disconnected-dot" />
                            Disconnected
                        </span>
                    ) : isLive ? (
                        <span className="sys-topo-live">
                            <span className="sys-topo-live-dot" />
                            Live
                        </span>
                    ) : null}
                </div>
                <div className="sys-topo-stats">
                    <div className="sys-topo-stat">
                        <div className="sys-topo-stat-val">{llmCount}</div>
                        <div className="sys-topo-stat-lbl">Models</div>
                    </div>
                    <div className="sys-topo-stat">
                        <div className="sys-topo-stat-val">{toolCountVal}</div>
                        <div className="sys-topo-stat-lbl">Tools</div>
                    </div>
                    <div className="sys-topo-stat">
                        <div className="sys-topo-stat-val">{totalCalls}</div>
                        <div className="sys-topo-stat-lbl">API Calls</div>
                    </div>
                </div>
            </div>

            {/* SVG Diagram */}
            <svg className="sys-topo-svg" viewBox={`0 0 ${svgW} ${svgH}`} preserveAspectRatio="xMidYMid meet">
                {/* ── Column Titles ── */}
                <g className="sys-topo-col-titles">
                    <text x={COL_USER} y={40} textAnchor="middle" fill={COLORS.user} fontSize="11" fontWeight="700" fontFamily="'Outfit', sans-serif" opacity="0.6" letterSpacing="1.5px">USER</text>
                    <text x={COL_LLM} y={40} textAnchor="middle" fill={COLORS.llm} fontSize="11" fontWeight="700" fontFamily="'Outfit', sans-serif" opacity="0.6" letterSpacing="1.5px">LANGUAGE MODELS</text>
                    <text x={COL_TOOL} y={40} textAnchor="middle" fill={COLORS.tool} fontSize="11" fontWeight="700" fontFamily="'Outfit', sans-serif" opacity="0.6" letterSpacing="1.5px">ACTIVE TOOLS</text>
                    <text x={COL_RESP} y={40} textAnchor="middle" fill={COLORS.output} fontSize="11" fontWeight="700" fontFamily="'Outfit', sans-serif" opacity="0.6" letterSpacing="1.5px">RESPONSE</text>
                </g>

                <defs>
                    <filter id="st-glow" x="-50%" y="-50%" width="200%" height="200%">
                        <feGaussianBlur stdDeviation="5" result="blur" />
                        <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                    </filter>
                    <filter id="st-brain-glow" x="-100%" y="-100%" width="300%" height="300%">
                        <feGaussianBlur stdDeviation="14" result="blur" />
                        <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                    </filter>
                    <linearGradient id="edge-grad-brain" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor={COLORS.brain} stopOpacity="0.06" />
                        <stop offset="50%" stopColor={COLORS.brain} stopOpacity="0.18" />
                        <stop offset="100%" stopColor={COLORS.brain} stopOpacity="0.06" />
                    </linearGradient>
                </defs>

                {/* ── Base Edges (always visible, dim) ── */}
                {edgePaths.map(ep => {
                    const isConnected = hoveredNode === ep.from || hoveredNode === ep.to;
                    const weight = ep.count / maxEdgeCalls;
                    const baseOpacity = hoveredNode
                        ? (isConnected ? 0.25 + weight * 0.35 : 0.03)
                        : 0.06 + weight * 0.12;
                    const baseWidth = hoveredNode
                        ? (isConnected ? 1.5 + weight * 2.5 : 0.5)
                        : 0.8 + weight * 1.5;

                    const edgeColor = hoveredNode && isConnected
                        ? colorFor(ep.fromNode.type)
                        : 'url(#edge-grad-brain)';

                    return (
                        <path
                            key={ep.key}
                            d={ep.d}
                            fill="none"
                            stroke={edgeColor}
                            strokeWidth={baseWidth}
                            strokeOpacity={baseOpacity}
                            className="edge-path"
                        />
                    );
                })}

                {/* ── Active Edge Glow (CSS-transitioned, subtle) ── */}
                {edgePaths.map(ep => {
                    const isActive = activeEdges.has(ep.key);
                    const color = ep.fromNode.type === 'user' ? COLORS.brainSoft
                        : ep.toNode.type === 'llm' ? COLORS.llm
                            : ep.toNode.type === 'tool' ? COLORS.tool
                                : ep.toNode.type === 'output' ? COLORS.brainSoft
                                    : COLORS.brain;

                    return (
                        <path
                            key={`active-${ep.key}`}
                            d={ep.d}
                            fill="none"
                            stroke={color}
                            strokeWidth={5}
                            filter="url(#st-glow)"
                            className={`edge-active-glow ${isActive ? 'on' : ''}`}
                        />
                    );
                })}

                {/* ── Node Pulse Rings (CSS-transitioned) ── */}
                {nodes.map(node => {
                    const isActive = activeNodes.has(node.id);
                    const c = colorFor(node.type);
                    const r = node.type === 'brain' ? 44 : node.type === 'llm' ? 28 : node.type === 'tool' ? 24 : 20;

                    return (
                        <circle
                            key={`pulse-${node.id}`}
                            cx={node.x}
                            cy={node.y}
                            r={r}
                            fill="none"
                            stroke={c}
                            strokeWidth={1.5}
                            className={`node-pulse-ring ${isActive ? 'on' : ''}`}
                        />
                    );
                })}

                {/* ── Nodes ── */}
                {nodes.map(node => {
                    const isHovered = hoveredNode === node.id;
                    const isConnected = hoveredNode && edges.some(e =>
                        (e.from === node.id && e.to === hoveredNode) ||
                        (e.to === node.id && e.from === hoveredNode)
                    );
                    const isDimmed = hoveredNode && !isHovered && !isConnected;

                    const c = colorFor(node.type);
                    const hasErrors = node.metrics.errors > 0;
                    const truncLabel = node.label.length > 14 ? node.label.slice(0, 13) + '…' : node.label;

                    return (
                        <g
                            key={node.id}
                            className="node-group"
                            data-hovered={isHovered || undefined}
                            data-dimmed={isDimmed || undefined}
                            onMouseEnter={(e) => handleNodeEnter(node, e)}
                            onMouseLeave={handleNodeLeave}
                            style={{ cursor: 'pointer' }}
                        >
                            {node.type === 'brain' && (
                                <g className={connected ? '' : 'brain-disconnected'}>
                                    <BrainIcon x={node.x} y={node.y} />
                                </g>
                            )}
                            {node.type === 'llm' && <LlmIcon x={node.x} y={node.y} color={c} />}
                            {node.type === 'tool' && <ToolIcon x={node.x} y={node.y} color={c} />}
                            {(node.type === 'user' || node.type === 'output') && <IoIcon x={node.x} y={node.y} color={c} />}

                            {hasErrors && (
                                <circle cx={node.x + (node.type === 'brain' ? 28 : 18)} cy={node.y - (node.type === 'brain' ? 28 : 18)}
                                    r={5} fill={COLORS.error} />
                            )}

                            <text
                                x={node.x}
                                y={node.y - (node.type === 'brain' ? 48 : node.type === 'llm' ? 34 : node.type === 'tool' ? 30 : 28)}
                                textAnchor="middle" fill={node.type === 'brain' ? COLORS.brain : c}
                                fontSize={node.type === 'brain' ? 13 : 11}
                                fontWeight={node.type === 'brain' ? 700 : 600}
                                fontFamily="'Outfit', sans-serif"
                            >{node.type === 'brain' ? 'Open CLAW' : truncLabel}</text>

                            <text
                                x={node.x}
                                y={node.y + (node.type === 'brain' ? 50 : node.type === 'llm' ? 36 : node.type === 'tool' ? 32 : 30)}
                                textAnchor="middle"
                                fill={node.type === 'brain' ? COLORS.brainSoft : `${c}aa`}
                                fontSize="9"
                                fontFamily="'JetBrains Mono', monospace"
                            >{node.metrics.calls} {node.type === 'user' || node.type === 'output' ? 'events' : 'calls'}</text>
                        </g>
                    );
                })}
            </svg>

            {/* ── Tooltip ── */}
            {tooltip.node && (
                <div className={`sys-topo-tooltip ${tooltip.visible ? 'visible' : ''}`}
                    style={{ left: tooltip.x, top: tooltip.y }}>
                    <div className="st-tt-title">
                        <span style={{ color: colorFor(tooltip.node.type) }}>{tooltip.node.label}</span>
                        <span className="st-tt-type" style={{ color: colorFor(tooltip.node.type) }}>{tooltip.node.type}</span>
                    </div>
                    <div className="st-tt-row">
                        <span className="st-tt-lbl">Total Executions</span>
                        <span className="st-tt-val">{tooltip.node.metrics.calls}</span>
                    </div>
                    <div className="st-tt-row">
                        <span className="st-tt-lbl">Error Fallbacks</span>
                        <span className="st-tt-val" style={{ color: tooltip.node.metrics.errors > 0 ? COLORS.error : 'inherit' }}>
                            {tooltip.node.metrics.errors}
                            {tooltip.node.metrics.calls > 0 && tooltip.node.metrics.errors > 0 &&
                                ` (${Math.round((tooltip.node.metrics.errors / tooltip.node.metrics.calls) * 100)}%)`}
                        </span>
                    </div>
                    <div className="st-tt-row">
                        <span className="st-tt-lbl">Avg Response</span>
                        <span className="st-tt-val">
                            {tooltip.node.metrics.avgLatencyMs > 0 ? `${Math.round(tooltip.node.metrics.avgLatencyMs)}ms` : '—'}
                        </span>
                    </div>
                    <div className="st-tt-row">
                        <span className="st-tt-lbl">Last Active</span>
                        <span className="st-tt-val">
                            {tooltip.node.metrics.lastActiveTs > 0
                                ? new Date(tooltip.node.metrics.lastActiveTs * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                                : '—'}
                        </span>
                    </div>
                </div>
            )}

            {/* ── Legend ── */}
            <div className="sys-topo-legend">
                <span className="st-legend-item"><svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="none" stroke={COLORS.brain} strokeWidth="1.5" /></svg> Core</span>
                <span className="st-legend-item"><svg width="10" height="10"><polygon points="5,1 9,8 1,8" fill="none" stroke={COLORS.llm} strokeWidth="1.5" /></svg> LLM</span>
                <span className="st-legend-item"><svg width="10" height="10"><rect x="1" y="1" width="8" height="8" rx="1" fill="none" stroke={COLORS.tool} strokeWidth="1.5" /></svg> Tool</span>
                <span className="st-legend-item"><svg width="10" height="10"><circle cx="5" cy="5" r="3" fill="none" stroke={COLORS.user} strokeWidth="1" /></svg> I/O</span>
            </div>
        </div>
    );
}
