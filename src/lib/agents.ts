import { Agent } from "@mastra/core/agent";
import { debateConfig } from "./debateConfig";
import { saveArtifactTool } from "../mcp/saveArtifactTool";
import { createVolcanicAgent } from "./volcanicAI";

export let moderatorAgent: Agent;
export let debaterAgents: Agent[] = [];
export let judgeAgents: Agent[] = [];

export async function initializeAgents() {
  moderatorAgent = await createVolcanicAgent({
    ...debateConfig.moderator,
    tools: { saveArtifactTool },
  });

  debaterAgents = await Promise.all(
    debateConfig.debaters.map((config) => createVolcanicAgent(config)),
  );

  judgeAgents = await Promise.all(
    debateConfig.judges.map((config) => createVolcanicAgent(config)),
  );
}
