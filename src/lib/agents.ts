import { Agent } from "@mastra/core/agent";
import { AgentConfig, debateConfig } from "./debateConfig";
import { availableTools, AvailableToolKeys } from "../mcp/index";
import { createVolcanicAgent } from "./volcanicAI";
import * as log from "@volcanicminds/tools/logger";

export let moderatorAgent: Agent;
export let debaterAgents: Agent[] = [];
export let judgeAgents: Agent[] = [];

export async function initializeAgents() {
  if (debateConfig.moderator.enabled) {
    moderatorAgent = await createVolcanicAgent({
      ...(debateConfig.moderator as any),
      ...debateConfig.moderator,
      tools: {
        saveArtifact: availableTools.saveArtifact,
      },
    });
  }

  judgeAgents = await Promise.all(
    debateConfig.judges
      .filter((config) => config.enabled)
      .map((config) => createVolcanicAgent(config as any)),
  );

  log.info("Moderator " + moderatorAgent.id);
  log.info("Judges " + judgeAgents.length);
}

export async function initializeDebaterAgents(selectedConfigs: AgentConfig[]) {
  debaterAgents = await Promise.all(
    selectedConfigs.map((config) => {
      let agentTools: Record<string, any> = {};

      // Always inject the sharedWhiteboardTool for all debaters
      agentTools["sharedWhiteboard"] = availableTools.sharedWhiteboard;

      if (config.tools && Array.isArray(config.tools)) {
        config.tools.forEach(toolKey => {
          if (availableTools[toolKey as AvailableToolKeys]) {
            agentTools[toolKey] = availableTools[toolKey as AvailableToolKeys];
          }
        });
      }
      return createVolcanicAgent({ ...config, tools: agentTools as Record<string, unknown> } as Omit<AgentConfig, "tools"> & { tools: Record<string, unknown> } as any);
    })
  );
  log.info("Debaters Initialized: " + debaterAgents.length);
}
