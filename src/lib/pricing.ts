// Anthropic list prices in USD per million tokens (claude-api skill, shared/models.md and
// shared/prompt-caching.md, read 2026-10-30). Update them here when the price list changes.
interface Rates {
  input: number;
  output: number;
  cacheRead: number;
}

interface ModelPrice extends Rates {
  // Haiku 5.5 bills the whole request at higher rates when the prompt is above this size
  longPrompt?: Rates & { aboveTokens: number };
}

const PRICES: Record<string, ModelPrice> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  // The price list gives no cache read rate for Haiku 5.5: the generic 0.1x of input is an estimate
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    longPrompt: { aboveTokens: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 },
  },
};

const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const WEB_SEARCH_USD = 10 / 1_000;

export interface BilledUsage {
  // Whole prompt, cache reads and writes included
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  webSearches: number;
  // Requests behind the usage: tool loops sum several prompts
  steps: number;
}

export function hasPrice(model: string): boolean {
  return model in PRICES;
}

/** Estimated cost of one call; 0 for models without a price (the budget refuses to start with them). */
export function costUsd(model: string, usage: BilledUsage): number {
  const price = PRICES[model];
  if (!price) return 0;
  const promptPerStep = usage.inputTokens / Math.max(usage.steps, 1);
  const rates = price.longPrompt && promptPerStep > price.longPrompt.aboveTokens ? price.longPrompt : price;
  const uncached = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWrite5mTokens - usage.cacheWrite1hTokens);
  const tokens =
    uncached * rates.input +
    usage.cacheReadTokens * rates.cacheRead +
    usage.cacheWrite5mTokens * rates.input * CACHE_WRITE_5M +
    usage.cacheWrite1hTokens * rates.input * CACHE_WRITE_1H +
    usage.outputTokens * rates.output;
  return tokens / 1_000_000 + usage.webSearches * WEB_SEARCH_USD;
}
