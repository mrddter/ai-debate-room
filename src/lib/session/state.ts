import type { AgentConfig } from "../debateConfig";
import {
  MODERATOR_ID,
  type DebateEvent,
  type FinishReason,
  type HandKind,
  type SessionSettings,
  type UsageRecord,
  type WebSource,
} from "./events";
import { applyBoardOps, emptyBoard, type Board } from "./whiteboard";

export interface TranscriptMessage {
  seq: number;
  turn: number;
  speakerId: string;
  kind: "speech" | "moderator";
  text: string;
  replyTo: string[];
}

export interface HandEntry {
  debaterId: string;
  kind: HandKind;
  pitch: string;
  target?: string;
  // Turn of the first raise: re-raising keeps the place in the queue
  raisedTurn: number;
}

export interface JudgeVerdict {
  turn: number;
  judgeId: string;
  judgeName: string;
  isReady: boolean;
  reason: string;
  maturityDegree: number;
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  webSearches: number;
  ms: number;
}

export type DebatePhase = "selecting" | "running" | "finished";

export interface DebateState {
  debateId: string;
  topic: string;
  settings: SessionSettings;
  phase: DebatePhase;
  startedAt: string;
  endedAt?: string;
  debaters: AgentConfig[];
  moderatorMessage?: string;
  messages: TranscriptMessage[];
  board: Board;
  notebooks: Record<string, string>;
  queue: HandEntry[];
  turn: number;
  lastSpeakerId?: string;
  spokenCount: Record<string, number>;
  verdicts: JudgeVerdict[];
  sources: Record<string, WebSource[]>;
  toolCalls: number;
  usage: {
    total: UsageTotals;
    byPurpose: Record<string, UsageTotals>;
    byAgent: Record<string, UsageTotals>;
  };
  errors: number;
  boardRejections: string[];
  finishReason?: FinishReason;
  summary?: { text: string; inShort: string };
}

export function emptyUsage(): UsageTotals {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearches: 0, ms: 0 };
}

export function createInitialState(): DebateState {
  return {
    debateId: "",
    topic: "",
    settings: { maxTurns: 0, contextWindow: 0, judgeEvery: 0 },
    phase: "selecting",
    startedAt: "",
    debaters: [],
    messages: [],
    board: emptyBoard(),
    notebooks: {},
    queue: [],
    turn: 0,
    spokenCount: {},
    verdicts: [],
    sources: {},
    toolCalls: 0,
    usage: { total: emptyUsage(), byPurpose: {}, byAgent: {} },
    errors: 0,
    boardRejections: [],
  };
}

function addUsage(totals: UsageTotals, record: UsageRecord) {
  totals.calls++;
  totals.inputTokens += record.inputTokens;
  totals.outputTokens += record.outputTokens;
  totals.cachedInputTokens += record.cachedInputTokens;
  totals.reasoningTokens += record.reasoningTokens;
  totals.webSearches += record.webSearches;
  totals.ms += record.ms;
}

