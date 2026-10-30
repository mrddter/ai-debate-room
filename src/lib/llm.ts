import type { Agent, ToolsInput } from "@mastra/core/agent";
import type { FullOutput } from "@mastra/core/stream";
import type { z } from "zod";
import type { LlmPurpose, UsageRecord, WebSource } from "./session/events";

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

type GenerateResult = FullOutput<unknown>;

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
  options.onUsage?.({
    agentId: options.agentId,
    purpose: options.purpose,
    model: options.model,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    webSearches: countWebSearches(result),
    steps: result.steps?.length ?? 0,
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

async function call(agent: Agent, prompt: string, options: CallOptions, structured?: z.ZodType): Promise<GenerateResult> {
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

export async function generateObject<T>(agent: Agent, prompt: string, schema: z.ZodType<T>, options: CallOptions): Promise<T> {
  const finalPrompt = prompt + JSON_ONLY_SUFFIX;
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

export async function generateText(agent: Agent, prompt: string, options: CallOptions): Promise<TextResult> {
  const result = await withTransientRetry(options, () => call(agent, prompt, options));
  return { text: result.text ?? "", sources: collectSources(result) };
}
