import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: (value, digits = 0) => Math.round(value * 10 ** digits) / 10 ** digits,
  min: Math.min,
  max: Math.max,
  ln: Math.log,
  log10: Math.log10,
  exp: Math.exp,
};

/**
 * Deterministic arithmetic: + - * / ^ %, parentheses, unary minus and the FUNCTIONS above.
 * Recursive descent on purpose: model input never reaches eval or Function.
 */
export function evaluateExpression(expression: string): number {
  const tokens = expression.match(/\d+(?:\.\d+)?(?:e[+-]?\d+)?|[a-z_][a-z0-9_]*|[-+*/^%(),]/gi) ?? [];
  if (tokens.join("") !== expression.replace(/\s+/g, "")) throw new Error("Unsupported characters in expression");
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (expected?: string) => {
    const token = tokens[pos++];
    if (expected !== undefined && token !== expected) throw new Error(`Expected "${expected}" but found "${token ?? "end"}"`);
    return token;
  };

  const parseExpression = (): number => {
    let value = parseTerm();
    while (peek() === "+" || peek() === "-") value = take() === "+" ? value + parseTerm() : value - parseTerm();
    return value;
  };
  const parseTerm = (): number => {
    let value = parseUnary();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = take();
      const right = parseUnary();
      if ((op === "/" || op === "%") && right === 0) throw new Error("Division by zero");
      value = op === "*" ? value * right : op === "/" ? value / right : value % right;
    }
    return value;
  };
  const parseUnary = (): number => {
    if (peek() === "-") {
      take();
      return -parseUnary();
    }
    if (peek() === "+") {
      take();
      return parseUnary();
    }
    return parsePower();
  };
  // Right associative and binds tighter than unary minus on its left: -2^2 = -4
  const parsePower = (): number => {
    const base = parsePrimary();
    if (peek() === "^") {
      take();
      return base ** parseUnary();
    }
    return base;
  };
  const parsePrimary = (): number => {
    const token = take();
    if (token === undefined) throw new Error("Unexpected end of expression");
    if (token === "(") {
      const value = parseExpression();
      take(")");
      return value;
    }
    if (/^\d/.test(token)) return Number(token);
    const fn = FUNCTIONS[token.toLowerCase()];
    if (!fn) throw new Error(`Unknown identifier "${token}"`);
    take("(");
    const args = [parseExpression()];
    while (peek() === ",") {
      take();
      args.push(parseExpression());
    }
    take(")");
    return fn(...args);
  };

  const result = parseExpression();
  if (pos !== tokens.length) throw new Error(`Unexpected token "${peek()}"`);
  if (!Number.isFinite(result)) throw new Error("Result is not a finite number");
  return result;
}

export const calculatorTool = createTool({
  id: "calculator",
  description:
    "Calcolatrice deterministica. Usala per ogni conto (ROI, margini, CAC, percentuali, proiezioni) invece di stimare a mente. Operatori: + - * / ^ % e parentesi; funzioni: sqrt, abs, round(x, cifre), min, max, ln, log10, exp.",
  inputSchema: z.object({
    expression: z.string().describe("Espressione aritmetica, es. (1200 - 300) / 300 * 100"),
  }),
  execute: async ({ expression }) => {
    try {
      return { ok: true, expression, result: evaluateExpression(expression) };
    } catch (err) {
      return { ok: false, expression, error: (err as Error).message };
    }
  },
});
