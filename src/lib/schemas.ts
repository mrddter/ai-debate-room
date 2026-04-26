import { z } from "zod";

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
    })
  ).optional(),
  moderatorMessage: z.string().optional(),
});

export const moderatorAnalysisSchema = z.object({
  updatedWhiteboard: z.string().describe("La versione aggiornata e compatta del documento di progetto/lavagna"),
  candidateIds: z.array(z.string()).min(1).max(4).describe("Array di ID degli agenti da cui si vuole un'opinione sull'alzata di mano")
});

export const raiseHandSchema = z.object({
  score: z.number().min(1).max(10),
  reason: z.string().describe("Breve motivazione (max 20 parole) del perché devi intervenire ora")
});

export const routeNextSpeakerSchema = z.object({
  nextSpeakerId: z.string(),
  transition: z.string(),
});

export const summarySchema = z.object({
  summary: z.string(),
  inShort: z.string(),
});

export const speechSchema = z.object({
  text: z.string(),
});

export const judgeOutputSchema = z.object({
  isReady: z.boolean(),
  reason: z.string(),
  maturityDegree: z.number().min(1).max(5),
});
