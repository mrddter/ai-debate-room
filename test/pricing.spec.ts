import assert from "node:assert/strict";
import { costUsd, hasPrice, type BilledUsage } from "../src/lib/pricing";

const usage = (overrides: Partial<BilledUsage>): BilledUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  webSearches: 0,
  steps: 1,
  ...overrides,
});

const usd = (value: number) => value.toFixed(6);

describe("pricing", () => {
  it("prices each input slice at its own rate", () => {
    // Opus 5.5: 1M uncached x 4 + 1M read x 0.2 + 1M 5m write x 5 + 1M 1h write x 8 + 1M out x 20
    const opus = usage({
      inputTokens: 4_000_000,
      cacheReadTokens: 1_000_000,
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    assert.equal(usd(costUsd("claude-opus-5-5", opus)), usd(4 + 0.2 + 5 + 8 + 20));
    assert.equal(usd(costUsd("claude-sonnet-5-5", usage({ inputTokens: 1_000_000, webSearches: 3 }))), usd(2 + 0.03));
  });

  it("bills Haiku long prompts at the higher tier, judged per request", () => {
    const short = usage({ inputTokens: 100_000, outputTokens: 1_000_000 });
    assert.equal(usd(costUsd("claude-haiku-5-5", short)), usd(0.01 + 0.5));
    const long = usage({ inputTokens: 100_001, outputTokens: 1_000_000 });
    assert.equal(usd(costUsd("claude-haiku-5-5", long)), usd(0.0500005 + 2.5));
    // Two steps of 60K each: every request stays under the threshold
    const loop = usage({ inputTokens: 120_000, steps: 2 });
    assert.equal(usd(costUsd("claude-haiku-5-5", loop)), usd(0.012));
  });

  it("knows which models it cannot price", () => {
    assert.equal(hasPrice("claude-opus-5-5"), true);
    assert.equal(hasPrice("mistral-large-latest"), false);
    assert.equal(costUsd("mistral-large-latest", usage({ inputTokens: 1_000_000 })), 0);
  });
});
