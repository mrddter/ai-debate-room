import type { Agent } from "@mastra/core/agent";
import { debateConfig, type AgentConfig } from "./debateConfig";
import { createVolcanicAgent, type AgentConfig as VolcanicAgentConfig } from "./volcanicAI";

export type AgentFactory = (config: VolcanicAgentConfig) => Promise<Agent>;

export interface SessionAgent {
  config: AgentConfig;
  agent: Agent;
}

export interface CoreAgents {
  moderator: SessionAgent;
  judges: SessionAgent[];
  hand: Agent;
}

const HAND_INSTRUCTIONS = `Decidi per conto di un partecipante a un dibattito se alzare la mano per intervenire.
Alzala solo se il partecipante, con le sue competenze, ha qualcosa di nuovo e pertinente da dire adesso.
Il pitch è il tema dell'intervento in massimo 12 parole, senza preamboli.`;

// Agents carry no tools: per-session tools are passed at call time, so nothing leaks across debates
async function build(config: AgentConfig, factory: AgentFactory): Promise<SessionAgent> {
  return { config, agent: await factory({ id: config.id, name: config.name, instructions: config.instructions, model: config.model }) };
}

export async function createCoreAgents(factory: AgentFactory = createVolcanicAgent): Promise<CoreAgents> {
  if (!debateConfig.moderator.enabled) throw new Error("The moderator is disabled in debateConfig");
  const [moderator, judges, hand] = await Promise.all([
    build(debateConfig.moderator, factory),
    Promise.all(debateConfig.judges.filter((judge) => judge.enabled).map((judge) => build(judge, factory))),
    factory({ id: "hand", name: "Alzata di mano", instructions: HAND_INSTRUCTIONS, model: debateConfig.handModel }),
  ]);
  return { moderator, judges, hand };
}

export async function createDebaterAgents(
  configs: AgentConfig[],
  factory: AgentFactory = createVolcanicAgent,
): Promise<Map<string, SessionAgent>> {
  const built = await Promise.all(configs.map((config) => build(config, factory)));
  return new Map(built.map((entry) => [entry.config.id, entry]));
}
