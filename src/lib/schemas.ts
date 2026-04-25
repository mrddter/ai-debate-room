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
