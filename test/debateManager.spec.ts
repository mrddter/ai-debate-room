import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { DebateManager, type DebateManagerOptions, type DebaterSelection } from "../src/lib/debateManager";
import { renderDebaterModule, type GeneratedDebater } from "../src/lib/debaterFiles";
import { debateConfig, type AgentConfig } from "../src/lib/debateConfig";
import { DebateSession, readEvents } from "../src/lib/session/session";
import { replay } from "../src/lib/session/state";
import { USER_ID, type DebateEvent } from "../src/lib/session/events";
import { hangUntilAborted, mockAgentFactory, type MockCall, type MockReply } from "./helpers/mockModel";
import { debaterConfig, LIB_DIR, tempDir } from "./helpers/fixtures";

const REPORT_URL = "https://example.com/report";
const LONG_POINT = Array.from({ length: 50 }, (_, index) => `parola${index}`).join(" ");

function generated(id: string, tools: GeneratedDebater["tools"]): GeneratedDebater {
  return { id, name: id.toUpperCase(), description: `${id} desc`, skills: [], whenToUse: "", instructions: `Sei ${id}.`, tools };
}

interface TableOptions {
  readyAtTurn?: number;
  newDebaters?: object[];
  onSpeech?: (call: MockCall, count: number) => Promise<string | MockReply> | undefined;
}

