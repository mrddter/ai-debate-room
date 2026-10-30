import type { AgentConfig } from "../debateConfig";
import type { BoardOp } from "./whiteboard";

export const MODERATOR_ID = "moderator";
// The person who commissioned the debate: speaks only after raising a hand from the chat
export const USER_ID = "user";
// Participant ids with a fixed meaning: a debater can never take them
export const RESERVED_IDS: readonly string[] = [MODERATOR_ID, USER_ID];

export const HAND_KINDS = ["replica", "nuovo_punto", "domanda", "dato"] as const;
export type HandKind = (typeof HAND_KINDS)[number];

export const DEBATE_MODES = ["structured", "wild"] as const;
export type DebateMode = (typeof DEBATE_MODES)[number];
export type DebateStage = "explore" | "critique" | "decide" | "brainstorm";
// Judges close one stage at a time; closing the last stage ends the debate
export const MODE_STAGES: Record<DebateMode, readonly DebateStage[]> = {
  structured: ["explore", "critique", "decide"],
  wild: ["brainstorm"],
};

export const MODE_LABELS: Record<DebateMode, string> = {
  structured: "strutturato (esplorazione, critica, decisione)",
  wild: "brainstorming libero (wild)",
};

export const STAGE_LABELS: Record<DebateStage, string> = {
  explore: "esplorazione",
  critique: "critica",
  decide: "decisione",
  brainstorm: "brainstorming libero",
};

export type FloorSource = "queue" | "called" | "fallback";
export type FinishReason = "judges" | "max_turns" | "budget" | "user_stop" | "error";
export type LlmPurpose = "selection" | "intro" | "routing" | "hand" | "research" | "speech" | "judge" | "summary";

export interface SessionSettings {
  maxTurns: number;
  // Spend cap in USD, estimated from list prices; 0 disables it
  maxCostUsd: number;
  // Judges vote every N speeches once each debater had a chance to speak in the current stage
  judgeEvery: number;
}

export interface WebSource {
  url: string;
  title: string;
}

export interface UsageRecord {
  agentId: string;
  purpose: LlmPurpose;
  model: string;
  // Whole prompt, cache reads and writes included
  inputTokens: number;
  outputTokens: number;
  // Cache reads
  cachedInputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  webSearches: number;
  // Estimated from list prices; 0 for models without a price
  costUsd: number;
  steps: number;
  ms: number;
}

export type DebateEventBody =
  | { type: "debate_started"; debateId: string; topic: string; mode: DebateMode; settings: SessionSettings }
  | { type: "debaters_selected"; debaters: AgentConfig[]; moderatorMessage?: string }
  // A resumed debate adopts the limits configured at that moment
  | { type: "settings_changed"; settings: SessionSettings }
  | {
      type: "moderator_message";
      kind: "intro" | "transition" | "summary";
      text: string;
      inShort?: string;
      focalPoints?: string[];
    }
  | { type: "stage_changed"; stage: DebateStage; text: string }
  | { type: "floor_given"; speakerId: string; source: FloorSource; reason: string }
  | { type: "speech"; speakerId: string; text: string; replyTo: string[] }
  | { type: "notebook_updated"; debaterId: string; notebook: string }
  | { type: "whiteboard_ops"; author: string; ops: BoardOp[] }
  | { type: "hand_raised"; debaterId: string; kind: HandKind; pitch: string; target?: string }
  | { type: "hand_lowered"; debaterId: string }
  | { type: "research_done"; debaterId: string; notes: string; sources: WebSource[] }
  | { type: "tool_call"; agentId: string; tool: string; input: unknown }
  | {
      type: "judge_verdict";
      judgeId: string;
      judgeName: string;
      isReady: boolean;
      reason: string;
      maturityDegree: number;
    }
  | ({ type: "llm_usage" } & UsageRecord)
  | { type: "error"; scope: string; message: string }
  | { type: "debate_finished"; reason: FinishReason };

export type DebateEventType = DebateEventBody["type"];

// turn: speeches completed when the event was recorded
export type DebateEvent = DebateEventBody & { seq: number; ts: string; turn: number };
