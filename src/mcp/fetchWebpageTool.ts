import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as log from "@volcanicminds/tools/logger";

export const fetchWebpageTool = createTool({
  id: "fetchWebpage",
  description:
    "Fetches the textual content of a given URL. Useful for reading articles, documentation, or specific web pages.",
  inputSchema: z.object({
    url: z
      .string()
      .url()
      .describe("The full URL of the webpage to fetch (e.g., https://example.com)"),
  }),
  execute: async ({ url }) => {
    log.debug(`[fetchWebpageTool] Fetching URL: "${url}"`);

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        }
      });

      if (!response.ok) {
        return {
          success: false,
          message: `Failed to fetch webpage. Status: ${response.status} ${response.statusText}`,
        };
      }

      const html = await response.text();

      // Dynamic import to avoid esm issues if any
      const { compile } = await import("html-to-text");
      const htmlToText = compile({
        wordwrap: 130,
        ignoreHref: true,
        ignoreImage: true,
      });

      const text = htmlToText(html);

      // Truncate to avoid blowing up the context window (e.g. limit to first 10,000 characters)
      const truncatedText = text.length > 10000 ? text.substring(0, 10000) + "\n...[CONTENT TRUNCATED]..." : text;

      return {
        success: true,
        content: truncatedText,
      };
    } catch (error: any) {
      log.error(`[fetchWebpageTool] Error fetching webpage: ${error.message}`);
      return {
        success: false,
        message: `Error fetching webpage: ${error.message}`,
      };
    }
  },
});