// A scripted table: each prompt kind is recognized by a marker of src/lib/prompts.ts
function scriptedTable(options: TableOptions = {}) {
  const readyAt = options.readyAtTurn ?? 4;
  let routings = 0;
  let speeches = 0;
  const section = (prompt: string, from: string, to: string) => prompt.slice(prompt.indexOf(from), prompt.indexOf(to));

  return (call: MockCall): string | MockReply | Promise<string | MockReply> => {
    const prompt = call.prompt;
    if (prompt.includes("REGOLE PER LA SELEZIONE")) {
      const debaters = [
        { id: "alpha", reason: "a" },
        { id: "ghost", reason: "non esiste" },
        ...(prompt.includes("FEEDBACK") || !options.newDebaters ? [{ id: "beta", reason: "b" }] : []),
        ...(prompt.includes("FEEDBACK") ? [{ id: "esperto_nuovo", reason: "tenuto" }] : []),
      ];
      return JSON.stringify({ debaters, newDebaters: prompt.includes("FEEDBACK") ? [] : options.newDebaters, moderatorMessage: "Proposta" });
    }
    if (prompt.includes("Il dibattito sta per iniziare")) return "Benvenuti al tavolo";
    if (prompt.includes("Deve alzare la mano")) {
      const id = prompt.match(/\(ID (\w+)\)/)![1];
      const pitch = `${id} vuole parlare di un tema molto importante che richiede davvero troppe parole per stare nel limite`;
      return JSON.stringify({ raise: true, kind: "nuovo_punto", pitch, target: id });
    }
    if (prompt.includes("CODA DELLE MANI ALZATE")) {
      routings++;
      const pending = [...section(prompt, "PROPOSTE IN ATTESA", "CODA DELLE MANI").matchAll(/- \[(W\d+)\]/g)].map((m) => m[1]);
      const queue = [...section(prompt, "CODA DELLE MANI", "PARTECIPANTI:").matchAll(/^- (\w+) \(/gm)].map((m) => m[1]);
      // The first pick names someone who is not at the table: the manager must fall back
      const next = routings === 1 ? "ghost" : (queue[0] ?? "alpha");
      return JSON.stringify({
        whiteboardOps: pending.map((id) => ({ op: "accept", id, kind: "note", text: "", url: "", to: "" })),
        nextSpeakerId: next,
        source: "queue",
        reason: "coda",
        transition: `Parola a ${next}`,
      });
    }
    if (prompt.includes("Prima di intervenire puoi verificare")) {
      return { text: `Dato chiave: ${REPORT_URL}`, sources: [{ url: REPORT_URL, title: "Report" }] };
    }
    if (prompt.includes("È il tuo turno")) {
      speeches++;
      const custom = options.onSpeech?.(call, speeches);
      if (custom) return custom;
      const id = prompt.match(/Sei .+? \(ID (\w+)\)/)![1];
      return JSON.stringify({
        text: `Intervento ${speeches} di ${id}`,
        replyTo: ["moderator", id, "nobody"],
        notebook: `Taccuino di ${id} al turno ${speeches}`,
        proposals: [
          { kind: "decision", text: `Decisione ${speeches}`, url: "" },
          { kind: "source", text: "Report", url: `${REPORT_URL}/` },
          { kind: "source", text: "Inventata", url: "https://invented.example/x" },
          { kind: "note", text: "Oltre il limite di tre", url: "" },
        ],
      });
    }
    if (prompt.includes("Valuta se la fase attuale è giunta")) {
      const turn = Number(prompt.match(/Interventi finora: (\d+)/)![1]);
      return JSON.stringify({ isReady: turn >= readyAt, reason: `turno ${turn}`, maturityDegree: turn >= readyAt ? 5 : 2 });
    }
    if (prompt.includes("Fai un sunto neutrale")) {
      // Nine points, the first far over the word limit: the manager must cap both
      const focalPoints = [LONG_POINT, ...Array.from({ length: 8 }, (_, index) => `Punto ${index + 2}`)];
      return JSON.stringify({ summary: "Sintesi estesa", inShort: "Esito in breve", focalPoints });
    }
    throw new Error(`Unexpected prompt: ${prompt.slice(0, 160)}`);
  };
}

describe("debate manager (mock models)", function () {
  let root: string;
  let debatersDir: string;
  let calls: MockCall[];
  let messages: string[];

  beforeEach(() => {
    root = tempDir("debate-e2e");
    debatersDir = tempDir("debate-e2e-debaters");
    calls = [];
    messages = [];
    fs.writeFileSync(path.join(debatersDir, "alpha.ts"), renderDebaterModule(generated("alpha", ["calculator"]), LIB_DIR));
    fs.writeFileSync(path.join(debatersDir, "beta.ts"), renderDebaterModule(generated("beta", ["webSearch"]), LIB_DIR));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(debatersDir, { recursive: true, force: true });
  });

  function manager(table: ReturnType<typeof scriptedTable>, options: Partial<DebateManagerOptions> = {}) {
    const instance = new DebateManager({
      agentFactory: mockAgentFactory(table, calls),
      artifactsRoot: root,
      debatersDir,
      ...options,
      settings: { maxTurns: 10, maxCostUsd: 0, ...options.settings },
    });
    instance.setOnMessage((msg) => {
      messages.push(msg);
    });
    const finished = new Promise<void>((resolve) => instance.setOnFinished(resolve));
    return { instance, finished };
  }

  const eventsOf = (instance: DebateManager): DebateEvent[] => readEvents(path.join(root, instance.state!.debateId, "events.jsonl"));
  const ofType = <T extends DebateEvent["type"]>(events: DebateEvent[], type: T) =>
    events.filter((event): event is Extract<DebateEvent, { type: T }> => event.type === type);

  it("runs a full debate: hands, routing, research, board, judges, summary", async () => {
    const { instance, finished } = manager(scriptedTable());
    let proposed: DebaterSelection[] = [];
    instance.setOnSelectionRequired((selection) => {
      proposed = selection;
    });

    await instance.startDebate("Tema di prova");
    assert.equal(instance.status, "ASKING_SELECTION_PREFERENCE");
    await instance.handleSelectionPreferenceInput("mod");
    assert.deepEqual(
      proposed.map((entry) => entry.id),
      ["alpha", "beta"],
      "unknown ids are dropped",
    );
    await instance.handleDebaterSelectionInput("ok");
    await finished;

    const state = instance.state!;
    const events = eventsOf(instance);
    assert.equal(instance.status, "FINISHED");
    assert.equal(state.finishReason, "judges");
    assert.equal(state.turn, 8);

    // Stages: the judges close one stage per vote once the table is ready, the last one ends the debate
    assert.deepEqual(
      ofType(events, "stage_changed").map((event) => [event.stage, event.turn]),
      [
        ["critique", 4],
        ["decide", 6],
      ],
    );
    assert.ok(messages.some((msg) => msg.includes("Si passa alla fase di critica.")));

    // Floor: invalid first pick falls back, then the queue drives; nobody speaks twice in a row
    const floors = ofType(events, "floor_given").map((event) => [event.speakerId, event.source]);
    assert.deepEqual(floors[0], ["alpha", "fallback"]);
    assert.deepEqual(
      floors.slice(1),
      Array.from({ length: 7 }, (_, index) => [index % 2 === 0 ? "beta" : "alpha", "queue"]),
    );
    assert.equal(messages.filter((msg) => msg.includes("Parola a ghost")).length, 0, "a fallback hides the wrong transition");

    // Hands: pitch capped at 12 words, self-targets dropped
    for (const hand of ofType(events, "hand_raised")) {
      assert.ok(hand.pitch.split(" ").length <= 12);
      assert.equal(hand.target, undefined);
    }

    // Speech: only valid addressees, notebook kept per debater
    for (const speech of ofType(events, "speech")) assert.deepEqual(speech.replyTo, ["moderator"]);
    assert.equal(state.notebooks.alpha, "Taccuino di alpha al turno 7");

    // Board: max three proposals, sources only with a retrieved URL, moderator ratification
    const urls = state.board.items.filter((item) => item.kind === "source").map((item) => item.url);
    assert.deepEqual(urls, Array(4).fill(`${REPORT_URL}/`));
    assert.ok(!state.board.items.some((item) => /Inventata|Oltre il limite/.test(item.text)));
    // Per speech: alpha cites two unretrieved sources, beta one
    assert.equal(ofType(events, "error").filter((event) => event.scope === "proposal").length, 12);
    assert.ok(state.board.items.filter((item) => item.status === "accepted").length >= 3);
    assert.equal(state.boardRejections.length, 0);

    // Tools: web tools only in the free-text research call, local tools in structured calls
    const research = calls.filter((call) => call.prompt.includes("Prima di intervenire"));
    assert.equal(research.length, 4);
    assert.ok(research.every((call) => call.agentId === "beta" && call.tools.includes("web_search") && !call.structured));
    const betaSpeeches = calls.filter((call) => call.agentId === "beta" && call.prompt.includes("È il tuo turno"));
    assert.ok(betaSpeeches.every((call) => !call.tools.includes("web_search") && call.tools.includes("calculator")));
    assert.ok(calls.filter((call) => call.prompt.includes("CODA DELLE MANI")).every((call) => call.tools.length === 0));
    assert.ok(betaSpeeches.every((call) => call.prompt.includes(`Report: ${REPORT_URL}`)));

    // Judges: once per round of two speeches inside each stage, every enabled judge each time
    assert.equal(ofType(events, "judge_verdict").length, debateConfig.judges.filter((judge) => judge.enabled).length * 4);

    // Accounting and durability: one usage record per model call, the log rebuilds the state
    assert.equal(state.usage.total.calls, calls.length);
    assert.deepEqual(replay(events), state);
    for (const file of ["topic.md", "chat.md", "whiteboard.md", "sunto-finale.md", "viewer.html"]) {
      assert.ok(fs.existsSync(path.join(root, state.debateId, file)), `${file} missing`);
    }

    // Focal points: at most seven, each cut at 35 words, numbered under the short summary
    const focalPoints = state.summary!.focalPoints;
    assert.equal(focalPoints.length, 7);
    assert.equal(focalPoints[0].split(" ").length, 35);
    assert.ok(messages.some((msg) => msg.includes("(Sunto Finale)]**\n\nEsito in breve\n\n**Punti focali**\n1. parola0 ")));
    assert.match(fs.readFileSync(path.join(root, state.debateId, "sunto-finale.md"), "utf8"), /## Punti focali\n1\. parola0[\s\S]*\n7\. Punto 7\n/);
    assert.ok(messages.at(-1)?.startsWith("📁 Artefatti salvati in"));
  });

  it("keeps one append-only transcript with cache breakpoints only on stable blocks", async () => {
    const { instance, finished } = manager(scriptedTable({ readyAtTurn: 2 }));
    await instance.startDebate("Tema in cache", "wild");
    await instance.handleSelectionPreferenceInput("mod");
    await instance.handleDebaterSelectionInput("ok");
    await finished;

    const chained = calls.filter((call) => call.parts.length > 1);
    assert.ok(chained.length >= 10, "every debate call after the intro sends the transcript as blocks");
    for (const [index, call] of chained.entries()) {
      const blocks = call.parts.slice(0, -1);
      // Breakpoints: the last block and the fixed checkpoint below it, never the tail that changes every call
      const last = blocks.length - 1;
      assert.deepEqual(call.cached, [...new Set([last - (last % 10), last])]);
      // Prefix: whatever an earlier call sent is sent again unchanged, so the cache can serve it
      const previous = chained[index - 1]?.parts.slice(0, -1) ?? [];
      assert.deepEqual(blocks.slice(0, previous.length), previous, `call ${index} rewrote the transcript`);
    }

    // Cost: the usage of every call is priced on uncached, cache read and cache write tokens
    const opusCall = ofType(eventsOf(instance), "llm_usage").find((event) => event.model === "claude-opus-5-5")!;
    assert.deepEqual([opusCall.cachedInputTokens, opusCall.cacheWriteTokens], [60, 30]);
    // 10 uncached x 4 + 60 read x 0.2 + 30 written (1h) x 4 x 2 + 20 out x 20, per million tokens
    assert.equal(opusCall.costUsd.toFixed(6), "0.000692");
  });

  it("stops at the spend cap after one warning and closes with the summary", async () => {
    // About $0.002 per mock turn: the 80% window spans more than one turn, so the warning cannot be skipped
    const { instance, finished } = manager(scriptedTable({ readyAtTurn: 99 }), { settings: { maxCostUsd: 0.02, maxTurns: 50 } });
    await instance.startDebate("Tema costoso");
    await instance.handleSelectionPreferenceInput("mod");
    await instance.handleDebaterSelectionInput("ok");
    await finished;

    const state = instance.state!;
    assert.equal(state.finishReason, "budget");
    assert.ok(state.turn > 0 && state.turn < 50);
    assert.ok(state.usage.total.costUsd >= 0.02);
    assert.equal(messages.filter((msg) => msg.startsWith("⚠️ Spesa stimata")).length, 1);
    assert.ok(messages.some((msg) => msg.includes("si è concluso per il budget di spesa")));
    assert.equal(state.summary?.inShort, "Esito in breve");
  });

  it("refuses a budget it cannot price", async () => {
    const unpriced = debaterConfig("beta", { model: { provider: "ollama", model: "llama-locale" } });
    const crashed = DebateSession.create(root, "Tema", { maxTurns: 10, maxCostUsd: 1, judgeEvery: 0 });
    crashed.emit({ type: "debaters_selected", debaters: [debaterConfig("alpha"), unpriced] });

    const { instance, finished } = manager(scriptedTable(), { settings: { maxCostUsd: 1 } });
    assert.equal(await instance.resume(), true);
    await finished;
    assert.equal(instance.state!.finishReason, "error");
    assert.ok(messages.some((msg) => msg.includes("senza prezzo per llama-locale")));
    assert.equal(calls.length, 0, "nothing is spent before the check");
  });

  it("gives the floor to the user, with the text of the raised hand, a text sent later, or nothing", async () => {
    let instance!: DebateManager;
    const hands: string[] = [];
    const table = scriptedTable({
      readyAtTurn: 8,
      onSpeech: (_, count) => {
        if (count === 1) hands.push(instance.raiseUserHand("  Servono numeri veri  "));
        if (count === 3 || count === 4) hands.push(instance.raiseUserHand());
        return undefined;
      },
    });
    const run = manager(table, { userSpeechTimeoutMs: 50 });
    instance = run.instance;
    let floors = 0;
    const replies: string[] = [];
    instance.setOnMessage((msg) => {
      messages.push(msg);
      // First time the user speaks through the chat; the second time they stay silent
      if (msg.startsWith("🎤 La parola a te") && ++floors === 1) {
        replies.push(instance.raiseUserHand());
        assert.equal(instance.awaitingUserSpeech, true);
        assert.equal(instance.submitUserSpeech("Detto in chat"), true);
      }
    });

    assert.equal(instance.raiseUserHand("prima del via"), "not_running");
    await instance.startDebate("Tema con committente", "wild");
    await instance.handleSelectionPreferenceInput("mod");
    await instance.handleDebaterSelectionInput("ok");
    await run.finished;

    const events = eventsOf(instance);
    assert.deepEqual(hands, ["queued", "queued", "queued"]);
    assert.deepEqual(replies, ["has_floor"]);
    assert.deepEqual(
      ofType(events, "speech")
        .filter((event) => event.speakerId === USER_ID)
        .map((event) => event.text),
      ["Servono numeri veri", "Detto in chat"],
    );
    assert.equal(ofType(events, "floor_given").filter((event) => event.speakerId === USER_ID).length, 3);
    assert.equal(messages.filter((msg) => msg === "Nessun intervento dal committente, si prosegue.").length, 1);
    assert.ok(messages.includes("**[Committente]**\n\nServono numeri veri"));
    // The moderator is told, and its transition naming someone else is not shown
    const routings = calls.filter((call) => call.prompt.includes("IL COMMITTENTE HA CHIESTO LA PAROLA"));
    assert.equal(routings.length, 3);
    assert.equal(instance.awaitingUserSpeech, false);
  });

  it("generates smart debaters, keeps them across feedback and writes them on confirm", async () => {
    const newDebater = {
      id: "esperto_nuovo!",
      name: "Esperto Nuovo",
      reason: "manca",
      skills: ["x"],
      whenToUse: "sempre",
      description: "nuovo",
      instructions: 'Dice "cose" con `backtick`',
      tools: ["webFetch"],
    };
    const { instance, finished } = manager(scriptedTable({ newDebaters: [newDebater] }));
    const rounds: { selection: DebaterSelection[]; candidates: AgentConfig[] }[] = [];
    instance.setOnSelectionRequired((selection, candidates) => rounds.push({ selection, candidates }));

    await instance.startDebate("Tema smart");
    await instance.handleSelectionPreferenceInput("smart");
    assert.deepEqual(
      rounds[0].selection.map((entry) => entry.id),
      ["alpha", "esperto_nuovo"],
    );
    assert.ok(rounds[0].candidates.some((candidate) => candidate.name === "Esperto Nuovo"));
    assert.ok(!fs.existsSync(path.join(debatersDir, "esperto_nuovo.ts")), "nothing is written before confirmation");

    await instance.handleDebaterSelectionInput("aggiungi 2");
    assert.deepEqual(
      rounds[1].selection.map((entry) => entry.id),
      ["alpha", "beta", "esperto_nuovo"],
    );
    const feedbackPrompt = calls.filter((call) => call.prompt.includes("FEEDBACK")).at(-1)!.prompt;
    assert.match(feedbackPrompt, /INDICE: \d+ \| ID: esperto_nuovo/, "the prompt lists what the user saw");

    await instance.handleDebaterSelectionInput("conferma");
    await instance.stopDebate();
    await finished;

    const file = path.join(debatersDir, "esperto_nuovo.ts");
    assert.ok(fs.existsSync(file));
    assert.match(fs.readFileSync(file, "utf8"), /instructions: "Dice \\"cose\\" con `backtick`" \+ " " \+ addendum,/);
    const selected = ofType(eventsOf(instance), "debaters_selected")[0].debaters;
    assert.deepEqual(selected.find((debater) => debater.id === "esperto_nuovo")?.tools, ["webFetch"]);
  });

  it("stops a running debate, aborting the call in flight, and still writes the summary", async () => {
    let secondSpeech!: () => void;
    const secondSpeechStarted = new Promise<void>((resolve) => (secondSpeech = resolve));
    const table = scriptedTable({
      onSpeech: (call, count) => {
        if (count < 2) return undefined;
        secondSpeech();
        return hangUntilAborted(call.abortSignal);
      },
    });
    const { instance, finished } = manager(table);
    await instance.startDebate("Tema da fermare");
    await instance.handleSelectionPreferenceInput("mod");
    await instance.handleDebaterSelectionInput("ok");
    await secondSpeechStarted;

    await instance.stopDebate();
    await finished;
    const state = instance.state!;
    assert.equal(instance.status, "FINISHED");
    assert.equal(state.finishReason, "user_stop");
    assert.equal(state.turn, 1);
    assert.equal(state.summary?.inShort, "Esito in breve");
    assert.equal(eventsOf(instance).at(-1)?.type, "debate_finished");
    assert.ok(messages.some((msg) => msg.includes("DIBATTITO INTERROTTO")));
    // A second /stop is harmless
    await instance.stopDebate();
  });

  it("refuses to start without a topic", async () => {
    const { instance } = manager(scriptedTable());
    await assert.rejects(instance.startDebate("  \n "), /needs a topic/);
    assert.equal(instance.status, "IDLE");
    assert.deepEqual(fs.readdirSync(root), []);
    assert.equal(calls.length, 0);
  });

  it("cancels during selection without a debate", async () => {
    const { instance, finished } = manager(scriptedTable());
    await instance.startDebate("Tema annullato");
    await instance.stopDebate();
    await finished;
    assert.equal(instance.status, "IDLE");
    const events = eventsOf(instance);
    assert.deepEqual(
      events.map((event) => event.type),
      ["debate_started", "debate_finished"],
    );
    assert.equal(DebateSession.findUnfinished(root), null);
  });

  it("resumes a crashed debate from its log, with the limits configured now", async () => {
    // Wild mode has a single stage: the first ready vote ends the debate. The old cap of 3 would stop it a speech earlier
    const crashed = DebateSession.create(root, "Tema ripreso", { maxTurns: 3, maxCostUsd: 0, judgeEvery: 0 }, { mode: "wild" });
    crashed.emit({ type: "debaters_selected", debaters: [debaterConfig("alpha"), debaterConfig("beta")] });
    crashed.emit({ type: "moderator_message", kind: "intro", text: "Intro originale" });
    crashed.emit({ type: "floor_given", speakerId: "alpha", source: "called", reason: "inizio" });
    crashed.emit({ type: "speech", speakerId: "alpha", text: "Prima del crash", replyTo: [] });

    const { instance, finished } = manager(scriptedTable());
    assert.equal(await instance.resume(), true);
    await finished;

    const state = instance.state!;
    const events = readEvents(crashed.eventsFile);
    assert.equal(state.finishReason, "judges");
    assert.deepEqual(
      ofType(events, "speech").map((event) => event.speakerId),
      ["alpha", "beta", "alpha", "beta"],
    );
    assert.deepEqual(ofType(events, "settings_changed").map((event) => event.settings.maxTurns), [10]);
    assert.ok(messages.some((msg) => msg.includes("Limiti aggiornati: budget $0.00, massimo 10 interventi")));
    assert.equal(state.messages.filter((message) => message.text === "Intro originale").length, 1);
    assert.equal(calls.filter((call) => call.prompt.includes("Il dibattito sta per iniziare")).length, 0, "no second intro");
    assert.deepEqual(
      events.map((event) => event.seq),
      events.map((_, index) => index + 1),
    );
    assert.equal(await manager(scriptedTable()).instance.resume(), false, "nothing left to resume");
  });
});
