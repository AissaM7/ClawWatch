// ── AgentPathMiniMap v2 — Semantic Chunking ─────────────────────
// Intent Chapters: Archived cards → Active graph → Swarm ready
//
// Layout: [Card 1] [Card 2] ... [═══ Active Node Graph ═══]

import React, { useMemo, useRef, useEffect, useCallback, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Play, User, Zap, Cpu, Wrench, Check, X,
    AlertTriangle, ChevronLeft, ChevronRight,
    Clock, Layers, AlertCircle
} from 'lucide-react';
import type { MiniMapNode, MiniMapNodeKind, Chapter, ChapterHealth } from '../lib/minimap';
import type { TraceNode, TraceStatus } from '../lib/traceTree';
import { compressTraceToChapters } from '../lib/minimap';

// ── Icon + color mapping ────────────────────────────────────────

const NODE_CONFIG: Record<MiniMapNodeKind, {
    icon: React.FC<{ size?: number; strokeWidth?: number }>;
    colorClass: string;
    glowColor: string;
}> = {
    start: { icon: Play, colorClass: 'mm-node--start', glowColor: 'rgba(156, 163, 175, 0.3)' },
    user_prompt: { icon: User, colorClass: 'mm-node--prompt', glowColor: 'rgba(59, 130, 246, 0.5)' },
    llm_flash: { icon: Zap, colorClass: 'mm-node--flash', glowColor: 'rgba(52, 211, 153, 0.4)' },
    llm_pro: { icon: Cpu, colorClass: 'mm-node--pro', glowColor: 'rgba(139, 92, 246, 0.4)' },
    llm_generic: { icon: Cpu, colorClass: 'mm-node--generic', glowColor: 'rgba(156, 163, 175, 0.3)' },
    tool_call: { icon: Wrench, colorClass: 'mm-node--tool', glowColor: 'rgba(251, 191, 36, 0.4)' },
    end_success: { icon: Check, colorClass: 'mm-node--success', glowColor: 'rgba(34, 197, 94, 0.5)' },
    end_fail: { icon: X, colorClass: 'mm-node--fail', glowColor: 'rgba(239, 68, 68, 0.5)' },
    end_halt: { icon: AlertTriangle, colorClass: 'mm-node--halt', glowColor: 'rgba(251, 146, 60, 0.4)' },
};

const HEALTH_COLORS: Record<ChapterHealth, { dot: string; border: string; glow: string }> = {
    healthy: { dot: '#34d399', border: 'rgba(52, 211, 153, 0.4)', glow: 'rgba(52, 211, 153, 0.15)' },
    flaky: { dot: '#fbbf24', border: 'rgba(251, 191, 36, 0.4)', glow: 'rgba(251, 191, 36, 0.12)' },
    failed: { dot: '#f87171', border: 'rgba(248, 113, 113, 0.5)', glow: 'rgba(248, 113, 113, 0.15)' },
};

// ── ChapterCard (Archived/Collapsed) ────────────────────────────

interface ChapterCardProps {
    chapter: Chapter;
    index: number;
    isHovered: boolean;
    onHover: (id: string | null) => void;
    onClick: (traceNodeId: string) => void;
}

