import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { search } from "duck-duck-scrape";
import { compile } from "html-to-text";
import * as log from "@volcanicminds/tools/logger";

export const webSearchTool = createTool({
  id: "webSearch",
  description:
    "Searches the web using DuckDuckGo to find information, facts, news, and other web content.",
  inputSchema: z.object({
    query: z
      .string()
      .describe("The search query to look up on the web."),
  }),
  execute: async ({ query }) => {
    log.debug(`[webSearchTool] Searching for: "${query}"`);

    try {
      const searchResults = await search(query, {
        safeSearch: 0 as import("duck-duck-scrape").SafeSearchType,
      });

      if (!searchResults || !searchResults.results || searchResults.results.length === 0) {
        return {
          success: false,
          results: [],
          message: "No results found for the query.",
        };
      }

      // We map the first few results (e.g., top 5) to save tokens
      const formattedResults = searchResults.results.slice(0, 5).map(result => ({
        title: result.title,
        url: result.url,
        description: result.description,
      }));

      return {
        success: true,
        results: formattedResults,
      };
    } catch (error: any) {
      log.error(`[webSearchTool] Error searching the web: ${error.message}`);
      return {
        success: false,
        message: `Error performing search: ${error.message}`,
      };
    }
  },
});
