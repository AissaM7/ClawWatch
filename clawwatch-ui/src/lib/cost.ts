// ── LLM Cost Estimation ──────────────────────────────────────────

// Default pricing per million tokens
const DEFAULT_PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-5': { input: 15.0, output: 75.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
  'claude-3-opus': { input: 15.0, output: 75.0 },
  'claude-3-sonnet': { input: 3.0, output: 15.0 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  'gpt-4': { input: 30.0, output: 60.0 },
  'gpt-4-turbo': { input: 10.0, output: 30.0 },
  'gpt-4o': { input: 5.0, output: 15.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
  'gemini-1.5-pro': { input: 3.5, output: 10.5 },
  'gemini-1.5-flash': { input: 0.35, output: 1.05 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
};

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  // Find best match for model name
  const modelLower = model.toLowerCase();
  let pricing = DEFAULT_PRICING[model];
  if (!pricing) {
    for (const [key, val] of Object.entries(DEFAULT_PRICING)) {
      if (modelLower.includes(key) || key.includes(modelLower)) {
        pricing = val;
        break;
      }
    }
  }

  if (!pricing) {
    // Default fallback
    pricing = { input: 5.0, output: 15.0 };
  }

  return (inputTokens / 1_000_000) * pricing.input +
         (outputTokens / 1_000_000) * pricing.output;
}

export function formatCost(cost: number): string {
  if (cost < 0.01) return `$${(cost * 100).toFixed(2)}¢`;
  if (cost < 1) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}
