import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { DebateManager, type DebaterSelection } from "../src/lib/debateManager";
import { renderDebaterModule, type GeneratedDebater } from "../src/lib/debaterFiles";
import { debateConfig, type AgentConfig } from "../src/lib/debateConfig";
import { DebateSession, readEvents } from "../src/lib/session/session";
import { replay } from "../src/lib/session/state";
import type { DebateEvent } from "../src/lib/session/events";
import { hangUntilAborted, mockAgentFactory, type MockCall, type MockReply } from "./helpers/mockModel";
import { debaterConfig, LIB_DIR, tempDir } from "./helpers/fixtures";

const REPORT_URL = "https://example.com/report";

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
      const queue = [...section(prompt, "CODA DELLE MANI", "ULTIMI MESSAGGI").matchAll(/^- (\w+) \(/gm)].map((m) => m[1]);
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
    if (prompt.includes("Valuta se il dibattito è giunto")) {
      const turn = Number(prompt.match(/Interventi finora: (\d+)/)![1]);
      return JSON.stringify({ isReady: turn >= readyAt, reason: `turno ${turn}`, maturityDegree: turn >= readyAt ? 5 : 2 });
    }
    if (prompt.includes("Fai un sunto neutrale")) return JSON.stringify({ summary: "Sintesi estesa", inShort: "Esito in breve" });
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

  function manager(table: ReturnType<typeof scriptedTable>) {
    const instance = new DebateManager({
      agentFactory: mockAgentFactory(table, calls),
      artifactsRoot: root,
      debatersDir,
      settings: { maxTurns: 10 },
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
    assert.equal(state.turn, 4);

    // Floor: invalid first pick falls back, then the queue drives; nobody speaks twice in a row
    assert.deepEqual(
      ofType(events, "floor_given").map((event) => [event.speakerId, event.source]),
      [
        ["alpha", "fallback"],
        ["beta", "queue"],
        ["alpha", "queue"],
        ["beta", "queue"],
      ],
    );
    assert.equal(messages.filter((msg) => msg.includes("Parola a ghost")).length, 0, "a fallback hides the wrong transition");

    // Hands: pitch capped at 12 words, self-targets dropped
    for (const hand of ofType(events, "hand_raised")) {
      assert.ok(hand.pitch.split(" ").length <= 12);
      assert.equal(hand.target, undefined);
    }

    // Speech: only valid addressees, notebook kept per debater
    for (const speech of ofType(events, "speech")) assert.deepEqual(speech.replyTo, ["moderator"]);
    assert.equal(state.notebooks.alpha, "Taccuino di alpha al turno 3");

    // Board: max three proposals, sources only with a retrieved URL, moderator ratification
    const urls = state.board.items.filter((item) => item.kind === "source").map((item) => item.url);
    assert.deepEqual(urls, [`${REPORT_URL}/`, `${REPORT_URL}/`]);
    assert.ok(!state.board.items.some((item) => /Inventata|Oltre il limite/.test(item.text)));
    assert.equal(ofType(events, "error").filter((event) => event.scope === "proposal").length, 6);
    assert.ok(state.board.items.filter((item) => item.status === "accepted").length >= 3);
    assert.equal(state.boardRejections.length, 0);

    // Tools: web tools only in the free-text research call, local tools in structured calls
    const research = calls.filter((call) => call.prompt.includes("Prima di intervenire"));
    assert.equal(research.length, 2);
    assert.ok(research.every((call) => call.agentId === "beta" && call.tools.includes("web_search") && !call.structured));
    const betaSpeeches = calls.filter((call) => call.agentId === "beta" && call.prompt.includes("È il tuo turno"));
    assert.ok(betaSpeeches.every((call) => !call.tools.includes("web_search") && call.tools.includes("searchTranscript")));
    assert.ok(calls.filter((call) => call.prompt.includes("CODA DELLE MANI")).every((call) => call.tools.includes("searchTranscript")));
    assert.ok(betaSpeeches.every((call) => call.prompt.includes(`Report: ${REPORT_URL}`)));

    // Judges: once per round of two speeches, three judges each
    assert.equal(ofType(events, "judge_verdict").length, debateConfig.judges.filter((judge) => judge.enabled).length * 2);

    // Accounting and durability: one usage record per model call, the log rebuilds the state
    assert.equal(state.usage.total.calls, calls.length);
    assert.deepEqual(replay(events), state);
    for (const file of ["topic.md", "chat.md", "whiteboard.md", "sunto-finale.md", "viewer.html"]) {
      assert.ok(fs.existsSync(path.join(root, state.debateId, file)), `${file} missing`);
    }
    assert.ok(messages.some((msg) => msg.endsWith("(Sunto Finale)]**\n\nEsito in breve")));
    assert.ok(messages.at(-1)?.startsWith("📁 Artefatti salvati in"));
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
      tools: ["webFetch", "teleport"],
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

  it("resumes a crashed debate from its log", async () => {
    const crashed = DebateSession.create(root, "Tema ripreso", { maxTurns: 10, contextWindow: 8, judgeEvery: 0 });
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
    assert.equal(state.messages.filter((message) => message.text === "Intro originale").length, 1);
    assert.equal(calls.filter((call) => call.prompt.includes("Il dibattito sta per iniziare")).length, 0, "no second intro");
    assert.deepEqual(
      events.map((event) => event.seq),
      events.map((_, index) => index + 1),
    );
    assert.equal(await manager(scriptedTable()).instance.resume(), false, "nothing left to resume");
  });
});
