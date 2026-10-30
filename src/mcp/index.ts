import type { ToolsInput } from "@mastra/core/agent";
import { anthropic } from "@ai-sdk/anthropic";
import { calculatorTool } from "./calculatorTool";

export const TOOL_KEYS = ["webSearch", "webFetch", "calculator"] as const;
export type ToolKey = (typeof TOOL_KEYS)[number];

// Anthropic server tools: they emit citations, which the API rejects together with structured output,
// so they only run in the free-text research call, never in the structured speech call
export const WEB_TOOL_KEYS: readonly ToolKey[] = ["webSearch", "webFetch"];

export function isToolKey(value: string): value is ToolKey {
  return (TOOL_KEYS as readonly string[]).includes(value);
}

export function buildTools(keys: readonly ToolKey[]): ToolsInput {
  const tools: ToolsInput = {};
  for (const key of new Set(keys)) {
    switch (key) {
      case "webSearch":
        tools.web_search = anthropic.tools.webSearch_20260318({ maxUses: 3 });
        break;
      case "webFetch":
        tools.web_fetch = anthropic.tools.webFetch_20260318({ maxUses: 3, maxContentTokens: 8000 });
        break;
      case "calculator":
        tools.calculator = calculatorTool;
        break;
      default: {
        const unknownKey: never = key;
        throw new Error(`Tool ${unknownKey} is not mapped`);
      }
    }
  }
  return tools;
}
