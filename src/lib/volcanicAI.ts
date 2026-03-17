import { Agent } from "@mastra/core/agent";
import type { LanguageModel } from "ai";

export type ProviderName =
  | "openai"
  | "mistral"
  | "ollama"
  | "google"
  | "anthropic";

export interface ModelConfig {
  provider: ProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface AgentConfig {
  name: string;
  instructions: string;
  model: LanguageModel | ModelConfig;
  tools?: Record<string, unknown>;
}

/**
 * Creates a LanguageModel from explicit config or environment variables.
 * Mimics @volcanicminds/tools pattern.
 */
export async function createModel(config: ModelConfig): Promise<LanguageModel> {
  const provider = config.provider;
  const modelName = config.model;
  const apiKey = config.apiKey || process.env[`${provider.toUpperCase()}_API_KEY`];
  const baseUrl = config.baseUrl || process.env[`${provider.toUpperCase()}_BASE_URL`];

  switch (provider) {
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const openai = createOpenAI({ apiKey });
      return openai(modelName) as any;
    }

    case "mistral": {
      const { createMistral } = await import("@ai-sdk/mistral");
      const mistral = createMistral({ apiKey });
      return mistral(modelName) as any;
    }

    case "ollama": {
      const { createOllama } = await import("ollama-ai-provider");
      const ollama = createOllama({ baseURL: baseUrl });
      return ollama(modelName) as any;
    }

    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      const google = createGoogleGenerativeAI({ apiKey });
      return google(modelName) as any;
    }

    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      const anthropic = createAnthropic({ apiKey });
      return anthropic(modelName) as any;
    }

    default:
      throw new Error(`Provider ${provider} implementation mapping missing`);
  }
}

function isModelConfig(model: any): model is ModelConfig {
  return model && typeof model === "object" && "provider" in model;
}

/**
 * Creates a Mastra Agent with Volcanic configuration patterns.
 */
export async function createVolcanicAgent(config: AgentConfig): Promise<Agent> {
  const model = isModelConfig(config.model)
    ? await createModel(config.model)
    : (config.model as LanguageModel);

  return new Agent({
    name: config.name,
    instructions: config.instructions,
    model: model as any,
    tools: config.tools as any,
  } as any) as any;
}
