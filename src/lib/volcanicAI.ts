import { Agent, type AgentExecutionOptions } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { ToolsInput } from "@mastra/core/agent";

export type ProviderName =
  | "openai"
  | "mistral"
  | "ollama"
  | "google"
  | "anthropic";

export type ProviderOptions = NonNullable<AgentExecutionOptions["providerOptions"]>;

export interface ModelConfig {
  provider: ProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  // Applied to every generate call of the agent (e.g. anthropic effort, fallbacks)
  providerOptions?: ProviderOptions;
}

export interface AgentConfig {
  id: string;
  name: string;
  instructions: string;
  model: MastraModelConfig | ModelConfig;
  tools?: ToolsInput;
}

/**
 * Creates a LanguageModel from explicit config or environment variables.
 * Mimics @volcanicminds/tools pattern.
 */
export async function createModel(config: ModelConfig): Promise<MastraModelConfig> {
  const provider = config.provider;
  const modelName = config.model;
  const apiKey = config.apiKey || process.env[`${provider.toUpperCase()}_API_KEY`];
  const baseUrl = config.baseUrl || process.env[`${provider.toUpperCase()}_BASE_URL`];

  switch (provider) {
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const openai = createOpenAI({ apiKey });
      return openai(modelName);
    }

    case "mistral": {
      const { createMistral } = await import("@ai-sdk/mistral");
      const mistral = createMistral({ apiKey });
      return mistral(modelName);
    }

    case "ollama": {
      // Workaround: Use OpenAI provider for Ollama to avoid strict performance metrics validation (like eval_duration)
      // which often fails on proxied Ollama endpoints.
      const { createOpenAI } = await import("@ai-sdk/openai");
      const ollama = createOpenAI({
        baseURL: baseUrl?.replace("/api/chat", "/v1").replace(/\/$/, "") || "http://127.0.0.1:11434/v1",
        apiKey: "ollama",
      });
      return ollama.chat(modelName);
    }

    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      const google = createGoogleGenerativeAI({ apiKey });
      return google(modelName);
    }

    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      const anthropic = createAnthropic({ apiKey });
      return anthropic(modelName);
    }

    default: {
      const unknownProvider: never = provider;
      throw new Error(`Provider ${unknownProvider} implementation mapping missing`);
    }
  }
}

function isModelConfig(model: unknown): model is ModelConfig {
  return !!model && typeof model === "object" && "provider" in model && "model" in model;
}

/**
 * Creates a Mastra Agent with Volcanic configuration patterns.
 */
export async function createVolcanicAgent(config: AgentConfig): Promise<Agent> {
  const modelConfig = isModelConfig(config.model) ? config.model : undefined;
  const model = modelConfig ? await createModel(modelConfig) : (config.model as MastraModelConfig);

  return new Agent({
    id: config.id,
    name: config.name,
    instructions: config.instructions,
    model,
    tools: config.tools,
    defaultOptions: modelConfig?.providerOptions
      ? { providerOptions: modelConfig.providerOptions }
      : undefined,
  });
}