// Mutates state: the session owns a single state object and the log is the source of truth (replay rebuilds it)
export function applyEvent(state: DebateState, event: DebateEvent): DebateState {
  switch (event.type) {
    case "debate_started":
      state.debateId = event.debateId;
      state.topic = event.topic;
      state.settings = { ...event.settings };
      state.startedAt = event.ts;
      state.phase = "selecting";
      break;
    case "debaters_selected":
      state.debaters = event.debaters;
      state.moderatorMessage = event.moderatorMessage;
      state.phase = "running";
      break;
    case "moderator_message":
      state.messages.push({
        seq: event.seq,
        turn: event.turn,
        speakerId: MODERATOR_ID,
        kind: "moderator",
        text: event.text,
        replyTo: [],
      });
      if (event.kind === "summary") state.summary = { text: event.text, inShort: event.inShort ?? "" };
      break;
    case "floor_given":
      // Getting the floor consumes the raised hand
      state.queue = state.queue.filter((hand) => hand.debaterId !== event.speakerId);
      break;
    case "speech":
      state.turn++;
      state.messages.push({
        seq: event.seq,
        turn: state.turn,
        speakerId: event.speakerId,
        kind: "speech",
        text: event.text,
        replyTo: event.replyTo,
      });
      state.lastSpeakerId = event.speakerId;
      state.spokenCount[event.speakerId] = (state.spokenCount[event.speakerId] ?? 0) + 1;
      break;
    case "notebook_updated":
      state.notebooks[event.debaterId] = event.notebook;
      break;
    case "whiteboard_ops": {
      const result = applyBoardOps(state.board, event.ops, {
        author: event.author,
        isModerator: event.author === MODERATOR_ID,
        turn: event.turn,
      });
      state.board = result.board;
      state.boardRejections.push(...result.rejected.map((why) => `t${event.turn} ${event.author}: ${why}`));
      break;
    }
    case "hand_raised": {
      const existing = state.queue.find((hand) => hand.debaterId === event.debaterId);
      const entry: HandEntry = {
        debaterId: event.debaterId,
        kind: event.kind,
        pitch: event.pitch,
        target: event.target,
        raisedTurn: existing?.raisedTurn ?? event.turn,
      };
      state.queue = existing
        ? state.queue.map((hand) => (hand.debaterId === event.debaterId ? entry : hand))
        : [...state.queue, entry];
      break;
    }
    case "hand_lowered":
      state.queue = state.queue.filter((hand) => hand.debaterId !== event.debaterId);
      break;
    case "research_done": {
      const known = state.sources[event.debaterId] ?? [];
      const urls = new Set(known.map((source) => source.url));
      state.sources[event.debaterId] = [...known, ...event.sources.filter((source) => !urls.has(source.url))];
      break;
    }
    case "tool_call":
      state.toolCalls++;
      break;
    case "judge_verdict":
      state.verdicts.push({
        turn: event.turn,
        judgeId: event.judgeId,
        judgeName: event.judgeName,
        isReady: event.isReady,
        reason: event.reason,
        maturityDegree: event.maturityDegree,
      });
      break;
    case "llm_usage": {
      addUsage(state.usage.total, event);
      addUsage((state.usage.byPurpose[event.purpose] ??= emptyUsage()), event);
      addUsage((state.usage.byAgent[event.agentId] ??= emptyUsage()), event);
      break;
    }
    case "error":
      state.errors++;
      break;
    case "debate_finished":
      state.phase = "finished";
      state.finishReason = event.reason;
      state.endedAt = event.ts;
      break;
    default: {
      const unknownEvent: never = event;
      throw new Error(`Unhandled event ${JSON.stringify(unknownEvent)}`);
    }
  }
  return state;
}

export function replay(events: DebateEvent[]): DebateState {
  const state = createInitialState();
  for (const event of events) applyEvent(state, event);
  return state;
}

export function latestVerdicts(state: DebateState): JudgeVerdict[] {
  const lastTurn = state.verdicts.at(-1)?.turn;
  return lastTurn === undefined ? [] : state.verdicts.filter((verdict) => verdict.turn === lastTurn);
}

export function nameOf(state: DebateState, id: string): string {
  if (id === MODERATOR_ID) return "Moderatore";
  return state.debaters.find((debater) => debater.id === id)?.name ?? id;
}

// Messages addressed to a debater that fell out of the recent window
export function addressedTo(state: DebateState, debaterId: string, windowSize: number, limit = 3): TranscriptMessage[] {
  const older = state.messages.slice(0, Math.max(0, state.messages.length - windowSize));
  return older.filter((message) => message.replyTo.includes(debaterId)).slice(-limit);
}

export function searchTranscript(
  state: DebateState,
  query: string,
  options: { speakerId?: string; limit?: number } = {},
): TranscriptMessage[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 1);
  if (terms.length === 0) return [];
  return state.messages
    .filter((message) => !options.speakerId || message.speakerId === options.speakerId)
    .filter((message) => {
      const text = message.text.toLowerCase();
      return terms.every((term) => text.includes(term));
    })
    .slice(-(options.limit ?? 5));
}
