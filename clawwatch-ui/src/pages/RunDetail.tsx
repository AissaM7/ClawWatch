import { useState, useEffect, useCallback, useMemo } from 'react';
import type { ClawEvent, EnrichedEvent } from '../lib/types';
import { fetchRunEvents, createSSEConnection } from '../lib/api';
import { scoreEvent } from '../lib/risk';
import AgentPathMiniMap from '../components/AgentPathMiniMap';
import { scoreGoalAlignment, computeGoalDrift } from '../lib/goalAlignment';
import { buildDescription } from '../lib/descriptions';
import { estimateCost, formatCost } from '../lib/cost';
import { buildTraceTree, flattenTraceTree, collectDefaultExpanded, formatTraceDuration } from '../lib/traceTree';
import type { TraceNode } from '../lib/traceTree';
import TraceRow from '../components/TraceRow';
import InspectorPanel from '../components/InspectorPanel';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ChevronDown, ChevronUp, Search,
  Layers, AlertCircle, Cpu, Wrench, Activity
} from 'lucide-react';

// ── Enrichment ──────────────────────────────────────────────────

function enrichEvents(events: ClawEvent[], goal: string): EnrichedEvent[] {
  return events.map(e => ({
    ...e,
    risk: scoreEvent(e, events),
    goal_alignment: scoreGoalAlignment(e, goal),
    description: buildDescription(e),
  }));
}

// ── Run Detail Page ─────────────────────────────────────────────

