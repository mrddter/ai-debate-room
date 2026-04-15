import { z } from "zod";

export const debaterSelectionSchema = z.object({
  debaters: z.array(
    z.object({
      id: z.string(),
      reason: z.string().max(100),
    }),
  ),
  moderatorMessage: z.string().optional(),
});

export const routeNextSpeakerSchema = z.object({
  nextSpeakerId: z.string(),
  transition: z.string().max(150),
});

export const summarySchema = z.object({
  summary: z.string(),
  inShort: z.string().max(200),
});

export const speechSchema = z.object({
  text: z.string(),
});

export const judgeOutputSchema = z.object({
  isReady: z.boolean(),
  reason: z.string(),
  maturityDegree: z.number().min(1).max(5),
});
