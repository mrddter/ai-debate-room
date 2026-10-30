import type { Agent, ToolsInput } from "@mastra/core/agent";
import type { FullOutput } from "@mastra/core/stream";
import type { ModelMessage } from "ai";
import type { z } from "zod";
import { costUsd } from "./pricing";
import type { LlmPurpose, UsageRecord, WebSource } from "./session/events";

/**
 * A call inside the debate conversation: append-only blocks shared by every call of the debate, then a tail
 * that only this call sees. Blocks are cached, so they must never change once sent: anything that varies
 * between calls (board, counts, task) belongs in the tail.
 */
export interface ChainPrompt {
  blocks: string[];
  tail: string;
}

export type Prompt = string | ChainPrompt;

export interface CallOptions {
  agentId: string;
  purpose: LlmPurpose;
  model: string;
  tools?: ToolsInput;
  // Mastra stops after 5 steps by default; tool loops need an explicit budget
  maxSteps?: number;
  abortSignal?: AbortSignal;
  onUsage?: (usage: UsageRecord) => void;
  onToolCall?: (tool: string, input: unknown) => void;
}

export interface TextResult {
  text: string;
  sources: WebSource[];
}

const SCHEMA_RETRIES = 2;
const TRANSIENT_RETRIES = 4;
const TRANSIENT_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const JSON_ONLY_SUFFIX =
  "\n\nIMPORTANT: You must return ONLY a valid JSON object. Do not include any other text or markdown formatting outside the JSON object.";
// One hour: an agent can stay silent for several minutes between two calls, longer than the 5 minute TTL
const CACHE_CONTROL = { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } };
// The API looks for an earlier cache entry at most 20 blocks back from a breakpoint: a fixed checkpoint
// every 10 blocks keeps the conversation cached when an agent skips many turns
const CHECKPOINT_BLOCKS = 10;

type GenerateResult = FullOutput<unknown>;
type Input = string | ModelMessage[];

// Breakpoints on the last block and on the latest checkpoint; other providers ignore the Anthropic options
export function toInput(prompt: Prompt, suffix: string): Input {
  if (typeof prompt === "string") return prompt + suffix;
  const last = prompt.blocks.length - 1;
  const checkpoint = last - (last % CHECKPOINT_BLOCKS);
  const blocks = prompt.blocks.map((text, index) =>
    index === last || index === checkpoint
      ? { type: "text" as const, text, providerOptions: CACHE_CONTROL }
      : { type: "text" as const, text },
  );
  return [{ role: "user", content: [...blocks, { type: "text", text: prompt.tail + suffix }] }];
}

function errorChain(err: unknown): any[] {
  const chain: any[] = [];
  let current: any = err;
  while (current && chain.length < 4) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

// Backoff only for rate limits and overloads; any other failure surfaces immediately
export function transientRetryDelay(err: unknown, attempt: number): number | null {
  if (attempt >= TRANSIENT_RETRIES) return null;
  const chain = errorChain(err);
  const transient = chain.some(
    (e) =>
      TRANSIENT_STATUS.has(e?.statusCode ?? e?.status) ||
      e?.isRetryable === true ||
      /overloaded|rate.?limit|too many requests/i.test(String(e?.message ?? "")),
  );
  if (!transient) return null;
  const retryAfter = chain.map((e) => Number(e?.responseHeaders?.["retry-after"])).find((s) => Number.isFinite(s) && s > 0);
  if (retryAfter) return Math.min(retryAfter * 1000, 60_000);
  return 2_000 * 2 ** attempt + Math.floor(Math.random() * 500);
}

function isSchemaError(err: unknown): boolean {
  return errorChain(err).some(
    (e) =>
      String(e?.id ?? "").startsWith("STRUCTURED_OUTPUT_") ||
      e?.name === "NoObjectGeneratedError" ||
      e?.name === "ZodError" ||
      /No object generated|JSON|parse/i.test(String(e?.message ?? "")),
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Aborted"));
      },
      { once: true },
    );
  });
}

function countWebSearches(result: GenerateResult): number {
  return (result.steps ?? []).reduce((sum, step: any) => {
    const requests = step?.providerMetadata?.anthropic?.usage?.server_tool_use?.web_search_requests;
    return sum + (typeof requests === "number" ? requests : 0);
  }, 0);
}

