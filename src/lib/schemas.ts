import { z } from "zod";
import { BOARD_ITEM_KINDS, BOARD_OPS } from "./session/whiteboard";
import { HAND_KINDS } from "./session/events";
import { TOOL_KEYS } from "../mcp/index";

// Array lengths are capped in code, not in the schema: structured output support for maxItems varies by provider

export const debaterSelectionSchema = z.object({
  debaters: z.array(
    z.object({
      id: z.string(),
      reason: z.string(),
    }),
  ),
  newDebaters: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      reason: z.string(),
      skills: z.array(z.string()),
      whenToUse: z.string(),
      description: z.string(),
      instructions: z.string(),
      // An enum, not free text: a near miss like "web_search" would be dropped and leave the role without the tool
      tools: z.array(z.enum(TOOL_KEYS)).optional(),
    })
  ).optional(),
  moderatorMessage: z.string().optional(),
});

export const boardOpSchema = z.object({
  op: z.enum(BOARD_OPS),
  id: z.string().optional().describe("ID dell'elemento (es. W3) per accept, reject, resolve, edit, link"),
  kind: z.enum(BOARD_ITEM_KINDS).optional().describe("Tipo, obbligatorio per add"),
  text: z.string().optional().describe("Testo per add ed edit, motivazione per reject, esito per resolve"),
  url: z.string().optional().describe("URL, obbligatorio per le fonti"),
  to: z.string().optional().describe("ID di destinazione per link"),
});

export const moderatorTurnSchema = z.object({
  whiteboardOps: z.array(boardOpSchema).describe("Operazioni sulla lavagna, array vuoto se non serve nulla"),
  nextSpeakerId: z.string().describe("ID del prossimo a parlare"),
  source: z.enum(["queue", "called"]).describe("queue se scegli dalla coda delle mani alzate, called se chiami tu qualcuno"),
  reason: z.string().describe("Perché proprio lui ora, max 20 parole"),
  transition: z.string().describe("Frase breve con cui dai la parola, max 40 parole"),
});

export const handSchema = z.object({
  raise: z.boolean().describe("true solo se hai qualcosa di nuovo e pertinente da dire adesso"),
  kind: z.enum(HAND_KINDS).describe("replica, nuovo_punto, domanda o dato"),
  pitch: z.string().describe("Il tema del tuo intervento in massimo 12 parole"),
  target: z.string().describe("ID del partecipante a cui rispondi, stringa vuota se nessuno"),
});

export const speechSchema = z.object({
  text: z.string().describe("Il tuo intervento"),
  replyTo: z.array(z.string()).describe("ID dei partecipanti a cui rispondi direttamente, vuoto se nessuno"),
  notebook: z.string().describe("Il tuo taccuino privato aggiornato, sostituisce il precedente, max 120 parole"),
  proposals: z
    .array(
      z.object({
        kind: z.enum(BOARD_ITEM_KINDS),
        text: z.string(),
        url: z.string().describe("URL per le fonti, stringa vuota negli altri casi"),
      }),
    )
    .describe("Proposte per la lavagna, massimo 3, vuoto se nessuna"),
});

export const summarySchema = z.object({
  summary: z.string(),
  inShort: z.string(),
  focalPoints: z.array(z.string()).describe("Da 3 a 7 punti focali, max 35 parole ciascuno"),
});

export const judgeOutputSchema = z.object({
  isReady: z.boolean(),
  reason: z.string(),
  maturityDegree: z.number().min(1).max(5),
});
