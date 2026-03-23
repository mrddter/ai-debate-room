import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { activeDebate } from "../lib/debateManager";
import * as log from "@volcanicminds/tools/logger";

export const saveArtifactTool = createTool({
  id: "saveArtifact",
  description: "Saves the final summary and the entire debate log to local files.",
  inputSchema: z.object({
    summary: z
      .string()
      .describe(
        "A comprehensive summary of the debate, highlighting key arguments and the final conclusion.",
      ),
    inShort: z
      .string()
      .describe(
        "A very concise, 1-2 sentence summary of the entire debate.",
      ),
  }),
  execute: async ({ context }: any) => {
    const { summary, inShort } = context as {
      summary: string;
      inShort: string;
    };

    if (!activeDebate) {
      log.error("No active debate found to save.");
      return { success: false, message: "No active debate to save" };
    }

    const now = new Date();

    // Format DDMMYY-HHMMSS
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yy = String(now.getFullYear()).slice(2);
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');

    const folderName = `${dd}${mm}${yy}-${hh}${min}${ss}-debate`;
    const dir = path.join(process.cwd(), "artifacts", folderName);

    try {
      await fs.mkdir(dir, { recursive: true });

      // Build participants list
      let participantsList = "";
      if (activeDebate.currentSelection && activeDebate.allAvailableDebaters) {
          participantsList = activeDebate.currentSelection.map(sel => {
            const debater = activeDebate?.allAvailableDebaters.find(d => d.id === sel.id);
            return `- ${debater?.name || sel.id}`;
          }).join("\n");
      }

      // First moderator message
      const firstModeratorMsg = activeDebate.history.find(msg => msg.name === "🦸🏻‍♂️ Moderatore" || msg.role === "assistant")?.content || "";

      // 1. topic.md
      const topicContent = `# Topic\n\n${activeDebate.topic}\n\n## Participants\n${participantsList}\n\n## Initial Moderator Message\n${firstModeratorMsg}\n`;
      await fs.writeFile(path.join(dir, "topic.md"), topicContent, "utf-8");

      // 2. chat.md
      const chatContent = activeDebate.history
        .map((msg) => `**[${msg.name || msg.role}]**: ${msg.content}`)
        .join("\n\n---\n\n");
      await fs.writeFile(path.join(dir, "chat.md"), chatContent, "utf-8");

      // Calculate duration
      let durationStr = "N/A";
      if (activeDebate.startTime && activeDebate.endTime) {
        const diffMs = activeDebate.endTime.getTime() - activeDebate.startTime.getTime();
        const diffSecs = Math.round(diffMs / 1000);
        const mins = Math.floor(diffSecs / 60);
        const secs = diffSecs % 60;
        durationStr = `${mins}m ${secs}s`;
      }

      const metricsStr = `
- **Duration**: ${durationStr}
- **Total Messages Exchanged**: ${activeDebate.history.length}
- **Total Turns**: ${activeDebate.turnCount}
- **Judges Agreed**: ${activeDebate.judgesAgree}
- **Judges Disagreed**: ${activeDebate.judgesDisagree}
      `.trim();

      // 3. Final Summary file
      // Rename output based on requirements: replacing "debate-artifact-..." with custom name
      const summaryFilename = `sunto-finale.md`;
      const summaryContent = `# Sunto Finale\n\n## Topic\n${activeDebate.topic}\n\n## In short\n${inShort}\n\n## Sintesi del dibattito\n${summary}\n\n## Metrics\n${metricsStr}\n`;
      await fs.writeFile(path.join(dir, summaryFilename), summaryContent, "utf-8");

      log.debug(`Saved debate artifacts in ${dir}`);

      return {
        success: true,
        message: `Artifacts saved successfully in ${dir}`,
        dir,
      };
    } catch (error) {
      log.error(error as Error);
      throw error;
    }
  },
});