function report(result: GenerateResult, options: CallOptions, startedAt: number) {
  const usage: any = result.totalUsage ?? result.usage ?? {};
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const cacheWriteTokens = usage.cacheCreationInputTokens ?? 0;
  // Without the TTL split every write is priced at the 1 hour rate, the TTL this module sets
  const cacheWrite5mTokens = Math.min(usage.cacheCreationInputTokens5m ?? 0, cacheWriteTokens);
  const webSearches = countWebSearches(result);
  const steps = result.steps?.length ?? 0;
  options.onUsage?.({
    agentId: options.agentId,
    purpose: options.purpose,
    model: options.model,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    reasoningTokens: usage.reasoningTokens ?? 0,
    webSearches,
    costUsd: costUsd(options.model, {
      inputTokens,
      outputTokens,
      cacheReadTokens: cachedInputTokens,
      cacheWrite5mTokens,
      cacheWrite1hTokens: cacheWriteTokens - cacheWrite5mTokens,
      webSearches,
      steps,
    }),
    steps,
    ms: Date.now() - startedAt,
  });
  for (const step of result.steps ?? []) {
    for (const call of step.toolCalls ?? []) options.onToolCall?.(call.payload.toolName, call.payload.args);
  }
}

function collectSources(result: GenerateResult): WebSource[] {
  const seen = new Map<string, WebSource>();
  const chunks = [...(result.sources ?? []), ...(result.steps ?? []).flatMap((step) => step.sources ?? [])];
  for (const chunk of chunks) {
    const url = chunk.payload?.url;
    if (url && !seen.has(url)) seen.set(url, { url, title: chunk.payload.title ?? url });
  }
  return [...seen.values()];
}

async function call(agent: Agent, prompt: Input, options: CallOptions, structured?: z.ZodType): Promise<GenerateResult> {
  const startedAt = Date.now();
  const execution = {
    ...(options.tools ? { toolsets: { debate: options.tools } } : {}),
    ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}),
    abortSignal: options.abortSignal,
  };
  // stream + getFullOutput instead of generate: generate returns empty sources, dropping web citations.
  // Two calls because stream is overloaded on the presence of structuredOutput
  const output = structured
    ? await agent.stream(prompt, { ...execution, structuredOutput: { schema: structured } })
    : await agent.stream(prompt, execution);
  const result: GenerateResult = await output.getFullOutput();
  if (result.error) throw result.error;
  report(result, options, startedAt);
  return result;
}

async function withTransientRetry<T>(options: CallOptions, run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (options.abortSignal?.aborted) throw err;
      const delay = transientRetryDelay(err, attempt);
      if (delay === null) throw err;
      console.warn(`[llm] ${options.agentId}/${options.purpose} transient error, retry in ${delay}ms: ${(err as Error).message}`);
      await sleep(delay, options.abortSignal);
    }
  }
}

export async function generateObject<T>(agent: Agent, prompt: Prompt, schema: z.ZodType<T>, options: CallOptions): Promise<T> {
  const finalPrompt = toInput(prompt, JSON_ONLY_SUFFIX);
  let lastError: unknown;
  for (let attempt = 0; attempt <= SCHEMA_RETRIES; attempt++) {
    try {
      return await withTransientRetry(options, async () => {
        const result = await call(agent, finalPrompt, options, schema);
        // Mastra may report a failed structured output on result.error instead of throwing
        if (result.object === undefined) throw result.error ?? new Error("No object generated");
        return schema.parse(result.object);
      });
    } catch (err) {
      if (options.abortSignal?.aborted || !isSchemaError(err)) throw err;
      lastError = err;
      console.warn(`[llm] ${options.agentId}/${options.purpose} schema failure ${attempt + 1}: ${(err as Error).message}`);
    }
  }

  // Providers without native structured output sometimes wrap valid JSON in prose
  const fallback = await withTransientRetry(options, () => call(agent, finalPrompt, options));
  const match = fallback.text?.match(/\{[\s\S]*\}/);
  if (!match) throw lastError;
  return schema.parse(JSON.parse(match[0]));
}

export async function generateText(agent: Agent, prompt: Prompt, options: CallOptions): Promise<TextResult> {
  const input = toInput(prompt, "");
  const result = await withTransientRetry(options, () => call(agent, input, options));
  return { text: result.text ?? "", sources: collectSources(result) };
}
