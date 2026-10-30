import assert from "node:assert/strict";
import { createInitialState, type DebateState } from "../src/lib/session/state";
import { USER_ID } from "../src/lib/session/events";
import { budgetSpent, chooseSpeaker, cleanBoardOp, judgesDue, nextStage, stageConcluded, truncateWords } from "../src/lib/session/rules";
import { debaterConfig } from "./helpers/fixtures";

const settings = { maxTurns: 10, maxCostUsd: 0, judgeEvery: 0 };

function table(overrides: Partial<DebateState> = {}): DebateState {
  return {
    ...createInitialState(),
    debaters: ["alpha", "beta", "gamma"].map(debaterConfig),
    settings,
    ...overrides,
  };
}

const hand = (debaterId: string, raisedTurn = 0) => ({ debaterId, kind: "dato" as const, pitch: "x", raisedTurn });

describe("turn rules", () => {
  it("keeps a valid moderator pick and labels where it came from", () => {
    const state = table({ queue: [hand("beta")] });
    assert.deepEqual(chooseSpeaker(state, { nextSpeakerId: "beta", source: "queue", reason: "r" }), {
      speakerId: "beta",
      source: "queue",
      reason: "r",
    });
    // Claiming the queue for someone who never raised a hand is a direct call
    assert.equal(chooseSpeaker(state, { nextSpeakerId: "gamma", source: "queue", reason: "r" }).source, "called");
  });

  it("falls back to the oldest eligible hand, then to who spoke least", () => {
    const state = table({ lastSpeakerId: "alpha", queue: [hand("alpha"), hand("gamma", 1)], spokenCount: { alpha: 2, beta: 1 } });
    const unknown = chooseSpeaker(state, { nextSpeakerId: "nobody", source: "called", reason: "r" });
    assert.deepEqual([unknown.speakerId, unknown.source], ["gamma", "fallback"]);
    // The last speaker cannot get the floor again, even if the moderator asks
    assert.equal(chooseSpeaker(state, { nextSpeakerId: "alpha", source: "queue", reason: "r" }).speakerId, "gamma");

    const empty = table({ lastSpeakerId: "gamma", spokenCount: { alpha: 1, beta: 1, gamma: 0 } });
    assert.equal(chooseSpeaker(empty, null).speakerId, "alpha");
  });

  it("lets a lone debater speak twice in a row", () => {
    const state = table({ debaters: [debaterConfig("alpha")], lastSpeakerId: "alpha" });
    assert.equal(chooseSpeaker(state, null).speakerId, "alpha");
  });

  it("gives the floor to the user as soon as they raise a hand, whatever the moderator picks", () => {
    const state = table({ queue: [hand("beta"), hand(USER_ID, 1)] });
    assert.deepEqual(chooseSpeaker(state, { nextSpeakerId: "beta", source: "queue", reason: "r" }).speakerId, USER_ID);
    // Without a raised hand the moderator cannot call the user
    assert.equal(chooseSpeaker(table(), { nextSpeakerId: USER_ID, source: "called", reason: "r" }).source, "fallback");
  });

  it("calls the judges once per round of the current stage by default", () => {
    const due = (turn: number, judgeEvery = 0, stageStartedTurn = 0) =>
      judgesDue(table({ turn, stageStartedTurn, settings: { ...settings, maxTurns: 99, judgeEvery } }));
    assert.deepEqual([1, 2, 3, 4, 5, 6].map((turn) => due(turn)), [false, false, true, false, false, true]);
    assert.deepEqual([2, 3, 4, 5].map((turn) => due(turn, 2)), [false, false, true, false]);
    // A new stage gets a full round before the first vote
    assert.deepEqual([4, 5, 6, 7].map((turn) => due(turn, 0, 4)), [false, false, false, true]);
  });

  it("walks the stages of the mode and stops after the last", () => {
    assert.equal(nextStage(table({ mode: "structured", stage: "explore" })), "critique");
    assert.equal(nextStage(table({ mode: "structured", stage: "critique" })), "decide");
    assert.equal(nextStage(table({ mode: "structured", stage: "decide" })), undefined);
    assert.equal(nextStage(table({ mode: "wild", stage: "brainstorm" })), undefined);
  });

  it("spends the budget only when one is set", () => {
    const spent = (costUsd: number, maxCostUsd: number, share?: number) => {
      const state = table({ settings: { ...settings, maxCostUsd } });
      state.usage.total.costUsd = costUsd;
      return budgetSpent(state, share);
    };
    assert.deepEqual([spent(4.99, 5), spent(5, 5), spent(4, 5, 0.8), spent(3.99, 5, 0.8), spent(100, 0)], [false, true, true, false, false]);
  });

  it("concludes a stage on unanimity or on two thirds ready and mature", () => {
    const verdict = (isReady: boolean, maturityDegree: number) => ({ isReady, maturityDegree });
    assert.equal(stageConcluded([verdict(true, 2), verdict(true, 3), verdict(true, 1)], 3), true);
    assert.equal(stageConcluded([verdict(true, 5), verdict(true, 5), verdict(false, 2)], 3), true);
    assert.equal(stageConcluded([verdict(true, 5), verdict(true, 4), verdict(false, 2)], 3), false);
    // Readiness and maturity are counted independently, as in the original rule
    assert.equal(stageConcluded([verdict(true, 5), verdict(true, 4), verdict(false, 5)], 3), true);
    // A judge that failed to answer counts as not ready
    assert.equal(stageConcluded([verdict(true, 5), verdict(true, 5)], 4), false);
    assert.equal(stageConcluded([], 0), false);
  });

  it("normalizes model output before it reaches the board", () => {
    assert.equal(truncateWords("  uno  due tre quattro ", 2), "uno due");
    assert.deepEqual(cleanBoardOp({ op: "accept", id: " W3 ", text: "", url: "  ", to: "" }), { op: "accept", id: "W3" });
  });
});
