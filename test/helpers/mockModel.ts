import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import type { AgentFactory } from "../../src/lib/agents";
import { createVolcanicAgent } from "../../src/lib/volcanicAI";

export interface MockCall {
  agentId: string;
  prompt: string;
  // User text parts as the provider receives them: the cacheable conversation blocks, then the tail
  parts: string[];
  // Indexes of the parts that carry an Anthropic cache breakpoint
  cached: number[];
  tools: string[];
  structured: boolean;
  abortSignal?: AbortSignal;
}

export interface MockReply {
  text: string;
  sources?: { url: string; title: string }[];
}

// Structured calls must reply with a JSON string, like a real model
export type Responder = (call: MockCall) => string | MockReply | Promise<string | MockReply>;

// Every call reports cache traffic, so cost accounting is exercised on all three input rates
export const MOCK_USAGE = {
  inputTokens: { total: 100, noCache: 10, cacheRead: 60, cacheWrite: 30 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

function textParts(options: any): any[] {
  return (options.prompt ?? [])
    .filter((message: any) => message.role === "user")
    .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
    .filter((part: any) => part.type === "text");
}

export function mockModel(agentId: string, respond: Responder, calls: MockCall[]) {
  const answer = async (options: any): Promise<MockReply> => {
    const parts = textParts(options);
    const call: MockCall = {
      agentId,
      prompt: parts.map((part) => part.text).join("\n"),
      parts: parts.map((part) => part.text),
      cached: parts.flatMap((part, index) => (part.providerOptions?.anthropic?.cacheControl ? [index] : [])),
      tools: (options.tools ?? []).map((tool: any) => tool.name),
      structured: options.responseFormat?.type === "json",
      abortSignal: options.abortSignal,
    };
    calls.push(call);
    const reply = await respond(call);
    return typeof reply === "string" ? { text: reply } : reply;
  };
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: `mock-${agentId}`,
    doGenerate: async (options: any) => {
      const reply = await answer(options);
      return {
        content: [{ type: "text", text: reply.text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: MOCK_USAGE,
        warnings: [],
      };
    },
    doStream: async (options: any) => {
      const reply = await answer(options);
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          ...(reply.sources ?? []).map((source, index) => ({
            type: "source",
            sourceType: "url",
            id: `src-${index}`,
            url: source.url,
            title: source.title,
          })),
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: reply.text },
          { type: "text-end", id: "t1" },
          { type: "finish", usage: MOCK_USAGE, finishReason: { unified: "stop", raw: "stop" } },
        ]),
      };
    },
  } as any);
}

export function mockAgentFactory(respond: Responder, calls: MockCall[]): AgentFactory {
  return (config) => createVolcanicAgent({ ...config, model: mockModel(config.id, respond, calls) as any });
}

// Never answers and rejects when the signal aborts, the way a provider call fails on /stop
export function hangUntilAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
