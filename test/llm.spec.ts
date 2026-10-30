import assert from "node:assert/strict";
import { transientRetryDelay } from "../src/lib/llm";

describe("llm retry policy", () => {
  it("backs off only on rate limits and overloads", () => {
    assert.ok((transientRetryDelay({ statusCode: 429 }, 0) ?? 0) >= 2_000);
    assert.ok((transientRetryDelay({ statusCode: 529 }, 1) ?? 0) >= 4_000);
    assert.ok(transientRetryDelay(new Error("wrapped", { cause: { message: "Overloaded" } }), 0));
    assert.equal(transientRetryDelay({ statusCode: 400, message: "invalid request" }, 0), null);
    assert.equal(transientRetryDelay(new Error("schema mismatch"), 0), null);
  });

  it("honours retry-after with a cap and gives up after the budget", () => {
    assert.equal(transientRetryDelay({ statusCode: 429, responseHeaders: { "retry-after": "3" } }, 0), 3_000);
    assert.equal(transientRetryDelay({ statusCode: 429, responseHeaders: { "retry-after": "600" } }, 0), 60_000);
    assert.equal(transientRetryDelay({ statusCode: 429 }, 4), null);
  });
});
