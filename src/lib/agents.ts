import { Agent } from "@mastra/core/agent";
import { AgentConfig, debateConfig } from "./debateConfig";
import { saveArtifactTool } from "../mcp/saveArtifactTool";

export function createDebaterAgent(config: AgentConfig): Agent {
  return new Agent({
    name: config.name,
    instructions: config.instructions,
    model: config.model,
  } as any) as any;
}

export function createModeratorAgent(config: AgentConfig): Agent {
  return new Agent({
    name: config.name,
    instructions: config.instructions,
    model: config.model,
    tools: { saveArtifactTool: saveArtifactTool as any },
  } as any) as any;
}

export function createJudgeAgent(config: AgentConfig): Agent {
  return new Agent({
    name: config.name,
    instructions: config.instructions,
    model: config.model,
  } as any) as any;
}

export const moderatorAgent = createModeratorAgent(debateConfig.moderator);
export const debaterAgents = debateConfig.debaters.map(createDebaterAgent);
export const judgeAgents = debateConfig.judges.map(createJudgeAgent);
