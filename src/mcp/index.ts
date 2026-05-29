import { saveArtifactTool } from "./saveArtifactTool";
import { webSearchTool } from "./webSearchTool";
import { fetchWebpageTool } from "./fetchWebpageTool";
import { sharedWhiteboardTool } from "./sharedWhiteboardTool";

export const availableTools = {
  saveArtifact: saveArtifactTool,
  webSearch: webSearchTool,
  fetchWebpage: fetchWebpageTool,
  sharedWhiteboard: sharedWhiteboardTool,
};

export type AvailableToolKeys = keyof typeof availableTools;
