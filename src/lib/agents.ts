import { Agent } from "@mastra/core/agent";
import { AgentConfig, debateConfig } from "./debateConfig";
import { saveArtifactTool } from "../mcp/saveArtifactTool";
import { createVolcanicAgent } from "./volcanicAI";
import * as log from "@volcanicminds/tools/logger";

export let moderatorAgent: Agent;
export let debaterAgents: Agent[] = [];
export let judgeAgents: Agent[] = [];

export async function initializeAgents() {
  if (debateConfig.moderator.enabled) {
    moderatorAgent = await createVolcanicAgent({
      ...debateConfig.moderator,
      tools: {
        saveArtifact: saveArtifactTool,
      },
    });
  }

  judgeAgents = await Promise.all(
    debateConfig.judges
      .filter((config) => config.enabled)
      .map((config) => createVolcanicAgent(config)),
  );

  log.info("Moderator " + moderatorAgent.id);
  log.info("Judges " + judgeAgents.length);
}

export async function initializeDebaterAgents(selectedConfigs: AgentConfig[]) {
  debaterAgents = await Promise.all(
    selectedConfigs.map((config) => createVolcanicAgent(config))
  );
  log.info("Debaters Initialized: " + debaterAgents.length);
}