const ChapterCard = React.memo(function ChapterCard({
    chapter, index, isHovered, onHover, onClick,
}: ChapterCardProps) {
    const colors = HEALTH_COLORS[chapter.healthLabel];

    return (
        <motion.div
            className={`mm-chapter-card mm-chapter-card--${chapter.healthLabel}${isHovered ? ' mm-chapter-card--hovered' : ''}`}
            initial={{ opacity: 0, scale: 0.9, x: -10 }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            transition={{
                type: 'spring',
                stiffness: 400,
                damping: 30,
                delay: index * 0.05,
            }}
            onMouseEnter={() => onHover(chapter.id)}
            onMouseLeave={() => onHover(null)}
            onClick={() => onClick(chapter.traceNodeId)}
            style={isHovered ? { borderColor: colors.border, boxShadow: `0 0 20px ${colors.glow}` } : undefined}
        >
            {/* Health dot */}
            <span className="mm-chapter-health" style={{ background: colors.dot }} />

            {/* Title */}
            <span className="mm-chapter-title">{chapter.title}</span>

            {/* Meta row */}
            <span className="mm-chapter-meta">
                <span className="mm-chapter-meta-item">
                    <Clock size={9} />
                    {chapter.durationText}
                </span>
                <span className="mm-chapter-meta-item">
                    <Layers size={9} />
                    {chapter.stepCount}
                </span>
                {chapter.errorCount > 0 && (
                    <span className="mm-chapter-meta-item mm-chapter-meta-item--error">
                        <AlertCircle size={9} />
                        {chapter.errorCount}
                    </span>
                )}
            </span>

            {/* Ghost preview — faint node trail on hover */}
            <AnimatePresence>
                {isHovered && chapter.nodes.length > 0 && (
                    <motion.div
                        className="mm-ghost-trail"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.15 }}
                    >
                        {chapter.nodes.slice(0, 8).map((node) => {
                            const config = NODE_CONFIG[node.kind];
                            const Icon = config.icon;
                            return (
                                <span key={node.id} className={`mm-ghost-dot ${config.colorClass}`}>
                                    <Icon size={8} strokeWidth={2.5} />
                                </span>
                            );
                        })}
                        {chapter.nodes.length > 8 && (
                            <span className="mm-ghost-more">+{chapter.nodes.length - 8}</span>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );
});

// ── MapNode (Active chapter's expanded graph) ───────────────────

interface MapNodeProps {
    node: MiniMapNode;
    index: number;
    isActive: boolean;
    isHovered: boolean;
    onHover: (id: string | null) => void;
    onClick: (traceNodeId: string) => void;
}

const MapNodeComponent = React.memo(function MapNodeComponent({
    node, index, isActive, isHovered, onHover, onClick,
}: MapNodeProps) {
    const config = NODE_CONFIG[node.kind];
    const Icon = config.icon;

    return (
        <motion.div
            className={`mm-node ${config.colorClass}${isActive ? ' mm-node--active' : ''}${isHovered ? ' mm-node--hovered' : ''}`}
            initial={{ opacity: 0, scale: 0.5, x: 20 }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            transition={{
                type: 'spring',
                stiffness: 300,
                damping: 30,
                delay: index * 0.03,
            }}
            onMouseEnter={() => onHover(node.id)}
            onMouseLeave={() => onHover(null)}
            onClick={() => onClick(node.traceNodeId)}
            style={isHovered || isActive ? { boxShadow: `0 0 15px ${config.glowColor}` } : undefined}
        >
            {isActive && (
                <span className="mm-pulse-ring" style={{
                    borderColor: config.glowColor.replace(/[\d.]+\)$/, '0.6)'),
                }} />
            )}
            <Icon size={14} strokeWidth={2} />
            {node.count > 1 && (
                <span className="mm-count-badge">×{node.count}</span>
            )}
        </motion.div>
    );
});

// ── Connector ───────────────────────────────────────────────────

interface ConnectorProps {
    toStatus: MiniMapNode['status'];
    isActivePath: boolean;
    index: number;
}

const Connector = React.memo(function Connector({ toStatus, isActivePath, index }: ConnectorProps) {
    const isError = toStatus === 'error' || toStatus === 'timeout';

    return (
        <motion.div
            className={`mm-connector${isError ? ' mm-connector--error' : ''}${isActivePath ? ' mm-connector--active' : ''}`}
            initial={{ scaleX: 0, opacity: 0 }}
            animate={{ scaleX: 1, opacity: 1 }}
            transition={{
                type: 'spring',
                stiffness: 400,
                damping: 40,
                delay: index * 0.03 + 0.015,
            }}
        >
            {isActivePath && <span className="mm-comet" />}
        </motion.div>
    );
});

// ── Tooltip ─────────────────────────────────────────────────────

function Tooltip({ node }: { node: MiniMapNode }) {
    const statusLabel: Record<TraceStatus, string> = {
        success: 'Success',
        error: 'Error',
        timeout: 'Timed Out',
        halt: 'Halted',
        running: 'Running',
        neutral: 'Idle',
    };

    const statusColor: Record<TraceStatus, string> = {
        success: '#34d399',
        error: '#f87171',
        timeout: '#fbbf24',
        halt: '#fb923c',
        running: '#60a5fa',
        neutral: '#71717a',
    };

    return (
        <motion.div
            className="mm-tooltip"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15 }}
        >
            <div className="mm-tooltip-header">
                <span className="mm-tooltip-time">+{node.durationText || '0s'}</span>
                <span className="mm-tooltip-status" style={{ color: statusColor[node.status] }}>
                    {statusLabel[node.status]}
                </span>
            </div>
            <div className="mm-tooltip-snippet">{node.snippet || node.label}</div>
            {node.model && (
                <div className="mm-tooltip-model">{node.model.split('/').pop()}</div>
            )}
            {node.count > 1 && (
                <div className="mm-tooltip-count">{node.count} attempts</div>
            )}
        </motion.div>
    );
}

// ── Chapter Separator (→ connector between cards and/or graph) ──

function ChapterSep() {
    return <div className="mm-chapter-sep"><ChevronRight size={10} /></div>;
}

// ── Main AgentPathMiniMap ───────────────────────────────────────

interface AgentPathMiniMapProps {
    traceTree: TraceNode[];
    onNodeClick: (traceNodeId: string) => void;
}

function AgentPathMiniMap({ traceTree, onNodeClick }: AgentPathMiniMapProps) {
    const chapters = useMemo(() => compressTraceToChapters(traceTree), [traceTree]);
    const scrollRef = useRef<HTMLDivElement>(null);
    const [hoveredId, setHoveredId] = useState<string | null>(null);
    const [canScrollLeft, setCanScrollLeft] = useState(false);
    const [canScrollRight, setCanScrollRight] = useState(false);

    // The last chapter is "Active" — all others are "Archived"
    const archivedChapters = chapters.slice(0, -1);
    const activeChapter = chapters.length > 0 ? chapters[chapters.length - 1] : null;

    // Total step count across all chapters
    const totalSteps = chapters.reduce((acc, ch) => acc + ch.stepCount, 0);

    // Auto-scroll to latest
    useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
    }, [chapters.length, activeChapter?.nodes.length]);

    // Scroll state
    const updateScrollState = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        setCanScrollLeft(el.scrollLeft > 10);
        setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 10);
    }, []);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        updateScrollState();
        el.addEventListener('scroll', updateScrollState, { passive: true });
        const ro = new ResizeObserver(updateScrollState);
        ro.observe(el);
        return () => {
            el.removeEventListener('scroll', updateScrollState);
            ro.disconnect();
        };
    }, [updateScrollState]);

    const scrollBy = useCallback((direction: number) => {
        const el = scrollRef.current;
        if (el) el.scrollBy({ left: direction * 200, behavior: 'smooth' });
    }, []);

    const handleClick = useCallback((traceNodeId: string) => {
        onNodeClick(traceNodeId);
        const targetEl = document.querySelector(`[data-trace-id="${traceNodeId}"]`);
        if (targetEl) {
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            targetEl.classList.add('trace-row--flash');
            setTimeout(() => targetEl.classList.remove('trace-row--flash'), 1200);
        }
    }, [onNodeClick]);

    if (chapters.length === 0) return null;

    const activeNodes = activeChapter?.nodes || [];
    const activeNodeCount = activeNodes.length;
    const hoveredNode = hoveredId ? activeNodes.find(n => n.id === hoveredId) : null;

    return (
        <div className="mm-container">
            {/* Header */}
            <div className="mm-label">
                <span className="mm-label-text">AGENT PATH</span>
                <span className="mm-label-count">{chapters.length} {chapters.length === 1 ? 'chapter' : 'chapters'} · {totalSteps} steps</span>
            </div>

            {/* Scroll controls */}
            {canScrollLeft && (
                <button className="mm-scroll-btn mm-scroll-btn--left" onClick={() => scrollBy(-1)} aria-label="Scroll left">
                    <ChevronLeft size={14} />
                </button>
            )}
            {canScrollRight && (
                <button className="mm-scroll-btn mm-scroll-btn--right" onClick={() => scrollBy(1)} aria-label="Scroll right">
                    <ChevronRight size={14} />
                </button>
            )}

            {/* Rail */}
            <div
                className={`mm-rail${canScrollLeft ? ' mm-rail--fade-left' : ''}${canScrollRight ? ' mm-rail--fade-right' : ''}`}
                ref={scrollRef}
            >
                <div className="mm-track">
                    {/* Archived chapters → compact glassmorphism cards */}
                    {archivedChapters.map((chapter, i) => (
                        <React.Fragment key={chapter.id}>
                            {i > 0 && <ChapterSep />}
                            <ChapterCard
                                chapter={chapter}
                                index={i}
                                isHovered={hoveredId === chapter.id}
                                onHover={setHoveredId}
                                onClick={handleClick}
                            />
                        </React.Fragment>
                    ))}

                    {/* Separator between archived and active */}
                    {archivedChapters.length > 0 && activeChapter && <ChapterSep />}

                    {/* Active chapter → expanded node-link graph */}
                    {activeChapter && (
                        <div className="mm-active-chapter">
                            {/* Active chapter inline label */}
                            <span className="mm-active-label">{activeChapter.title.slice(0, 30)}{activeChapter.title.length > 30 ? '…' : ''}</span>

                            <div className="mm-active-nodes">
                                <AnimatePresence mode="popLayout">
                                    {activeNodes.map((node, i) => (
                                        <React.Fragment key={node.id}>
                                            {i > 0 && (
                                                <Connector
                                                    toStatus={node.status}
                                                    isActivePath={i === activeNodeCount - 1}
                                                    index={i}
                                                />
                                            )}
                                            <div className="mm-node-wrap" style={{ position: 'relative' }}>
                                                <MapNodeComponent
                                                    node={node}
                                                    index={i}
                                                    isActive={i === activeNodeCount - 1}
                                                    isHovered={hoveredId === node.id}
                                                    onHover={setHoveredId}
                                                    onClick={handleClick}
                                                />
                                                <AnimatePresence>
                                                    {hoveredId === node.id && hoveredNode && (
                                                        <Tooltip node={hoveredNode} />
                                                    )}
                                                </AnimatePresence>
                                            </div>
                                        </React.Fragment>
                                    ))}
                                </AnimatePresence>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

export default React.memo(AgentPathMiniMap);
