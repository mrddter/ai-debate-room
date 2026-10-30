import { MODE_STAGES, USER_ID, type DebateStage, type FloorSource } from "./events";
import type { DebateState } from "./state";
import type { BoardOp } from "./whiteboard";

export interface FloorChoice {
  speakerId: string;
  source: FloorSource;
  reason: string;
}

export interface RoutingDecision {
  nextSpeakerId: string;
  source: "queue" | "called";
  reason: string;
}

export interface Verdict {
  isReady: boolean;
  maturityDegree: number;
}

/**
 * The user's raised hand always wins. Otherwise validates the moderator pick; an invalid or missing pick
 * falls back to the oldest raised hand, then to who spoke least.
 */
export function chooseSpeaker(state: DebateState, decision: RoutingDecision | null): FloorChoice {
  if (state.debaters.length === 0) throw new Error("No debaters to give the floor to");
  // A person waiting in the chat must never lose the turn to a model pick
  if (state.queue.some((hand) => hand.debaterId === USER_ID)) {
    return { speakerId: USER_ID, source: "queue", reason: "Il committente ha chiesto la parola" };
  }
  // Nobody speaks twice in a row, unless they are the only one at the table
  const eligible = state.debaters.filter((debater) => state.debaters.length === 1 || debater.id !== state.lastSpeakerId);
  const eligibleIds = new Set(eligible.map((debater) => debater.id));

  if (decision && eligibleIds.has(decision.nextSpeakerId)) {
    const queued = state.queue.some((hand) => hand.debaterId === decision.nextSpeakerId);
    return {
      speakerId: decision.nextSpeakerId,
      source: decision.source === "queue" && queued ? "queue" : "called",
      reason: decision.reason,
    };
  }

  const hand = state.queue.find((entry) => eligibleIds.has(entry.debaterId));
  if (hand) return { speakerId: hand.debaterId, source: "fallback", reason: "Prima mano alzata in coda" };

  // Array.prototype.sort is stable: ties keep roster order
  const [least] = [...eligible].sort((a, b) => (state.spokenCount[a.id] ?? 0) - (state.spokenCount[b.id] ?? 0));
  return { speakerId: least.id, source: "fallback", reason: "Chi ha parlato meno" };
}

// Inside each stage judges vote once every debater had a chance to speak, then every judgeEvery speeches (0 = once per round)
export function judgesDue(state: DebateState): boolean {
  const roster = state.debaters.length;
  const every = state.settings.judgeEvery > 0 ? state.settings.judgeEvery : roster;
  const inStage = state.turn - state.stageStartedTurn;
  return every > 0 && inStage >= roster && inStage % every === 0;
}

export function nextStage(state: DebateState): DebateStage | undefined {
  const stages = MODE_STAGES[state.mode];
  return stages[stages.indexOf(state.stage) + 1];
}

export function budgetSpent(state: DebateState, share = 1): boolean {
  const cap = state.settings.maxCostUsd;
  return cap > 0 && state.usage.total.costUsd >= cap * share;
}

// Unanimous readiness, or two thirds ready and two thirds at full maturity; a judge that failed counts as not ready
export function stageConcluded(verdicts: Verdict[], judgeCount: number): boolean {
  if (judgeCount === 0) return false;
  const ready = verdicts.filter((verdict) => verdict.isReady).length;
  if (ready === judgeCount) return true;
  const mature = verdicts.filter((verdict) => verdict.maturityDegree >= 5).length;
  const twoThirds = Math.ceil((judgeCount * 2) / 3);
  return ready >= twoThirds && mature >= twoThirds;
}

export function truncateWords(text: string, maxWords: number): string {
  return text.trim().split(/\s+/).filter(Boolean).slice(0, maxWords).join(" ");
}

// Structured outputs return "" for unused optional fields; the board must only see real values
export function cleanBoardOp(op: BoardOp): BoardOp {
  const clean: BoardOp = { op: op.op };
  if (op.id?.trim()) clean.id = op.id.trim();
  if (op.kind) clean.kind = op.kind;
  if (op.text?.trim()) clean.text = op.text.trim();
  if (op.url?.trim()) clean.url = op.url.trim();
  if (op.to?.trim()) clean.to = op.to.trim();
  return clean;
}

export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}
