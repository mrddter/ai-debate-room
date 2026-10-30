import assert from "node:assert/strict";
import { toInput, transientRetryDelay } from "../src/lib/llm";

describe("llm prompt chain", () => {
  const cachedIndexes = (blocks: number) => {
    const [message] = toInput({ blocks: Array.from({ length: blocks }, (_, index) => `b${index}`), tail: "coda" }, "!") as any[];
    return {
      cached: message.content.flatMap((part: any, index: number) => (part.providerOptions ? [index] : [])),
      tail: message.content.at(-1),
    };
  };

  it("caches the last block and a fixed checkpoint every ten, never the tail", () => {
    assert.deepEqual(cachedIndexes(1).cached, [0]);
    assert.deepEqual(cachedIndexes(10).cached, [0, 9]);
    assert.deepEqual(cachedIndexes(11).cached, [10]);
    assert.deepEqual(cachedIndexes(25).cached, [20, 24]);
    assert.deepEqual(cachedIndexes(25).tail, { type: "text", text: "coda!" });
  });

  it("leaves plain prompts alone", () => {
    assert.equal(toInput("ciao", "!"), "ciao!");
  });
});

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