export default function RunDetail() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // ── State ──────────────────────────────────────────────────────
  const [rawEvents, setRawEvents] = useState<ClawEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [initialized, setInitialized] = useState(false);
  const [searchText, setSearchText] = useState(searchParams.get('q') || '');
  const [typeFilter, setTypeFilter] = useState<string>(searchParams.get('type') || 'all');

  // ── Effects ────────────────────────────────────────────────────
  useEffect(() => {
    if (!runId) return;
    fetchRunEvents(runId)
      .then(events => { setRawEvents(events); setLoading(false); })
      .catch(() => setLoading(false));
  }, [runId]);

  useEffect(() => {
    const cleanup = createSSEConnection((event) => {
      if (event.run_id === runId) setRawEvents(prev => [...prev, event]);
    });
    return cleanup;
  }, [runId]);

  // ── Derived data ───────────────────────────────────────────────
  const goal = rawEvents.length > 0 ? rawEvents[0].goal : '';
  const agentName = rawEvents.length > 0 ? rawEvents[0].agent_name : '';
  const enrichedEvents = useMemo(() => enrichEvents(rawEvents, goal), [rawEvents, goal]);

  const filteredEvents = useMemo(() => {
    let events = enrichedEvents;
    if (typeFilter !== 'all') events = events.filter(e => e.event_type === typeFilter);
    if (searchText.trim()) {
      const q = searchText.toLowerCase();
      events = events.filter(e => e.description.toLowerCase().includes(q));
    }
    return events;
  }, [enrichedEvents, typeFilter, searchText]);

  // ── Trace tree ─────────────────────────────────────────────────
  const traceTree = useMemo(() => buildTraceTree(filteredEvents), [filteredEvents]);

  // Initialize expanded nodes on first load
  useEffect(() => {
    if (!initialized && traceTree.length > 0) {
      setExpandedNodes(collectDefaultExpanded(traceTree));
      setInitialized(true);
    }
  }, [traceTree, initialized]);

  const flatRows = useMemo(
    () => flattenTraceTree(traceTree, expandedNodes),
    [traceTree, expandedNodes]
  );

  // ── Stats ──────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const onGoal = enrichedEvents.filter(e => e.goal_alignment.is_on_goal).length;
    const totalErrors = enrichedEvents.filter(e =>
      e.event_type === 'tool_error' || e.event_type === 'llm_error' || e.event_type === 'agent_error'
      || (e.event_type === 'agent_end' && e.status && e.status !== 'ok' && e.status !== 'completed' && e.status !== 'running' && e.status !== 'reset' && e.status !== 'unknown')
    ).length;
    const llmCalls = enrichedEvents.filter(e => e.event_type === 'llm_call_end');
    const toolCalls = enrichedEvents.filter(e => e.event_type === 'tool_call_start');
    const totalCost = llmCalls.reduce((sum, e) =>
      sum + estimateCost(e.model || '', e.input_tokens || 0, e.output_tokens || 0), 0
    );
    const goalPct = enrichedEvents.length > 0
      ? Math.round((onGoal / enrichedEvents.length) * 100) : 0;
    return {
      goalPct, totalErrors,
      llmCalls: llmCalls.length,
      toolCalls: toolCalls.length,
      totalCost,
      goalDrift: computeGoalDrift(enrichedEvents.map(e => e.goal_alignment)),
    };
  }, [enrichedEvents]);

  // ── Timing ─────────────────────────────────────────────────────
  const minOffset = enrichedEvents.length > 0 ? enrichedEvents[0].run_offset_ms : 0;
  const maxRawOffset = enrichedEvents.length > 0
    ? Math.max(...enrichedEvents.map(e => e.run_offset_ms + (e.duration_ms || 0)))
    : 1;
  const totalDuration = Math.max(1, maxRawOffset - minOffset);
  const runDurationMs = maxRawOffset - minOffset;

  // ── URL sync ───────────────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams();
    if (searchText) params.set('q', searchText);
    if (typeFilter !== 'all') params.set('type', typeFilter);
    setSearchParams(params, { replace: true });
  }, [searchText, typeFilter, setSearchParams]);

  // ── Expand/collapse all ────────────────────────────────────────
  const expandAll = useCallback(() => {
    const all = new Set<string>();
    const walk = (nodes: TraceNode[]) => {
      for (const n of nodes) {
        if (n.children.length > 0) all.add(n.id);
        walk(n.children);
      }
    };
    walk(traceTree);
    setExpandedNodes(all);
  }, [traceTree]);

  const collapseAll = useCallback(() => {
    setExpandedNodes(new Set());
  }, []);

  const toggleNode = useCallback((nodeId: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId);
      return next;
    });
  }, []);

  // ── Selected node for inspector ────────────────────────────────
  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null;
    const find = (nodes: TraceNode[]): TraceNode | null => {
      for (const n of nodes) {
        if (n.id === selectedNodeId) return n;
        const child = find(n.children);
        if (child) return child;
      }
      return null;
    };
    return find(traceTree);
  }, [traceTree, selectedNodeId]);

  // ── Loading state ──────────────────────────────────────────────
  if (loading) {
    return (
      <div className="trace-loading">
        <div className="trace-loading-spinner" />
        <p>Loading trace…</p>
      </div>
    );
  }

  const isRunning = !rawEvents.some(e => e.event_type === 'agent_end');
  const panelOpen = selectedNode !== null;

  return (
    <div className="trace-page">
      {/* ── Top Bar ── */}
      <div className="trace-topbar">
        <div className="trace-topbar-left">
          <button className="trace-back-btn" onClick={() => navigate('/')}>
            ← Runs
          </button>
          <span className="trace-sep" />
          <span className={`trace-status-dot ${isRunning ? 'trace-status-dot--running' : 'trace-status-dot--done'}`} />
          <span className="trace-agent-name">{agentName}</span>
        </div>
        <div className="trace-topbar-stats">
          <span className="trace-stat">
            <Activity size={12} />
            {stats.goalPct}% on-goal
          </span>
          <span className="trace-stat">
            <Cpu size={12} />
            {stats.llmCalls} LLM
          </span>
          <span className={`trace-stat${stats.totalErrors > 0 ? ' trace-stat--error' : ''}`}>
            <AlertCircle size={12} />
            {stats.totalErrors} errors
          </span>
          <span className="trace-stat">
            <Wrench size={12} />
            {stats.toolCalls} tools
          </span>
          <span className="trace-stat">{formatCost(stats.totalCost)}</span>
          {runDurationMs > 0 && (
            <span className="trace-stat">{formatTraceDuration(runDurationMs)}</span>
          )}
        </div>
      </div>

      {/* ── Toolbar ── */}
      <div className="trace-toolbar">
        <div className="trace-toolbar-left">
          <div className="trace-search-wrap">
            <Search size={14} className="trace-search-icon" />
            <input
              type="text"
              className="trace-search"
              placeholder="Search events…"
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
            />
          </div>
          <select
            className="trace-filter"
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}
          >
            <option value="all">All Types</option>
            <option value="llm_call_start">LLM Calls</option>
            <option value="tool_call_start">Tool Calls</option>
            <option value="agent_end">Agent End</option>
            <option value="user_prompt">User Prompt</option>
            <option value="tool_error">Tool Error</option>
            <option value="llm_error">LLM Error</option>
          </select>
        </div>
        <div className="trace-toolbar-right">
          <button className="trace-toolbar-btn" onClick={expandAll} title="Expand all">
            <ChevronDown size={14} />
            <span>Expand</span>
          </button>
          <button className="trace-toolbar-btn" onClick={collapseAll} title="Collapse all">
            <ChevronUp size={14} />
            <span>Collapse</span>
          </button>
          <span className="trace-event-count">
            <Layers size={12} />
            {filteredEvents.length} events
          </span>
        </div>
      </div>

      {/* ── MiniMap: The Crown Jewel ── */}
      <AgentPathMiniMap
        traceTree={traceTree}
        onNodeClick={(traceNodeId) => {
          setSelectedNodeId(traceNodeId);
          // Expand parent nodes to make the target visible
          setExpandedNodes(prev => {
            const next = new Set(prev);
            next.add(traceNodeId);
            return next;
          });
        }}
      />

      {/* ── Body: Trace + Inspector ── */}
      <div className="trace-body">
        <div className={`trace-waterfall${panelOpen ? ' trace-waterfall--compressed' : ''}`}>
          {/* Column header */}
          <div className="trace-col-header">
            <div className="trace-col-tree">TRACE</div>
            <div className="trace-col-dur">DURATION</div>
            <div className="trace-col-bar">WATERFALL</div>
          </div>

          {/* Rows */}
          <div className="trace-rows">
            {flatRows.length === 0 && (
              <div className="trace-empty">No events match the current filters.</div>
            )}
            {flatRows.map(row => (
              <TraceRow
                key={row.node.id}
                row={row}
                isExpanded={expandedNodes.has(row.node.id)}
                isSelected={selectedNodeId === row.node.id}
                onToggle={() => toggleNode(row.node.id)}
                onSelect={() => setSelectedNodeId(
                  selectedNodeId === row.node.id ? null : row.node.id
                )}
                totalDurationMs={totalDuration}
                minOffsetMs={minOffset}
              />
            ))}
          </div>
        </div>

        {/* Inspector Panel */}
        {selectedNode && (
          <InspectorPanel
            node={selectedNode}
            onClose={() => setSelectedNodeId(null)}
          />
        )}
      </div>
    </div>
  );
}
