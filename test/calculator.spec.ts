import assert from "node:assert/strict";
import { evaluateExpression } from "../src/mcp/calculatorTool";

describe("calculator", () => {
  it("follows operator precedence and associativity", () => {
    assert.equal(evaluateExpression("2 + 3 * 4"), 14);
    assert.equal(evaluateExpression("(2 + 3) * 4"), 20);
    assert.equal(evaluateExpression("2 ^ 3 ^ 2"), 512);
    assert.equal(evaluateExpression("-2 ^ 2"), -4);
    assert.equal(evaluateExpression("10 % 4"), 2);
    assert.equal(evaluateExpression("1.5e3 / 3"), 500);
  });

  it("supports the documented functions", () => {
    assert.equal(evaluateExpression("sqrt(16) + abs(-2)"), 6);
    assert.equal(evaluateExpression("round(2 / 3, 2)"), 0.67);
    assert.equal(evaluateExpression("max(1, 7, 3) - min(4, 2)"), 5);
    assert.equal(evaluateExpression("round(ln(exp(2)), 6)"), 2);
    assert.equal(evaluateExpression("log10(1000)"), 3);
  });

  it("rejects anything that is not arithmetic", () => {
    assert.throws(() => evaluateExpression("1 / 0"));
    assert.throws(() => evaluateExpression("process.exit(1)"));
    assert.throws(() => evaluateExpression("foo(2)"));
    assert.throws(() => evaluateExpression("2 +"));
    assert.throws(() => evaluateExpression("sqrt(-1)"));
  });
});
