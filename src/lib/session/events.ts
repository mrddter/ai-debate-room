import type { AgentConfig } from "../debateConfig";
import type { BoardOp } from "./whiteboard";

export const MODERATOR_ID = "moderator";

export const HAND_KINDS = ["replica", "nuovo_punto", "domanda", "dato"] as const;
export type HandKind = (typeof HAND_KINDS)[number];

export type FloorSource = "queue" | "called" | "fallback";
export type FinishReason = "judges" | "max_turns" | "user_stop" | "error";
export type LlmPurpose = "selection" | "intro" | "routing" | "hand" | "research" | "speech" | "judge" | "summary";

export interface SessionSettings {
  maxTurns: number;
  // Number of most recent messages every debater sees verbatim
  contextWindow: number;
  // Judges vote every N speeches once each debater had a chance to speak
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
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  webSearches: number;
  steps: number;
  ms: number;
}

export type DebateEventBody =
  | { type: "debate_started"; debateId: string; topic: string; settings: SessionSettings }
  | { type: "debaters_selected"; debaters: AgentConfig[]; moderatorMessage?: string }
  | { type: "moderator_message"; kind: "intro" | "transition" | "summary"; text: string; inShort?: string }
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
