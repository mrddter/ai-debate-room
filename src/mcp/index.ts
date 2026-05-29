import { saveArtifactTool } from "./saveArtifactTool";
import { webSearchTool } from "./webSearchTool";
import { fetchWebpageTool } from "./fetchWebpageTool";

export const availableTools = {
  saveArtifact: saveArtifactTool,
  webSearch: webSearchTool,
  fetchWebpage: fetchWebpageTool,
};

export type AvailableToolKeys = keyof typeof availableTools;
