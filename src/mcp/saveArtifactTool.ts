import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";

export const saveArtifactTool = createTool({
  id: "saveArtifact",
  description:
    "Saves the final summary and the entire debate log to a local file.",
  inputSchema: z.object({
    topic: z.string().describe("The main topic of the debate"),
    summary: z
      .string()
      .describe(
        "A comprehensive summary of the debate, highlighting key arguments from both sides and the final conclusion.",
      ),
    fullLog: z
      .string()
      .describe(
        "The complete history of messages exchanged during the debate, formatted clearly.",
      ),
  }),
  execute: async ({ context }: any) => {
    const { topic, summary, fullLog } = context as {
      topic: string;
      summary: string;
      fullLog: string;
    };

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `debate-artifact-${timestamp}.md`;
    const dir = path.join(process.cwd(), "artifacts");

    let filepath;
    log.debug("Save file " + filename + " in " + dir);

    try {
      await fs.mkdir(dir, { recursive: true });
      const content = `# Debate Artifact\n\n## Topic\n${topic}\n\n## Final Summary\n${summary}\n\n---\n\n## Full Debate Log\n${fullLog}\n`;
      filepath = path.join(dir, filename);
      await fs.writeFile(filepath, content, "utf-8");
    } catch (error) {
      log.error(error);
      throw error;
    }

    return {
      success: true,
      message: `Artifact saved successfully at ${filepath}`,
      filepath,
    };
  },
});
