import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { ClawEvent } from '../lib/types';
import { fetchRunEvents } from '../lib/api';
import { estimateCost, formatCost } from '../lib/cost';

interface LLMCallData {
  event_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  duration_ms: number;
  offset_ms: number;
}

export default function CostDashboard() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const [rawEvents, setRawEvents] = useState<ClawEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!runId) return;
    fetchRunEvents(runId)
      .then(events => {
        setRawEvents(events);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [runId]);

  const llmCalls = useMemo<LLMCallData[]>(() => {
    return rawEvents
      .filter(e => e.event_type === 'llm_call_end')
      .map(e => ({
        event_id: e.event_id,
        model: e.model || 'unknown',
        input_tokens: e.input_tokens || 0,
        output_tokens: e.output_tokens || 0,
        cost: estimateCost(e.model || '', e.input_tokens || 0, e.output_tokens || 0),
        duration_ms: e.duration_ms || 0,
        offset_ms: e.run_offset_ms,
      }));
  }, [rawEvents]);

  const stats = useMemo(() => {
    const totalCost = llmCalls.reduce((s, c) => s + c.cost, 0);
    const totalInput = llmCalls.reduce((s, c) => s + c.input_tokens, 0);
    const totalOutput = llmCalls.reduce((s, c) => s + c.output_tokens, 0);
    const totalDuration = llmCalls.reduce((s, c) => s + c.duration_ms, 0);

    // Model breakdown
    const modelMap = new Map<string, { count: number; cost: number; inputTokens: number; outputTokens: number }>();
    for (const call of llmCalls) {
      const entry = modelMap.get(call.model) || { count: 0, cost: 0, inputTokens: 0, outputTokens: 0 };
      entry.count++;
      entry.cost += call.cost;
      entry.inputTokens += call.input_tokens;
      entry.outputTokens += call.output_tokens;
      modelMap.set(call.model, entry);
    }

    // Projected cost
    const runDuration = rawEvents.length > 0
      ? (rawEvents[rawEvents.length - 1].run_offset_ms / 1000)
      : 0;
    const costRate = runDuration > 0 ? totalCost / runDuration : 0;
    const isRunning = !rawEvents.some(e => e.event_type === 'agent_end');

    return {
      totalCost,
      totalInput,
      totalOutput,
      totalDuration,
      modelBreakdown: Array.from(modelMap.entries()).sort((a, b) => b[1].cost - a[1].cost),
      costRate,
      isRunning,
    };
  }, [llmCalls, rawEvents]);

  // Cost over time chart (simple bar chart)
  const costBars = useMemo(() => {
    if (llmCalls.length === 0) return [];
    const maxCost = Math.max(...llmCalls.map(c => c.cost), 0.0001);
    return llmCalls.map(call => ({
      ...call,
      pct: (call.cost / maxCost) * 100,
    }));
  }, [llmCalls]);

  if (loading) {
    return (
      <div className="waiting-state">
        <div className="waiting-icon" />
        <p>Loading cost data...</p>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <button className="back-btn" onClick={() => navigate(`/run/${runId}`)}>
          ← Back to Run
        </button>
        <h1>Cost Dashboard</h1>
        <p>{llmCalls.length} LLM call{llmCalls.length !== 1 ? 's' : ''}</p>
      </div>

      {/* Summary Stats */}
      <div className="cost-grid">
        <div className="stat-card">
          <div className="stat-label">Total Cost</div>
          <div className="stat-value">{formatCost(stats.totalCost)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Input Tokens</div>
          <div className="stat-value small">{stats.totalInput.toLocaleString()}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Output Tokens</div>
          <div className="stat-value small">{stats.totalOutput.toLocaleString()}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total LLM Time</div>
          <div className="stat-value small">{(stats.totalDuration / 1000).toFixed(1)}s</div>
        </div>
        {stats.isRunning && (
          <div className="stat-card">
            <div className="stat-label">Projected Cost/Min</div>
            <div className="stat-value small">{formatCost(stats.costRate * 60)}</div>
          </div>
        )}
      </div>

      {/* Model Breakdown */}
      <div className="insights-section">
        <div className="insights-section-title">Model Breakdown</div>
        {stats.modelBreakdown.map(([model, data]) => (
          <div key={model} style={{ marginBottom: 12, background: 'var(--bg-hover)', borderRadius: 'var(--radius-md)', padding: '10px 14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--color-llm)' }}>
                {model}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-primary)' }}>
                {formatCost(data.cost)}
              </span>
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)' }}>
              {data.count} call{data.count > 1 ? 's' : ''} · {data.inputTokens.toLocaleString()} in · {data.outputTokens.toLocaleString()} out
            </div>
          </div>
        ))}
      </div>

      {/* Cost Over Time (simple bar chart) */}
      <div className="insights-section">
        <div className="insights-section-title">Cost Per Call</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 120, marginTop: 8 }}>
          {costBars.map((bar, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                maxWidth: 20,
                height: `${Math.max(2, bar.pct)}%`,
                background: 'var(--color-llm)',
                borderRadius: '2px 2px 0 0',
                opacity: 0.7,
                transition: 'opacity 0.15s',
                cursor: 'pointer',
              }}
              title={`${bar.model}: ${formatCost(bar.cost)} (${bar.input_tokens + bar.output_tokens} tokens)`}
              onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '0.7')}
            />
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-tertiary)' }}>
          <span>First call</span>
          <span>Last call</span>
        </div>
      </div>

      {/* Token Distribution */}
      <div className="insights-section">
        <div className="insights-section-title">Token Distribution</div>
        <div style={{ display: 'flex', height: 20, borderRadius: 'var(--radius-sm)', overflow: 'hidden', marginTop: 8 }}>
          <div
            style={{
              width: `${stats.totalInput + stats.totalOutput > 0 ? (stats.totalInput / (stats.totalInput + stats.totalOutput)) * 100 : 50}%`,
              background: 'var(--color-llm)',
              opacity: 0.7,
            }}
          />
          <div
            style={{
              flex: 1,
              background: 'var(--color-live)',
              opacity: 0.7,
            }}
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-tertiary)' }}>
          <span>Input: {stats.totalInput.toLocaleString()}</span>
          <span>Output: {stats.totalOutput.toLocaleString()}</span>
        </div>
      </div>
    </div>
  );
}
