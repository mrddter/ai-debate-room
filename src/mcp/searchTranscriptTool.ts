import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { nameOf, searchTranscript, type DebateState } from "../lib/session/state";

const EXCERPT_CHARS = 600;

// Bound to one session: each debate gets its own instance, nothing is shared across debates
export function createSearchTranscriptTool(getState: () => DebateState) {
  return createTool({
    id: "searchTranscript",
    description:
      "Cerca nella trascrizione completa del dibattito gli interventi che contengono tutte le parole indicate. Usala per ritrovare cosa ha detto qualcuno fuori dagli ultimi messaggi che vedi.",
    inputSchema: z.object({
      query: z.string().describe("Parole chiave, tutte devono comparire nell'intervento"),
      speakerId: z.string().optional().describe("ID del partecipante per filtrare i suoi interventi"),
      limit: z.number().int().min(1).max(10).optional().describe("Numero massimo di risultati, default 5"),
    }),
    execute: async ({ query, speakerId, limit }) => {
      const state = getState();
      const matches = searchTranscript(state, query, { speakerId, limit });
      return {
        count: matches.length,
        matches: matches.map((message) => ({
          turn: message.turn,
          speaker: nameOf(state, message.speakerId),
          text: message.text.length > EXCERPT_CHARS ? `${message.text.slice(0, EXCERPT_CHARS)}…` : message.text,
        })),
      };
    },
  });
}
