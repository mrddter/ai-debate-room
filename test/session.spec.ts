import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { DebateSession, EVENTS_FILE, readEvents } from "../src/lib/session/session";
import { USER_ID } from "../src/lib/session/events";
import { nameOf, replay } from "../src/lib/session/state";
import { debaterConfig, tempDir } from "./helpers/fixtures";

const settings = { maxTurns: 10, maxCostUsd: 0, judgeEvery: 0 };

describe("debate session", () => {
  let root: string;
  beforeEach(() => {
    root = tempDir("debate-session");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("appends every event to the log and replays it to the same state", () => {
    const session = DebateSession.create(root, "Tema", settings);
    session.emit({ type: "debaters_selected", debaters: [debaterConfig("alpha"), debaterConfig("beta")] });
    session.emit({ type: "hand_raised", debaterId: "alpha", kind: "dato", pitch: "Ho un numero" });
    session.emit({ type: "hand_raised", debaterId: "beta", kind: "replica", pitch: "Non sono d'accordo" });
    session.emit({ type: "hand_raised", debaterId: "alpha", kind: "domanda", pitch: "Nuova domanda" });
    session.emit({ type: "floor_given", speakerId: "beta", source: "queue", reason: "coda" });
    session.emit({ type: "speech", speakerId: "beta", text: "Prezzo troppo alto", replyTo: ["alpha"] });
    session.emit({ type: "whiteboard_ops", author: "beta", ops: [{ op: "propose", kind: "decision", text: "Prezzo 49" }] });
    const usage = { model: "m", inputTokens: 10, outputTokens: 5, cachedInputTokens: 4, cacheWriteTokens: 3, reasoningTokens: 0, webSearches: 1, steps: 1, ms: 3 };
    session.emit({ type: "llm_usage", agentId: "beta", purpose: "speech", ...usage, costUsd: 0.25 });
    session.emit({ type: "llm_usage", agentId: "alpha", purpose: "hand", ...usage, costUsd: 0.5 });

    const { state } = session;
    // A re-raised hand keeps its place: raisedTurn of the first raise
    assert.deepEqual(
      state.queue.map((hand) => [hand.debaterId, hand.kind, hand.raisedTurn]),
      [["alpha", "domanda", 0]],
    );
    assert.equal(state.turn, 1);
    assert.equal(state.lastSpeakerId, "beta");
    assert.equal(state.board.items[0].status, "proposed");
    assert.equal(state.usage.byPurpose.speech?.webSearches, 1);
    assert.deepEqual([state.usage.total.costUsd, state.usage.total.cacheWriteTokens, state.usage.byAgent.alpha?.costUsd], [0.75, 6, 0.5]);

    const events = readEvents(session.eventsFile);
    assert.deepEqual(
      events.map((event) => event.seq),
      events.map((_, index) => index + 1),
    );
    assert.deepEqual(replay(events), state);
    assert.deepEqual(DebateSession.open(session.dir).state, state);
  });

  it("refuses events after debate_finished", () => {
    const session = DebateSession.create(root, "Tema", settings);
    session.emit({ type: "debate_finished", reason: "user_stop" });
    assert.throws(() => session.emit({ type: "error", scope: "x", message: "late" }));
  });

  it("tolerates only a truncated last line", () => {
    const session = DebateSession.create(root, "Tema", settings);
    session.emit({ type: "debaters_selected", debaters: [debaterConfig("alpha")] });
    fs.appendFileSync(session.eventsFile, '{"type":"speech","spe');
    assert.equal(readEvents(session.eventsFile).length, 2);

    const lines = fs.readFileSync(session.eventsFile, "utf8").split("\n");
    fs.writeFileSync(session.eventsFile, ["{broken", ...lines].join("\n"));
    assert.throws(() => readEvents(session.eventsFile), /Corrupted event log/);
  });

  it("finds the latest unfinished debate that got past selection", () => {
    const started = DebateSession.create(root, "Avviato", settings, { now: new Date(2026, 0, 1, 10, 0, 0) });
    started.emit({ type: "debaters_selected", debaters: [debaterConfig("alpha")] });
    const finished = DebateSession.create(root, "Finito", settings, { now: new Date(2026, 0, 1, 11, 0, 0) });
    finished.emit({ type: "debaters_selected", debaters: [debaterConfig("alpha")] });
    finished.emit({ type: "debate_finished", reason: "judges" });
    DebateSession.create(root, "Solo selezione", settings, { now: new Date(2026, 0, 1, 12, 0, 0) });

    assert.equal(DebateSession.findUnfinished(root), started.dir);
    assert.equal(path.basename(started.dir), "260101-100000-debate");
    assert.ok(fs.existsSync(path.join(started.dir, EVENTS_FILE)));
  });

  it("never reuses a folder for two debates started in the same second", () => {
    const now = new Date(2026, 0, 2, 10, 0, 0);
    const first = DebateSession.create(root, "A", settings, { now });
    const second = DebateSession.create(root, "B", settings, { now });
    assert.notEqual(first.dir, second.dir);
    // Year first, so folder names sort chronologically
    assert.equal(path.basename(second.dir), "260102-100000-debate-2");
  });

  it("starts in the first stage of its mode and records stage changes in the transcript", () => {
    assert.equal(DebateSession.create(root, "Idee", settings, { mode: "wild" }).state.stage, "brainstorm");

    const session = DebateSession.create(root, "Tema", settings);
    assert.deepEqual([session.state.mode, session.state.stage], ["structured", "explore"]);
    session.emit({ type: "debaters_selected", debaters: [debaterConfig("alpha")] });
    session.emit({ type: "speech", speakerId: USER_ID, text: "Voglio i numeri", replyTo: [] });
    session.emit({ type: "stage_changed", stage: "critique", text: "Si passa alla critica" });

    const { state } = session;
    assert.deepEqual([state.stage, state.stageStartedTurn], ["critique", 1]);
    assert.deepEqual(
      state.messages.map((message) => [nameOf(state, message.speakerId), message.text]),
      [
        ["Committente", "Voglio i numeri"],
        ["Moderatore", "Si passa alla critica"],
      ],
    );
    assert.deepEqual(DebateSession.open(session.dir).state, state);
  });

  it("keeps the focal points of the summary", () => {
    const session = DebateSession.create(root, "Tema", settings);
    session.emit({ type: "moderator_message", kind: "summary", text: "Lungo", inShort: "Breve", focalPoints: ["Uno", "Due"] });
    assert.deepEqual(session.state.summary, { text: "Lungo", inShort: "Breve", focalPoints: ["Uno", "Due"] });
  });
});
