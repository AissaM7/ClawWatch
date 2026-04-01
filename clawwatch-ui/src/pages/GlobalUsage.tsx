// ── Global Usage / Cost Dashboard ────────────────────────────────
// Cross-run cost and token usage aggregation.

import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Run } from '../lib/types';
import { fetchRuns, fetchRunEvents } from '../lib/api';
import { estimateCost, formatCost } from '../lib/cost';
import {
    DollarSign, ArrowRight,
} from 'lucide-react';

interface RunCostData {
    run: Run;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    llmCalls: number;
    models: string[];
}

export default function GlobalUsage() {
    const navigate = useNavigate();
    const [loading, setLoading] = useState(true);
    const [runCosts, setRunCosts] = useState<RunCostData[]>([]);

    useEffect(() => {
        const load = async () => {
            try {
                const runs = await fetchRuns();
                const recentRuns = [...runs].sort((a, b) => b.started_at - a.started_at).slice(0, 30);

                const costs = await Promise.all(recentRuns.map(async (run) => {
                    try {
                        const events = await fetchRunEvents(run.run_id);
                        const llmEnds = events.filter(e => e.event_type === 'llm_call_end');
                        let cost = 0, inputTokens = 0, outputTokens = 0;
                        const modelSet = new Set<string>();
                        for (const e of llmEnds) {
                            const inT = e.input_tokens || 0;
                            const outT = e.output_tokens || 0;
                            inputTokens += inT;
                            outputTokens += outT;
                            cost += estimateCost(e.model || '', inT, outT);
                            if (e.model) modelSet.add(e.model);
                        }
                        return {
                            run, cost, inputTokens, outputTokens,
                            llmCalls: llmEnds.length,
                            models: [...modelSet],
                        };
                    } catch {
                        return { run, cost: 0, inputTokens: 0, outputTokens: 0, llmCalls: 0, models: [] };
                    }
                }));

                setRunCosts(costs);
            } catch { /* skip */ }
            finally { setLoading(false); }
        };
        load();
    }, []);

    const agg = useMemo(() => {
        const totalCost = runCosts.reduce((s, r) => s + r.cost, 0);
        const totalInput = runCosts.reduce((s, r) => s + r.inputTokens, 0);
        const totalOutput = runCosts.reduce((s, r) => s + r.outputTokens, 0);
        const totalLlmCalls = runCosts.reduce((s, r) => s + r.llmCalls, 0);
        const allModels = [...new Set(runCosts.flatMap(r => r.models))];

        // Per-agent breakdown
        const agentMap = new Map<string, { cost: number; runs: number; llmCalls: number }>();
        for (const rc of runCosts) {
            const entry = agentMap.get(rc.run.agent_name) || { cost: 0, runs: 0, llmCalls: 0 };
            entry.cost += rc.cost;
            entry.runs++;
            entry.llmCalls += rc.llmCalls;
            agentMap.set(rc.run.agent_name, entry);
        }

        // Per-model breakdown
        const modelCostMap = new Map<string, { cost: number; calls: number }>();
        for (const rc of runCosts) {
            // We don't have per-model cost per run, so approximate
            for (const m of rc.models) {
                const entry = modelCostMap.get(m) || { cost: 0, calls: 0 };
                entry.cost += rc.cost / (rc.models.length || 1);
                entry.calls += Math.ceil(rc.llmCalls / (rc.models.length || 1));
                modelCostMap.set(m, entry);
            }
        }

        return {
            totalCost, totalInput, totalOutput, totalLlmCalls, allModels,
            agentBreakdown: [...agentMap.entries()].sort((a, b) => b[1].cost - a[1].cost),
            modelBreakdown: [...modelCostMap.entries()].sort((a, b) => b[1].cost - a[1].cost),
        };
    }, [runCosts]);

    // Cost bars for chart
    const costBars = useMemo(() => {
        const sorted = [...runCosts].sort((a, b) => a.run.started_at - b.run.started_at);
        const max = Math.max(...sorted.map(r => r.cost), 0.0001);
        return sorted.map(r => ({ ...r, pct: (r.cost / max) * 100 }));
    }, [runCosts]);

    if (loading) {
        return (
            <div className="waiting-state">
                <div className="waiting-icon" />
                <p>Calculating usage…</p>
            </div>
        );
    }

    return (
        <div className="global-page">
            <div className="global-page-header">
                <h1><DollarSign size={24} /> Usage & Cost</h1>
                <p>{runCosts.length} runs analyzed</p>
            </div>

            {/* KPI Row */}
            <div className="global-kpis">
                <div className="global-kpi global-kpi--gold">
                    <div className="global-kpi-value">{formatCost(agg.totalCost)}</div>
                    <div className="global-kpi-label">Total Cost</div>
                </div>
                <div className="global-kpi global-kpi--purple">
                    <div className="global-kpi-value">{agg.totalLlmCalls}</div>
                    <div className="global-kpi-label">LLM Calls</div>
                </div>
                <div className="global-kpi global-kpi--blue">
                    <div className="global-kpi-value">{(agg.totalInput / 1000).toFixed(1)}k</div>
                    <div className="global-kpi-label">Input Tokens</div>
                </div>
                <div className="global-kpi global-kpi--cyan">
                    <div className="global-kpi-value">{(agg.totalOutput / 1000).toFixed(1)}k</div>
                    <div className="global-kpi-label">Output Tokens</div>
                </div>
                <div className="global-kpi global-kpi--emerald">
                    <div className="global-kpi-value">{agg.allModels.length}</div>
                    <div className="global-kpi-label">Models</div>
                </div>
            </div>

            {/* Cost Over Time */}
            {costBars.length > 0 && (
                <div className="global-section">
                    <div className="global-section-title">Cost Per Run</div>
                    <div className="global-cost-chart">
                        {costBars.map((bar, i) => (
                            <div
                                key={i}
                                className="global-cost-bar"
                                style={{ height: `${Math.max(4, bar.pct)}%` }}
                                title={`${bar.run.agent_name}: ${formatCost(bar.cost)}`}
                                onClick={() => navigate(`/run/${bar.run.run_id}`)}
                            />
                        ))}
                    </div>
                </div>
            )}

            <div className="global-two-col">
                {/* Agent Cost Breakdown */}
                <div className="global-section">
                    <div className="global-section-title">Cost by Agent</div>
                    <div className="global-breakdown-list">
                        {agg.agentBreakdown.map(([agent, data]) => (
                            <div
                                key={agent}
                                className="global-breakdown-row"
                                onClick={() => navigate(`/agent/${encodeURIComponent(agent)}`)}
                            >
                                <span className="global-breakdown-name">{agent}</span>
                                <span className="global-breakdown-detail">
                                    {data.runs} run{data.runs !== 1 ? 's' : ''} · {data.llmCalls} LLM calls
                                </span>
                                <span className="global-breakdown-cost">{formatCost(data.cost)}</span>
                                <ArrowRight size={12} className="global-breakdown-arrow" />
                            </div>
                        ))}
                    </div>
                </div>

                {/* Model Cost Breakdown */}
                <div className="global-section">
                    <div className="global-section-title">Cost by Model</div>
                    <div className="global-breakdown-list">
                        {agg.modelBreakdown.map(([model, data]) => (
                            <div key={model} className="global-breakdown-row global-breakdown-row--static">
                                <span className="global-breakdown-name">{model}</span>
                                <span className="global-breakdown-detail">
                                    ~{data.calls} call{data.calls !== 1 ? 's' : ''}
                                </span>
                                <span className="global-breakdown-cost">{formatCost(data.cost)}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* Token Distribution */}
            <div className="global-section">
                <div className="global-section-title">Token Distribution</div>
                <div className="global-token-bar">
                    <div
                        className="global-token-seg global-token-seg--input"
                        style={{ width: `${agg.totalInput + agg.totalOutput > 0 ? (agg.totalInput / (agg.totalInput + agg.totalOutput)) * 100 : 50}%` }}
                    />
                    <div className="global-token-seg global-token-seg--output" style={{ flex: 1 }} />
                </div>
                <div className="global-token-legend">
                    <span>Input: {agg.totalInput.toLocaleString()}</span>
                    <span>Output: {agg.totalOutput.toLocaleString()}</span>
                </div>
            </div>
        </div>
    );
}
