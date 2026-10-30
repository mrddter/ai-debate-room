import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as dns from "node:dns";
import * as https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import * as log from "@volcanicminds/tools/logger";

const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

// Agents pick the URL, possibly steered by fetched content, so only public addresses may be reached
const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}
// BlockList already matches IPv4-mapped IPv6 against the IPv4 rules (a ::ffff:0:0/96 rule would block all IPv4);
// NAT64 and 6to4 are not mapped, so they are blocked whole since they can embed a private IPv4 address
for (const [network, prefix] of [
  ["::", 127],
  ["64:ff9b::", 96],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

function isBlockedAddress(address: string): boolean {
  return blockedAddresses.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

// Checks the addresses actually used for the connection, so DNS rebinding cannot swap in a private IP
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, []);
    const blocked = addresses.find((entry) => isBlockedAddress(entry.address));
    if (blocked) {
      return callback(
        new Error(`Blocked non-public address ${blocked.address} for ${hostname}`),
        [],
      );
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};

// Own agent: it bypasses any env proxy, which would resolve the host outside publicOnlyLookup
const publicOnlyAgent = new https.Agent({ lookup: publicOnlyLookup });

function parsePublicHttpsUrl(raw: string, base?: URL): URL {
  const url = new URL(raw, base);
  if (url.protocol !== "https:") {
    throw new Error(`Only https URLs are allowed: ${url.href}`);
  }
  // IP literals never go through the lookup, so they are checked here
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isBlockedAddress(host)) {
    throw new Error(`Blocked non-public address: ${host}`);
  }
  return url;
}

interface PageResponse {
  status: number;
  location?: string;
  body: string;
}

function requestPage(url: URL): Promise<PageResponse> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        agent: publicOnlyAgent,
        headers: { "User-Agent": USER_AGENT },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.resume();
          resolve({ status, location: response.headers.location, body: "" });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(
              new Error(`Response larger than ${MAX_RESPONSE_BYTES} bytes`),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({ status, body: Buffer.concat(chunks).toString("utf-8") }),
        );
        response.on("error", reject);
      },
    );
    request.on("timeout", () =>
      request.destroy(
        new Error(`Request timed out after ${REQUEST_TIMEOUT_MS} ms`),
      ),
    );
    request.on("error", reject);
  });
}

// Redirects are followed by hand so every hop is validated again
async function fetchPublicPage(rawUrl: string): Promise<PageResponse> {
  let url = parsePublicHttpsUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const page = await requestPage(url);
    if (!page.location) return page;
    url = parsePublicHttpsUrl(page.location, url);
  }
  throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
}

export const fetchWebpageTool = createTool({
  id: "fetchWebpage",
  description:
    "Fetches the textual content of a given public https URL. Useful for reading articles, documentation, or specific web pages.",
  inputSchema: z.object({
    url: z
      .string()
      .url()
      .describe(
        "The full https URL of the webpage to fetch (e.g., https://example.com). Only public https URLs are allowed.",
      ),
  }),
  execute: async ({ url }) => {
    log.debug(`[fetchWebpageTool] Fetching URL: "${url}"`);

    try {
      const page = await fetchPublicPage(url);

      if (page.status < 200 || page.status >= 300) {
        return {
          success: false,
          message: `Failed to fetch webpage. Status: ${page.status}`,
        };
      }

      const html = page.body;

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
