import { useState, useEffect, useCallback, useMemo } from 'react';
import type { ClawEvent, EnrichedEvent, RiskLevel, HallucinationReport } from '../lib/types';
import { fetchRunEvents, createSSEConnection } from '../lib/api';
import { scoreEvent } from '../lib/risk';
import { scoreGoalAlignment, computeGoalDrift } from '../lib/goalAlignment';
import { buildDescription, formatOffset } from '../lib/descriptions';
import { estimateCost, formatCost } from '../lib/cost';
import { buildHallucinationReport, hasCompletionLanguage } from '../lib/hallucination';
import { buildTimeline, formatDuration, formatGap } from '../lib/timeline';
import type { TaskBlock, ExchangeBlock } from '../lib/timeline';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';

// ── Human-readable event labels ─────────────────────────────────

function humanEventLabel(event: EnrichedEvent): string {
  switch (event.event_type) {
    case 'llm_call_start':
      return `Called ${event.model || 'model'}`;
    case 'llm_call_end':
      return `Response from ${event.model || 'model'}`;
    case 'llm_error':
      return `Model error`;
    case 'tool_call_start':
      return `Using ${event.tool_name || 'tool'}`;
    case 'tool_call_end':
      return `Finished ${event.tool_name || 'tool'}`;
    case 'tool_error':
      return `Tool error`;
    case 'file_read':
      return 'Read file';
    case 'file_write':
      return 'Wrote file';
    case 'file_delete':
      return 'Deleted file';
    case 'network_request':
      return 'Network request';
    case 'network_response':
      return 'Network response';
    case 'subprocess_exec':
      return 'Ran subprocess';
    case 'env_access':
      return 'Env access';
    case 'loop_detected':
      return 'Loop detected';
    case 'agent_start':
      return 'Agent started';
    case 'agent_end':
      return 'Agent finished';
    case 'user_prompt':
      return 'User prompt';
    case 'agent_response':
      return 'Agent response';
    default:
      return event.event_type;
  }
}

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

  const [rawEvents, setRawEvents] = useState<ClawEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [searchText, setSearchText] = useState(searchParams.get('q') || '');
  const [riskFilter, setRiskFilter] = useState<string>(searchParams.get('risk') || 'all');
  const [typeFilter, setTypeFilter] = useState<string>(searchParams.get('type') || 'all');
  const [goalFilter, setGoalFilter] = useState<string>(searchParams.get('goal') || 'all');
  const [hallucinationReports, setHallucinationReports] = useState<HallucinationReport[]>([]);

  // Collapse state
  const [collapsedTasks, setCollapsedTasks] = useState<Set<number>>(new Set());
  const [collapsedExchanges, setCollapsedExchanges] = useState<Set<string>>(new Set());
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());
  const [expandedResponses, setExpandedResponses] = useState<Set<string>>(new Set());
  const [activeTaskIndex, setActiveTaskIndex] = useState<number | null>(null);
  const [collapsedSidebarSections, setCollapsedSidebarSections] = useState<Set<string>>(new Set());

  // Load events
  useEffect(() => {
    if (!runId) return;
    fetchRunEvents(runId)
      .then(events => {
        setRawEvents(events);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [runId]);

  // SSE for live events
  useEffect(() => {
    const cleanup = createSSEConnection((event) => {
      if (event.run_id === runId) {
        setRawEvents(prev => [...prev, event]);
      }
    });
    return cleanup;
  }, [runId]);

  // Derived data
  const goal = rawEvents.length > 0 ? rawEvents[0].goal : '';
  const agentName = rawEvents.length > 0 ? rawEvents[0].agent_name : '';
  const enrichedEvents = useMemo(() => enrichEvents(rawEvents, goal), [rawEvents, goal]);

  // Hallucination detection
  useEffect(() => {
    const reports: HallucinationReport[] = [];
    for (const e of enrichedEvents) {
      if (e.event_type === 'llm_call_end' && hasCompletionLanguage(e.llm_output_full || '')) {
        reports.push(buildHallucinationReport(rawEvents, e));
      }
      if (e.event_type === 'agent_end') {
        const lastLlm = [...enrichedEvents].reverse().find(x => x.event_type === 'llm_call_end');
        if (lastLlm) {
          reports.push(buildHallucinationReport(rawEvents, lastLlm));
        }
      }
    }
    setHallucinationReports(reports);
  }, [enrichedEvents, rawEvents]);

  // Filtering
  const filteredEvents = useMemo(() => {
    let events = enrichedEvents;
    if (typeFilter !== 'all') {
      events = events.filter(e => e.event_type === typeFilter);
    }
    if (riskFilter !== 'all') {
      const level = riskFilter as RiskLevel;
      events = events.filter(e => e.risk.level === level);
    }
    if (goalFilter === 'on') {
      events = events.filter(e => e.goal_alignment.is_on_goal);
    } else if (goalFilter === 'off') {
      events = events.filter(e => !e.goal_alignment.is_on_goal);
    }
    if (searchText.trim()) {
      const q = searchText.toLowerCase();
      events = events.filter(e => e.description.toLowerCase().includes(q));
    }
    return events;
  }, [enrichedEvents, typeFilter, riskFilter, goalFilter, searchText]);

  // Build the hierarchy
  const timeline = useMemo(() => buildTimeline(filteredEvents), [filteredEvents]);

  // Stats
  const stats = useMemo(() => {
    const onGoal = enrichedEvents.filter(e => e.goal_alignment.is_on_goal).length;
    const totalErrors = enrichedEvents.filter(e =>
      e.event_type === 'tool_error' || e.event_type === 'llm_error'
    ).length;
    const llmCalls = enrichedEvents.filter(e => e.event_type === 'llm_call_end');
    const toolCalls = enrichedEvents.filter(e => e.event_type === 'tool_call_start');
    const totalCost = llmCalls.reduce((sum, e) =>
      sum + estimateCost(e.model || '', e.input_tokens || 0, e.output_tokens || 0), 0
    );
    const goalPct = enrichedEvents.length > 0
      ? Math.round((onGoal / enrichedEvents.length) * 100) : 0;
    const highestRisk: RiskLevel = enrichedEvents.reduce<RiskLevel>((max, e) => {
      const order: RiskLevel[] = ['safe', 'low', 'medium', 'high', 'critical'];
      return order.indexOf(e.risk.level) > order.indexOf(max) ? e.risk.level : max;
    }, 'safe');
    return {
      goalPct,
      totalErrors,
      llmCalls: llmCalls.length,
      toolCalls: toolCalls.length,
      totalCost,
      highestRisk,
      goalDrift: computeGoalDrift(enrichedEvents.map(e => e.goal_alignment)),
    };
  }, [enrichedEvents]);

  // Active task data for sidebar
  const activeTask = useMemo(() => {
    if (activeTaskIndex === null) return null;
    return timeline.tasks.find(t => t.taskIndex === activeTaskIndex) || null;
  }, [timeline.tasks, activeTaskIndex]);

  // Thread start time
  const threadStartTime = rawEvents.length > 0
    ? new Date(rawEvents[0].wall_ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  // Update URL with filters
  useEffect(() => {
    const params = new URLSearchParams();
    if (searchText) params.set('q', searchText);
    if (riskFilter !== 'all') params.set('risk', riskFilter);
    if (typeFilter !== 'all') params.set('type', typeFilter);
    if (goalFilter !== 'all') params.set('goal', goalFilter);
    setSearchParams(params, { replace: true });
  }, [searchText, riskFilter, typeFilter, goalFilter, setSearchParams]);

  // Collapse toggles
  const toggleTask = useCallback((taskIndex: number) => {
    setCollapsedTasks(prev => {
      const next = new Set(prev);
      if (next.has(taskIndex)) next.delete(taskIndex);
      else next.add(taskIndex);
      return next;
    });
  }, []);

  const toggleExchange = useCallback((key: string) => {
    setCollapsedExchanges(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleMessageExpand = useCallback((key: string) => {
    setExpandedMessages(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleResponseExpand = useCallback((key: string) => {
    setExpandedResponses(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleSidebarSection = useCallback((key: string) => {
    setCollapsedSidebarSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectedEvent = useMemo(
    () => enrichedEvents.find(e => e.event_id === selectedEventId) || null,
    [enrichedEvents, selectedEventId]
  );

  // Goal drift segments
  const goalDriftSegments = useMemo(() => {
    if (enrichedEvents.length === 0) return [];
    const segSize = Math.max(1, Math.floor(enrichedEvents.length / 50));
    const segments: Array<{ type: 'on-goal' | 'off-goal' | 'mixed'; width: number; startIdx: number; endIdx: number }> = [];
    for (let i = 0; i < enrichedEvents.length; i += segSize) {
      const chunk = enrichedEvents.slice(i, i + segSize);
      const onGoal = chunk.filter(e => e.goal_alignment.is_on_goal).length;
      const ratio = onGoal / chunk.length;
      let type: 'on-goal' | 'off-goal' | 'mixed';
      if (ratio > 0.7) type = 'on-goal';
      else if (ratio < 0.3) type = 'off-goal';
      else type = 'mixed';
      segments.push({
        type,
        width: (chunk.length / enrichedEvents.length) * 100,
        startIdx: i,
        endIdx: Math.min(i + segSize, enrichedEvents.length),
      });
    }
    return segments;
  }, [enrichedEvents]);

  const showTaskLabels = timeline.totalTasks > 1;

  if (loading) {
    return (
      <div className="waiting-state">
        <div className="waiting-icon" />
        <p>Loading events...</p>
      </div>
    );
  }

  const isRunning = !rawEvents.some(e => e.event_type === 'agent_end');

  return (
    <div className="run-detail">
      {/* Header */}
      <div className="run-detail-header">
        <button className="back-btn" onClick={() => navigate('/')}>
          ← Runs
        </button>
        <h1>
          {isRunning && <span className="status-dot running" style={{ marginRight: 8 }} />}
          {agentName}
        </h1>
        <div className="goal-text">{goal}</div>

        {/* Goal Drift Bar */}
        {goalDriftSegments.length > 0 && (
          <div className="goal-drift-bar">
            {goalDriftSegments.map((seg, i) => (
              <div
                key={i}
                className={`goal-drift-segment ${seg.type}`}
                style={{ width: `${seg.width}%` }}
                title={`Events ${seg.startIdx + 1}–${seg.endIdx}: ${seg.type}`}
              />
            ))}
          </div>
        )}

        <div className="run-detail-stats">
          <div className="stat-card">
            <div className="stat-label">On-Goal</div>
            <div className="stat-value small">{stats.goalPct}%</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Errors</div>
            <div className="stat-value small">{stats.totalErrors}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">LLM Calls</div>
            <div className="stat-value small">{stats.llmCalls}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Est. Cost</div>
            <div className="stat-value small">{formatCost(stats.totalCost)}</div>
          </div>
        </div>
      </div>

      {/* Body: Timeline + Sidebar */}
      <div className="run-detail-body">
        {/* Timeline Pane */}
        <div className="timeline-pane">
          <div className="timeline-toolbar">
            <input
              type="text"
              placeholder="Search events..."
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
            />
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
              <option value="all">All Types</option>
              <option value="agent_start">Agent Start</option>
              <option value="agent_end">Agent End</option>
              <option value="tool_call_start">Tool Start</option>
              <option value="tool_call_end">Tool End</option>
              <option value="tool_error">Tool Error</option>
              <option value="llm_call_start">LLM Start</option>
              <option value="llm_call_end">LLM End</option>
              <option value="llm_error">LLM Error</option>
              <option value="file_read">File Read</option>
              <option value="file_write">File Write</option>
              <option value="file_delete">File Delete</option>
              <option value="network_request">Net Request</option>
              <option value="network_response">Net Response</option>
              <option value="subprocess_exec">Subprocess</option>
              <option value="env_access">Env Access</option>
              <option value="loop_detected">Loop</option>
              <option value="user_prompt">User Prompt</option>
            </select>
            <select value={riskFilter} onChange={e => setRiskFilter(e.target.value)}>
              <option value="all">All Risk</option>
              <option value="safe">Safe</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
            <select value={goalFilter} onChange={e => setGoalFilter(e.target.value)}>
              <option value="all">All Goals</option>
              <option value="on">On-Goal</option>
              <option value="off">Off-Goal</option>
            </select>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)' }}>
              {filteredEvents.length} / {enrichedEvents.length}
            </span>
          </div>

          {/* Hierarchical Timeline */}
          <div className="timeline-hierarchy">
            {/* Thread Header */}
            <div className="thread-header">
              <div className="thread-header-top">
                <span className="thread-agent-name">{agentName}</span>
                <span className="thread-separator">·</span>
                <span className="thread-meta">Started {threadStartTime}</span>
                <span className="thread-separator">·</span>
                <span className="thread-meta">{timeline.totalTasks} task{timeline.totalTasks !== 1 ? 's' : ''}</span>
              </div>
              <div className="thread-summary">{goal || 'No goal specified'}</div>
            </div>

            {/* Tasks */}
            {timeline.tasks.map((task, taskArrayIdx) => (
              <TaskBlockView
                key={task.taskIndex}
                task={task}
                totalTasks={timeline.totalTasks}
                showTaskLabels={showTaskLabels}
                showDivider={taskArrayIdx > 0}
                isCollapsed={collapsedTasks.has(task.taskIndex)}
                isActive={activeTaskIndex === task.taskIndex}
                collapsedExchanges={collapsedExchanges}
                expandedMessages={expandedMessages}
                expandedResponses={expandedResponses}
                selectedEventId={selectedEventId}
                onToggleTask={toggleTask}
                onToggleExchange={toggleExchange}
                onToggleMessage={toggleMessageExpand}
                onToggleResponse={toggleResponseExpand}
                onSelectEvent={setSelectedEventId}
                onActivateTask={setActiveTaskIndex}
              />
            ))}

            {timeline.tasks.length === 0 && (
              <div style={{
                padding: 40,
                textAlign: 'center',
                fontFamily: 'var(--font-mono)',
                fontSize: 13,
                color: 'var(--text-tertiary)'
              }}>
                No events match the current filters.
              </div>
            )}
          </div>
        </div>

        {/* Context-Sensitive Sidebar */}
        <div className="insights-pane">
          {/* Task Summary (when selected) */}
          {activeTask && (
            <SidebarSection
              title={`Task ${activeTask.taskIndex} Summary`}
              sectionKey="task-summary"
              collapsed={collapsedSidebarSections.has('task-summary')}
              onToggle={toggleSidebarSection}
            >
              <div className="sidebar-metric-grid">
                <div className="sidebar-metric">
                  <span className="sidebar-metric-label">Duration</span>
                  <span className="sidebar-metric-value">{formatDuration(activeTask.durationMs)}</span>
                </div>
                <div className="sidebar-metric">
                  <span className="sidebar-metric-label">Exchanges</span>
                  <span className="sidebar-metric-value">{activeTask.exchanges.length}</span>
                </div>
                <div className="sidebar-metric">
                  <span className="sidebar-metric-label">LLM Calls</span>
                  <span className="sidebar-metric-value">{activeTask.llmCalls}</span>
                </div>
                <div className="sidebar-metric">
                  <span className="sidebar-metric-label">Tool Calls</span>
                  <span className="sidebar-metric-value">{activeTask.toolCalls}</span>
                </div>
                <div className="sidebar-metric">
                  <span className="sidebar-metric-label">Est. Cost</span>
                  <span className="sidebar-metric-value">{formatCost(activeTask.costUsd)}</span>
                </div>
                <div className="sidebar-metric">
                  <span className="sidebar-metric-label">Errors</span>
                  <span className="sidebar-metric-value">{activeTask.errorCount}</span>
                </div>
              </div>
              <button
                className="sidebar-clear-btn"
                onClick={() => setActiveTaskIndex(null)}
              >
                Show thread overview
              </button>
            </SidebarSection>
          )}

          {/* Goal Alignment */}
          <SidebarSection
            title="Goal Alignment"
            sectionKey="goal"
            collapsed={collapsedSidebarSections.has('goal')}
            onToggle={toggleSidebarSection}
          >
            <div className="sidebar-metric-row">
              <span className="sidebar-metric-label">On-Goal</span>
              <span className="sidebar-metric-value">{activeTask ? activeTask.goalAlignmentPct : stats.goalPct}%</span>
            </div>
            <div className="sidebar-metric-row">
              <span className="sidebar-metric-label">Drift</span>
              <span className="sidebar-metric-value">{stats.goalDrift.toFixed(1)}%</span>
            </div>
          </SidebarSection>

          {/* Risk Summary */}
          <SidebarSection
            title="Risk Summary"
            sectionKey="risk"
            collapsed={collapsedSidebarSections.has('risk')}
            onToggle={toggleSidebarSection}
          >
            {(() => {
              const eventsToCheck = activeTask
                ? activeTask.exchanges.flatMap(ex => ex.events)
                : enrichedEvents;
              const riskEvents = eventsToCheck.filter(e => e.risk.level !== 'safe');
              if (riskEvents.length === 0) {
                return (
                  <div className="sidebar-empty">No risks detected</div>
                );
              }
              return ['critical', 'high', 'medium', 'low'].map(level => {
                const count = riskEvents.filter(e => e.risk.level === level).length;
                if (count === 0) return null;
                return (
                  <div key={level} className="sidebar-metric-row">
                    <span className={`risk-badge ${level}`}>{level}</span>
                    <span className="sidebar-metric-value">{count}</span>
                  </div>
                );
              });
            })()}
          </SidebarSection>

          {/* Cost Breakdown */}
          <SidebarSection
            title="Cost Breakdown"
            sectionKey="cost"
            collapsed={collapsedSidebarSections.has('cost')}
            onToggle={toggleSidebarSection}
          >
            <div className="sidebar-metric-row">
              <span className="sidebar-metric-label">Total Cost</span>
              <span className="sidebar-metric-value">{formatCost(activeTask ? activeTask.costUsd : stats.totalCost)}</span>
            </div>
            <div className="sidebar-metric-row">
              <span className="sidebar-metric-label">LLM Calls</span>
              <span className="sidebar-metric-value">{activeTask ? activeTask.llmCalls : stats.llmCalls}</span>
            </div>
            <div className="sidebar-metric-row">
              <span className="sidebar-metric-label">Tool Calls</span>
              <span className="sidebar-metric-value">{activeTask ? activeTask.toolCalls : stats.toolCalls}</span>
            </div>
          </SidebarSection>

          {/* Hallucination Report */}
          <SidebarSection
            title="Hallucination Report"
            sectionKey="hallucination"
            collapsed={collapsedSidebarSections.has('hallucination')}
            onToggle={toggleSidebarSection}
          >
            <HallucinationSection reports={hallucinationReports} isRunning={isRunning} />
          </SidebarSection>
        </div>
      </div>

      {/* Event Inspector Drawer */}
      {selectedEvent && (
        <div className="inspector-drawer">
          <div className="inspector-drawer-header">
            <h3>{selectedEvent.event_type}</h3>
            <button onClick={() => setSelectedEventId(null)}>✕</button>
          </div>
          <div className="inspector-drawer-body">
            {selectedEvent.risk.rules.length > 0 && (
              <div className="inspector-section">
                <div className="inspector-section-title">Risk Rules</div>
                <div className="inspector-risk-rules">
                  {selectedEvent.risk.rules.map((rule, i) => (
                    <div key={i} className={`risk-rule-item ${rule.level}`}>
                      <div className="rule-name">{rule.name}</div>
                      <div className="rule-explanation">{rule.explanation}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="inspector-section">
              <div className="inspector-section-title">Goal Alignment</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
                Score: {selectedEvent.goal_alignment.score}/100
                {selectedEvent.goal_alignment.is_on_goal ? ' · On-Goal' : ' · Off-Goal'}
              </div>
              {selectedEvent.goal_alignment.matched_tokens.length > 0 && (
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                  Matched: {selectedEvent.goal_alignment.matched_tokens.join(', ')}
                </div>
              )}
            </div>
            {selectedEvent.error_traceback && (
              <div className="inspector-section">
                <div className="inspector-section-title">Error Traceback</div>
                <pre className="inspector-json">{selectedEvent.error_traceback}</pre>
              </div>
            )}
            <div className="inspector-section">
              <div className="inspector-section-title">Raw Event</div>
              <pre className="inspector-json">
                {JSON.stringify(selectedEvent, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sidebar Section Component ───────────────────────────────────

function SidebarSection({
  title,
  sectionKey,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  sectionKey: string;
  collapsed: boolean;
  onToggle: (key: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="sidebar-section">
      <button
        className="sidebar-section-header"
        onClick={() => onToggle(sectionKey)}
      >
        <span className="sidebar-section-title">{title}</span>
        <span className={`collapse-chevron ${collapsed ? 'collapsed' : ''}`}>▾</span>
      </button>
      {!collapsed && (
        <div className="sidebar-section-body">
          {children}
        </div>
      )}
    </div>
  );
}

// ── Task Block Component ────────────────────────────────────────

function TaskBlockView({
  task,
  totalTasks,
  showTaskLabels,
  showDivider,
  isCollapsed,
  isActive,
  collapsedExchanges,
  expandedMessages,
  expandedResponses,
  selectedEventId,
  onToggleTask,
  onToggleExchange,
  onToggleMessage,
  onToggleResponse,
  onSelectEvent,
  onActivateTask,
}: {
  task: TaskBlock;
  totalTasks: number;
  showTaskLabels: boolean;
  showDivider: boolean;
  isCollapsed: boolean;
  isActive: boolean;
  collapsedExchanges: Set<string>;
  expandedMessages: Set<string>;
  expandedResponses: Set<string>;
  selectedEventId: string | null;
  onToggleTask: (idx: number) => void;
  onToggleExchange: (key: string) => void;
  onToggleMessage: (key: string) => void;
  onToggleResponse: (key: string) => void;
  onSelectEvent: (id: string | null) => void;
  onActivateTask: (idx: number) => void;
}) {
  const showExchangeLabels = task.exchanges.length > 1;

  const handleHeaderClick = () => {
    onToggleTask(task.taskIndex);
    onActivateTask(task.taskIndex);
  };

  return (
    <>
      {/* Task Divider */}
      {showDivider && (
        <div className="task-divider-v2">
          <div className="task-divider-rule" />
          <span className="task-divider-label-v2">
            New Task · {formatGap(task.gapFromPreviousMs)} later
          </span>
          <div className="task-divider-rule" />
        </div>
      )}

      {/* Task Block */}
      <div className={`task-block-v2 status-${task.status}${isActive ? ' active' : ''}`}>
        {/* Task Header — simplified: status dot, task index, opening prompt, duration + exchange count */}
        <div className="task-block-header-v2" onClick={handleHeaderClick}>
          <div className="task-header-left">
            <span className={`task-status-dot ${task.status}`} />
            {showTaskLabels && (
              <span className="task-index-label-v2">
                Task {task.taskIndex} of {totalTasks}
              </span>
            )}
          </div>
          <div className="task-header-center">
            <div className="task-opening-prompt-v2">{task.openingPrompt}</div>
            <div className="task-header-subtitle">
              {formatDuration(task.durationMs)}
              {task.exchanges.length > 1 && (
                <> · {task.exchanges.length} exchanges</>
              )}
            </div>
          </div>
          <span className={`collapse-chevron ${isCollapsed ? 'collapsed' : ''}`}>▾</span>
        </div>

        {/* Task Body — Exchanges */}
        {!isCollapsed && (
          <div className="task-block-body">
            {task.exchanges.map(exchange => {
              const exchangeKey = `${task.taskIndex}-${exchange.exchangeIndex}`;
              const isExchangeCollapsed = collapsedExchanges.has(exchangeKey);

              return (
                <ExchangeBlockView
                  key={exchangeKey}
                  exchange={exchange}
                  showExchangeLabels={showExchangeLabels}
                  totalExchanges={task.exchanges.length}
                  isCollapsed={isExchangeCollapsed}
                  isMessageExpanded={expandedMessages.has(exchangeKey)}
                  isResponseExpanded={expandedResponses.has(exchangeKey)}
                  selectedEventId={selectedEventId}
                  onToggle={() => onToggleExchange(exchangeKey)}
                  onToggleMessage={() => onToggleMessage(exchangeKey)}
                  onToggleResponse={() => onToggleResponse(exchangeKey)}
                  onSelectEvent={onSelectEvent}
                />
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

// ── Exchange Block Component ────────────────────────────────────

function ExchangeBlockView({
  exchange,
  showExchangeLabels,
  totalExchanges,
  isCollapsed,
  isMessageExpanded,
  isResponseExpanded,
  selectedEventId,
  onToggle,
  onToggleMessage,
  onToggleResponse,
  onSelectEvent,
}: {
  exchange: ExchangeBlock;
  showExchangeLabels: boolean;
  totalExchanges: number;
  isCollapsed: boolean;
  isMessageExpanded: boolean;
  isResponseExpanded: boolean;
  selectedEventId: string | null;
  onToggle: () => void;
  onToggleMessage: () => void;
  onToggleResponse: () => void;
  onSelectEvent: (id: string | null) => void;
}) {
  const isLongMessage = exchange.userMessage.length > 200;
  const isLongResponse = (exchange.agentResponse?.length || 0) > 200;

  return (
    <div className="exchange-block-v2">
      {/* Exchange Header — User Message */}
      <div className="exchange-header-v2" onClick={onToggle}>
        <div className="exchange-user-icon-v2">👤</div>
        <div className="exchange-header-content-v2">
          <div
            className={`exchange-user-message-v2 ${isLongMessage && !isMessageExpanded ? 'truncated' : ''}`}
            onClick={(e) => { if (isLongMessage) { e.stopPropagation(); onToggleMessage(); } }}
          >
            {exchange.userMessage}
          </div>
          {isLongMessage && (
            <button
              className="exchange-expand-btn"
              onClick={(e) => { e.stopPropagation(); onToggleMessage(); }}
            >
              {isMessageExpanded ? 'show less' : 'show more'}
            </button>
          )}
        </div>
        <div className="exchange-header-right">
          {showExchangeLabels && (
            <span
              className="exchange-index-chip-v2"
              title={`Exchange ${exchange.exchangeIndex} of ${totalExchanges}`}
            >
              {exchange.exchangeIndex}/{totalExchanges}
            </span>
          )}
          <span className="exchange-timestamp-v2">{formatOffset(exchange.userMessageOffsetMs)}</span>
          <span className={`collapse-chevron ${isCollapsed ? 'collapsed' : ''}`}>▾</span>
        </div>
      </div>

      {/* Exchange Body */}
      {!isCollapsed ? (
        <>
          {/* Event Rows — legacy color-coded visualization */}
          <div className="exchange-events-v2">
            {exchange.events.map(event => (
              <div
                key={event.event_id}
                className={`event-row ${selectedEventId === event.event_id ? 'selected' : ''}`}
                onClick={() => onSelectEvent(
                  selectedEventId === event.event_id ? null : event.event_id
                )}
              >
                <div className={`event-border ${event.event_type}`} />
                <span className="event-type-label">{event.event_type.toUpperCase()}</span>
                <span className="event-description">{event.description}</span>
                <span className="event-timestamp">{formatOffset(event.run_offset_ms)}</span>
              </div>
            ))}
          </div>

          {/* Agent Response Footer */}
          {exchange.agentResponse ? (
            <div className="exchange-agent-response-v2">
              <div className="exchange-agent-icon-v2">🤖</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  className={`exchange-agent-text-v2 ${isLongResponse && !isResponseExpanded ? 'truncated' : ''}`}
                  style={{ cursor: isLongResponse ? 'pointer' : 'default' }}
                  onClick={() => { if (isLongResponse) onToggleResponse(); }}
                >
                  {exchange.agentResponse}
                </div>
                {isLongResponse && (
                  <button
                    className="exchange-expand-btn"
                    style={{ color: 'var(--color-agent-response)' }}
                    onClick={() => onToggleResponse()}
                  >
                    {isResponseExpanded ? 'show less' : 'show more'}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="exchange-no-response-v2">No response sent</div>
          )}
        </>
      ) : (
        <div className="exchange-collapsed-info-v2">
          {exchange.events.length} events · {formatDuration(exchange.durationMs)}
        </div>
      )}
    </div>
  );
}

// ── Hallucination Section Component ─────────────────────────────

function HallucinationSection({
  reports,
  isRunning,
}: {
  reports: HallucinationReport[];
  isRunning: boolean;
}) {
  const [showVerified, setShowVerified] = useState(false);

  if (reports.length === 0) {
    return (
      <div className="sidebar-empty">
        {isRunning ? 'No completion claims detected yet.' : 'No LLM calls to analyze.'}
      </div>
    );
  }

  const allClaims = reports.flatMap(r => r.claims);
  const flagged = allClaims.filter(c => c.verdict !== 'supported');
  const verified = allClaims.filter(c => c.verdict === 'supported');
  const hasIssues = flagged.length > 0;
  const highConfidence = flagged.some(c => c.confidence === 'high');

  if (!hasIssues && !isRunning) {
    return (
      <div className="hallucination-header clean">
        All completion claims verified.
      </div>
    );
  }

  return (
    <div>
      {hasIssues && (
        <div className={`hallucination-header ${highConfidence ? 'danger' : 'warning'}`}>
          {flagged.length} unverified claim{flagged.length > 1 ? 's' : ''}
        </div>
      )}

      {flagged.map((claim, i) => (
        <div key={i} className={`hallucination-claim ${claim.verdict}`}>
          <div className="claim-sentence">"{claim.sentence}"</div>
          <div className={`claim-verdict ${claim.verdict}`}>{claim.verdict}</div>
          <div className="claim-explanation">{claim.explanation}</div>
          <div className="claim-confidence">Confidence: {claim.confidence}</div>
        </div>
      ))}

      {verified.length > 0 && (
        <div className="accordion" style={{ marginTop: 8 }}>
          <button className="accordion-trigger" onClick={() => setShowVerified(!showVerified)}>
            <span>Verified claims ({verified.length})</span>
            <span>{showVerified ? '▾' : '▸'}</span>
          </button>
          {showVerified && (
            <div className="accordion-content">
              {verified.map((claim, i) => (
                <div key={i} className="hallucination-claim supported">
                  <div className="claim-sentence">"{claim.sentence}"</div>
                  <div className="claim-verdict supported">supported</div>
                  <div className="claim-explanation">{claim.explanation}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
