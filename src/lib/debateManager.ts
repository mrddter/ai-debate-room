import * as path from "path";
import type { ToolsInput } from "@mastra/core/agent";
import type { z } from "zod";
import { debateConfig, type AgentConfig } from "./debateConfig";
import { createCoreAgents, createDebaterAgents, type AgentFactory, type CoreAgents, type SessionAgent } from "./agents";
import {
  DEBATERS_DIR,
  generatedToConfig,
  loadDebaterConfigs,
  sanitizeDebaterId,
  writeDebaterModule,
  type GeneratedDebater,
} from "./debaterFiles";
import { generateObject, generateText, type CallOptions, type TextResult } from "./llm";
import { hasPrice } from "./pricing";
import {
  handPrompt,
  introPrompt,
  judgePrompt,
  researchPrompt,
  routingPrompt,
  selectionPrompt,
  speechPrompt,
  stageAnnouncement,
  summaryPrompt,
  type SelectionMode,
} from "./prompts";
import {
  debaterSelectionSchema,
  handSchema,
  judgeOutputSchema,
  moderatorTurnSchema,
  speechSchema,
  summarySchema,
} from "./schemas";
import type { ModelConfig } from "./volcanicAI";
import { createVolcanicAgent } from "./volcanicAI";
import {
  MODERATOR_ID,
  USER_ID,
  type DebateEventBody,
  type DebateMode,
  type DebateStage,
  type FinishReason,
  type HandKind,
  type LlmPurpose,
  type SessionSettings,
} from "./session/events";
import {
  budgetSpent,
  chooseSpeaker,
  cleanBoardOp,
  judgesDue,
  nextStage,
  normalizeUrl,
  stageConcluded,
  truncateWords,
  type Verdict,
} from "./session/rules";
import { usd } from "./session/projections";
import { DebateSession } from "./session/session";
import { nameOf, type DebateState } from "./session/state";
import { renderBoard, type BoardOp } from "./session/whiteboard";
import { buildTools, WEB_TOOL_KEYS, type ToolKey } from "../mcp/index";

export type DebateStatus = "IDLE" | "ASKING_SELECTION_PREFERENCE" | "SELECTING_DEBATERS" | "RUNNING" | "FINISHED";

// queued: hand in the queue; submitted: the text became the speech the debate was waiting for;
// has_floor: the debate already waits for the user's speech; not_running: no debate to join
export type UserHandResult = "queued" | "submitted" | "has_floor" | "not_running";

export interface DebaterSelection {
  id: string;
  reason: string;
}

export interface DebateManagerOptions {
  agentFactory?: AgentFactory;
  artifactsRoot?: string;
  debatersDir?: string;
  settings?: Partial<SessionSettings>;
  // How long the debate waits for the user's speech once they have the floor
  userSpeechTimeoutMs?: number;
}

type SelectionResult = z.infer<typeof debaterSelectionSchema>;
type MessageListener = (msg: string) => void | Promise<void>;

const MAX_PITCH_WORDS = 12;
const MAX_PROPOSALS = 3;
const MAX_MODERATOR_OPS = 12;
const MAX_NOTEBOOK_CHARS = 2_000;
const RESEARCH_STEPS = 3;
const NO_RESEARCH = "NESSUNA RICERCA";
const AUTO_SELECTION_WORDS = ["mod", "automatico", "procedi", "ok"];
const CONFIRM_WORDS = ["conferma", "ok"];
const USER_SPEECH_TIMEOUT_MS = 10 * 60_000;
const USER_PITCH = "chiede la parola";
// About 250 words in total: readable in one or two minutes
const MAX_FOCAL_POINTS = 7;
const MAX_FOCAL_WORDS = 35;
const BUDGET_WARNING_SHARE = 0.8;

const FINISH_NOTES: Record<FinishReason, string> = {
  judges: "",
  max_turns: " per il limite di interventi",
  budget: " per il budget di spesa",
  user_stop: " anticipatamente",
  error: " per un errore",
};

const HAND_LABELS: Record<HandKind, string> = {
  replica: "replica",
  nuovo_punto: "nuovo punto",
  domanda: "domanda",
  dato: "dato",
};

class StopRequested extends Error {
  constructor() {
    super("Debate stopped by the user");
  }
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Someone a debater can address: a debater at the table or the user
const isParticipant = (state: DebateState, id: string | undefined) => id === USER_ID || state.debaters.some((d) => d.id === id);

// The model is asked for 3 to 7 short points; the cap keeps the list readable even when it ignores that
function focalPointsOf(points: string[]): string[] {
  return points
    .map((point) => truncateWords(point, MAX_FOCAL_WORDS))
    .filter(Boolean)
    .slice(0, MAX_FOCAL_POINTS);
}

/**
 * Drives one debate at a time. Every state change goes through DebateSession.emit, so the event log
 * alone can rebuild the debate (resume, replay, projections); this class only orchestrates LLM calls.
 */
export class DebateManager {
  private currentStatus: DebateStatus = "IDLE";
  private session: DebateSession | null = null;
  private core: CoreAgents | null = null;
  private debaters = new Map<string, SessionAgent>();
  private available: AgentConfig[] = [];
  // Debaters generated in smart mode: written to disk only when the user confirms the selection
  private generated = new Map<string, GeneratedDebater>();
  private selection: DebaterSelection[] = [];
  private selectionMessage?: string;
  private abort = new AbortController();
  private stopRequested = false;
  // One selection request at a time: user input while a proposal is in flight is ignored
  private busy = false;
  private loop: Promise<void> | null = null;
  private outbox: Promise<void> = Promise.resolve();
  // Text sent with /hand: it becomes the user's speech when they get the floor (lost on restart, then asked again)
  private pendingUserText: string | null = null;
  // Set while the debate waits for the user's speech
  private deliverUserSpeech: ((text: string | null) => void) | null = null;
  private budgetWarned = false;

  private onMessageCallback?: MessageListener;
  private onFinishedCallback?: () => void;
  private onSelectionRequiredCallback?: (
    selection: DebaterSelection[],
    allAvailable: AgentConfig[],
    moderatorMessage?: string,
  ) => void;
  private onPreferenceAskedCallback?: (allAvailable: AgentConfig[]) => void;

  constructor(private readonly options: DebateManagerOptions = {}) {}

  public setOnMessage(cb: MessageListener) {
    this.onMessageCallback = cb;
  }
  public setOnFinished(cb: () => void) {
    this.onFinishedCallback = cb;
  }
  public setOnSelectionRequired(
    cb: (selection: DebaterSelection[], allAvailable: AgentConfig[], moderatorMessage?: string) => void,
  ) {
    this.onSelectionRequiredCallback = cb;
  }
  public setOnPreferenceAsked(cb: (allAvailable: AgentConfig[]) => void) {
    this.onPreferenceAskedCallback = cb;
  }

  get status(): DebateStatus {
    return this.currentStatus;
  }
  get state(): DebateState | null {
    return this.session?.state ?? null;
  }
  get topic(): string | null {
    return this.session?.state.topic ?? null;
  }
  get turnCount(): number {
    return this.session?.state.turn ?? 0;
  }
  get whiteboard(): string {
    const state = this.session?.state;
    return state ? renderBoard(state.board, (id) => nameOf(state, id)) : "Lavagna vuota.";
  }
  get isActive(): boolean {
    return ["ASKING_SELECTION_PREFERENCE", "SELECTING_DEBATERS", "RUNNING"].includes(this.currentStatus);
  }
  get awaitingUserSpeech(): boolean {
    return this.deliverUserSpeech !== null;
  }

  private get factory(): AgentFactory {
    return this.options.agentFactory ?? createVolcanicAgent;
  }
  private get artifactsRoot(): string {
    return this.options.artifactsRoot ?? path.join(process.cwd(), "artifacts");
  }
  private get debatersDir(): string {
    return this.options.debatersDir ?? DEBATERS_DIR;
  }

  public async startDebate(topic: string, mode: DebateMode = "structured") {
    // No default topic: the interface asks the user for one before starting
    if (!topic.trim()) throw new Error("A debate needs a topic");
    if (this.isActive) return;
    this.reset();
    this.currentStatus = "ASKING_SELECTION_PREFERENCE";
    try {
      this.session = DebateSession.create(this.artifactsRoot, topic.trim(), this.currentSettings(), { mode });
      [this.core, this.available] = await Promise.all([createCoreAgents(this.factory), loadDebaterConfigs(this.debatersDir)]);
    } catch (err) {
      this.endWithoutDebate("error", `startup: ${errorMessage(err)}`);
      throw err;
    }
    console.log(`[DebateManager] ${this.available.length} debaters available`);
    this.onPreferenceAskedCallback?.(this.available);
  }

  public async handleSelectionPreferenceInput(input: string) {
    if (this.currentStatus !== "ASKING_SELECTION_PREFERENCE" || this.busy) return;
    const answer = input.trim().toLowerCase();
    let mode: SelectionMode;
    if (answer === "smart") {
      mode = { kind: "smart" };
      this.broadcast(`🧠 Analisi smart dell'argomento... il moderatore proporrà o creerà i partecipanti ideali al volo.`);
    } else if (AUTO_SELECTION_WORDS.includes(answer) || answer.length > 50) {
      mode = { kind: "auto" };
      this.broadcast(`⏳ Valutazione dell'argomento e selezione dei partecipanti ottimali da parte del moderatore...`);
    } else {
      mode = { kind: "direct", input };
      this.broadcast(`⏳ Acquisizione della tua selezione e valutazione da parte del moderatore...`);
    }
    this.currentStatus = "SELECTING_DEBATERS";
    await this.propose(mode);
  }

  public async handleDebaterSelectionInput(input: string) {
    if (this.currentStatus !== "SELECTING_DEBATERS" || this.busy) return;
    if (!CONFIRM_WORDS.includes(input.trim().toLowerCase())) {
      this.broadcast(`🔄 Rielaborazione della selezione in base al tuo feedback...`);
      await this.propose({ kind: "feedback", input });
      return;
    }
    this.broadcast(`✅ Selezione confermata. Inizializzazione in corso...`);
    await this.confirmSelection();
  }

  /** Stops selection right away; a running debate is aborted and closed with the summary before this resolves. */
  public async stopDebate() {
    switch (this.currentStatus) {
      case "IDLE":
      case "FINISHED":
        return;
      case "ASKING_SELECTION_PREFERENCE":
      case "SELECTING_DEBATERS":
        this.stopRequested = true;
        this.abort.abort(new StopRequested());
        this.broadcast("🛑 Selezione annullata.");
        this.endWithoutDebate("user_stop");
        return;
      case "RUNNING":
        if (!this.stopRequested) {
          this.stopRequested = true;
          this.broadcast(`🛑 **DIBATTITO INTERROTTO** 🛑`);
          this.abort.abort(new StopRequested());
        }
        await this.loop;
        return;
      default: {
        const unknownStatus: never = this.currentStatus;
        throw new Error(`Unknown status ${unknownStatus}`);
      }
    }
  }

  /** The user asks for the floor; with a text, that text becomes their speech as soon as they get it. */
  public raiseUserHand(text = ""): UserHandResult {
    const session = this.session;
    if (this.currentStatus !== "RUNNING" || !session || this.stopRequested) return "not_running";
    const clean = text.trim();
    if (this.deliverUserSpeech) {
      if (!clean) return "has_floor";
      this.deliverUserSpeech(clean);
      return "submitted";
    }
    if (clean) this.pendingUserText = clean;
    const pitch = truncateWords(clean, MAX_PITCH_WORDS) || USER_PITCH;
    this.record(session, { type: "hand_raised", debaterId: USER_ID, kind: "nuovo_punto", pitch });
    return "queued";
  }

  /** Delivers the speech the debate is waiting for; false when the user does not have the floor. */
  public submitUserSpeech(text: string): boolean {
    const clean = text.trim();
    if (!this.deliverUserSpeech || !clean) return false;
    this.deliverUserSpeech(clean);
    return true;
  }

  /** Reopens the most recent debate that was running when the process died and continues it from its event log. */
  public async resume(): Promise<boolean> {
    if (this.isActive) return false;
    const dir = DebateSession.findUnfinished(this.artifactsRoot);
    if (!dir) return false;
    this.reset();
    this.currentStatus = "RUNNING";
    try {
      const session = DebateSession.open(dir);
      this.session = session;
      [this.core, this.debaters] = await Promise.all([
        createCoreAgents(this.factory),
        createDebaterAgents(session.state.debaters, this.factory),
      ]);
    } catch (err) {
      this.currentStatus = "IDLE";
      this.session = null;
      throw err;
    }
    const { state } = this.session;
    const settings = this.currentSettings();
    const changed = JSON.stringify(settings) !== JSON.stringify(state.settings);
    if (changed) this.session.emit({ type: "settings_changed", settings });
    const limits = changed ? `\nLimiti aggiornati: budget ${usd(settings.maxCostUsd)}, massimo ${settings.maxTurns} interventi` : "";
    this.broadcast(`♻️ **DIBATTITO RIPRESO** ♻️\n**Tema:** ${state.topic}\nInterventi finora: ${state.turn}${limits}`);
    this.startLoop(this.session);
    return true;
  }

  private currentSettings(): SessionSettings {
    return {
      maxTurns: debateConfig.maxTurns,
      maxCostUsd: debateConfig.maxCostUsd,
      judgeEvery: debateConfig.judgeEvery,
      ...this.options.settings,
    };
  }

  private reset() {
    this.session = null;
    this.core = null;
    this.debaters = new Map();
    this.available = [];
    this.generated = new Map();
    this.selection = [];
    this.selectionMessage = undefined;
    this.abort = new AbortController();
    this.stopRequested = false;
    this.busy = false;
    this.loop = null;
    this.pendingUserText = null;
    this.deliverUserSpeech = null;
    this.budgetWarned = false;
  }

  private broadcast(msg: string) {
    const listener = this.onMessageCallback;
    if (!listener) return;
    // Chained so chat messages keep the order in which they were produced
    this.outbox = this.outbox
      .then(() => listener(msg))
      .catch((err) => console.error("[DebateManager] broadcast failed:", err));
  }

  // Late callbacks of an aborted call may arrive after debate_finished: they are dropped, not logged
  private record(session: DebateSession, body: DebateEventBody) {
    if (session.state.phase !== "finished") session.emit(body);
  }

  private project(session: DebateSession, viewer: boolean) {
    try {
      session.writeProjections({ viewer });
    } catch (err) {
      console.error("[DebateManager] failed to write projections:", err);
    }
  }

  private throwIfStopped() {
    if (this.stopRequested) throw new StopRequested();
  }

  private callOptions(
    session: DebateSession,
    agentId: string,
    model: ModelConfig,
    purpose: LlmPurpose,
    extra: Partial<CallOptions> = {},
  ): CallOptions {
    return {
      agentId,
      purpose,
      model: model.model,
      abortSignal: this.abort.signal,
      onUsage: (usage) => this.record(session, { type: "llm_usage", ...usage }),
      onToolCall: (tool, input) => this.record(session, { type: "tool_call", agentId, tool, input }),
      ...extra,
    };
  }

  private tools(keys: readonly ToolKey[]): ToolsInput | undefined {
    return keys.length > 0 ? buildTools(keys) : undefined;
  }

  private endWithoutDebate(reason: FinishReason, error?: string) {
    const session = this.session;
    if (session) {
      if (error) this.record(session, { type: "error", scope: "selection", message: error });
      this.record(session, { type: "debate_finished", reason });
    }
    this.currentStatus = "IDLE";
    this.notifyFinished(session);
  }

  // Queued behind the outbox: listeners stop delivering once notified, and the last messages are still in flight
  private notifyFinished(session: DebateSession | null) {
    this.outbox = this.outbox.then(() => {
      if (this.session === session) this.onFinishedCallback?.();
    });
  }

  // ----- Selection -----

  // Same order and content the user sees, so the indexes in their answer match the prompt
  private candidates(): AgentConfig[] {
    const generated = [...this.generated.values()].map(generatedToConfig);
    return [...this.available, ...generated].sort((a, b) => a.name.localeCompare(b.name));
  }

  private async propose(mode: SelectionMode) {
    const session = this.session;
    const core = this.core;
    if (!session || !core) return;
    this.busy = true;
    try {
      const { moderator } = core;
      const result = await generateObject(
        moderator.agent,
        selectionPrompt(session.state.topic, this.candidates(), mode),
        debaterSelectionSchema,
        this.callOptions(session, moderator.config.id, moderator.config.model, "selection"),
      );
      if (this.session !== session || session.state.phase === "finished") return;
      this.applySelection(result);
      this.onSelectionRequiredCallback?.(this.selection, this.candidates(), result.moderatorMessage);
    } catch (err) {
      if (this.session !== session || this.stopRequested) return;
      console.error("[DebateManager] debater selection failed:", err);
      this.broadcast("❌ Errore durante la selezione dei debaters. Annullamento.");
      this.endWithoutDebate("error", errorMessage(err));
    } finally {
      if (this.session === session) this.busy = false;
    }
  }

  private applySelection(result: SelectionResult) {
    const existing = new Set(this.available.map((debater) => debater.id));
    const fresh = new Map<string, GeneratedDebater>();
    for (const debater of result.newDebaters ?? []) {
      const id = sanitizeDebaterId(debater.id);
      if (!id || existing.has(id)) {
        console.warn(`[DebateManager] generated debater "${debater.id}" skipped: empty or already existing id`);
        continue;
      }
      fresh.set(id, {
        id,
        name: debater.name,
        description: debater.description,
        skills: debater.skills,
        whenToUse: debater.whenToUse,
        instructions: debater.instructions,
        tools: debater.tools ?? [],
      });
    }

    const pool = new Map([...this.generated, ...fresh]);
    const selection: DebaterSelection[] = [];
    const add = (id: string, reason: string) => {
      if (selection.some((entry) => entry.id === id)) return;
      if (!existing.has(id) && !pool.has(id)) {
        console.warn(`[DebateManager] unknown debater "${id}" dropped from the selection`);
        return;
      }
      selection.push({ id, reason });
    };
    for (const debater of result.debaters) add(debater.id, debater.reason);
    // Smart mode lists freshly generated debaters only in newDebaters: they are part of the proposal
    for (const debater of result.newDebaters ?? []) {
      const id = sanitizeDebaterId(debater.id);
      if (fresh.has(id)) add(id, debater.reason);
    }

    this.generated = new Map([...pool].filter(([id]) => selection.some((entry) => entry.id === id)));
    this.selection = selection;
    this.selectionMessage = result.moderatorMessage;
  }

  private async confirmSelection() {
    const session = this.session;
    if (!session) return;
    this.busy = true;
    try {
      if (this.generated.size > 0) this.broadcast(`⏳ Salvataggio dei nuovi debaters generati su disco...`);
      const configs: AgentConfig[] = [];
      for (const { id } of this.selection) {
        const generated = this.generated.get(id);
        if (generated) {
          const file = writeDebaterModule(generated, this.debatersDir);
          if (file) console.log(`[DebateManager] new debater saved: ${file}`);
          else console.warn(`[DebateManager] debater ${id} not written: invalid id or file already exists`);
          configs.push(generatedToConfig(generated));
          continue;
        }
        const config = this.available.find((debater) => debater.id === id);
        if (config) configs.push(config);
      }
      if (configs.length === 0) {
        this.broadcast("❌ Nessun debater selezionato valido. Annullamento.");
        this.endWithoutDebate("error", "No valid debater selected");
        return;
      }

      const debaters = await createDebaterAgents(configs, this.factory);
      if (this.session !== session || session.state.phase === "finished") return;
      this.debaters = debaters;
      session.emit({ type: "debaters_selected", debaters: configs, moderatorMessage: this.selectionMessage });
      this.currentStatus = "RUNNING";
      this.broadcast(`🎙️ **DIBATTITO AVVIATO** 🎙️\n**Tema:** ${session.state.topic}\n`);
      this.startLoop(session);
    } catch (err) {
      if (this.session !== session || this.stopRequested) return;
      console.error("[DebateManager] debate initialization failed:", err);
      this.broadcast("❌ Errore durante l'inizializzazione del dibattito. Annullamento.");
      this.endWithoutDebate("error", errorMessage(err));
    } finally {
      if (this.session === session) this.busy = false;
    }
  }

  // ----- Debate loop -----

  private startLoop(session: DebateSession) {
    this.loop = this.run(session).catch((err) => console.error("[DebateManager] debate loop crashed:", err));
  }

  private async run(session: DebateSession) {
    let reason: FinishReason;
    try {
      reason = await this.debate(session);
    } catch (err) {
      if (this.stopRequested) {
        reason = "user_stop";
      } else {
        console.error("[DebateManager] critical error during the debate:", err);
        this.record(session, { type: "error", scope: "turn", message: errorMessage(err) });
        this.broadcast(`❌ Errore durante il dibattito: ${errorMessage(err)}`);
        reason = "error";
      }
    }
    await this.finish(session, reason);
  }

  private async debate(session: DebateSession): Promise<FinishReason> {
    const { state } = session;
    this.throwIfStopped();
    this.assertBudgetPriced(state.settings.maxCostUsd);
    if (!state.messages.some((message) => message.kind === "moderator")) await this.intro(session);
    // Fresh start or resume: the table needs hands before the first pick
    if (state.queue.length === 0) await this.raiseHands(session, state.debaters.filter((d) => d.id !== state.lastSpeakerId));

    for (;;) {
      this.throwIfStopped();
      if (state.turn >= state.settings.maxTurns) return "max_turns";
      if (budgetSpent(state)) return "budget";
      this.warnBudget(state);
      const speakerId = await this.giveFloor(session);
      // The user may let the floor go: nothing was said, so no hands and no judges
      if (!(await this.speak(session, speakerId))) continue;
      await this.raiseHands(session, state.debaters.filter((d) => d.id !== speakerId));
      if (judgesDue(state) && (await this.judge(session))) {
        const stage = nextStage(state);
        if (!stage) return "judges";
        this.changeStage(session, stage);
      }
      this.project(session, false);
    }
  }

  // A budget is only as good as its prices: a model without one would spend without being counted
  private assertBudgetPriced(maxCostUsd: number) {
    if (maxCostUsd <= 0) return;
    const { moderator, judges } = this.requireCore();
    const configs = [moderator.config, ...judges.map((judge) => judge.config), ...[...this.debaters.values()].map((d) => d.config)];
    const models = [...configs.map((config) => config.model.model), debateConfig.handModel.model];
    const unpriced = [...new Set(models.filter((model) => !hasPrice(model)))];
    if (unpriced.length > 0) {
      throw new Error(`Budget di ${usd(maxCostUsd)} attivo ma senza prezzo per ${unpriced.join(", ")}: aggiungilo in src/lib/pricing.ts o metti maxCostUsd a 0`);
    }
  }

  private warnBudget(state: DebateState) {
    if (this.budgetWarned || !budgetSpent(state, BUDGET_WARNING_SHARE)) return;
    this.budgetWarned = true;
    this.broadcast(
      `⚠️ Spesa stimata ${usd(state.usage.total.costUsd)} su un budget di ${usd(state.settings.maxCostUsd)}: al raggiungimento il dibattito si chiude con il sunto.`,
    );
  }

  private changeStage(session: DebateSession, stage: DebateStage) {
    const { moderator } = this.requireCore();
    const text = stageAnnouncement(stage);
    session.emit({ type: "stage_changed", stage, text });
    this.broadcast(`**[${moderator.config.name}]**\n\n${text}`);
  }

  private requireCore(): CoreAgents {
    if (!this.core) throw new Error("Agents are not initialized");
    return this.core;
  }

  private async intro(session: DebateSession) {
    const { moderator } = this.requireCore();
    const { text } = await generateText(
      moderator.agent,
      introPrompt(session.state),
      this.callOptions(session, moderator.config.id, moderator.config.model, "intro"),
    );
    session.emit({ type: "moderator_message", kind: "intro", text });
    this.broadcast(`**[${moderator.config.name}]**\n\n${text}`);
  }

  private async raiseHands(session: DebateSession, debaters: AgentConfig[]) {
    const { state } = session;
    const { hand } = this.requireCore();
    const results = await Promise.allSettled(
      debaters.map(async (debater) => ({
        debater,
        decision: await generateObject(
          hand,
          handPrompt(state, debater),
          handSchema,
          this.callOptions(session, debater.id, debateConfig.handModel, "hand"),
        ),
      })),
    );
    this.throwIfStopped();

    const raised: string[] = [];
    for (const result of results) {
      if (result.status === "rejected") {
        this.record(session, { type: "error", scope: "hand", message: errorMessage(result.reason) });
        continue;
      }
      const { debater, decision } = result.value;
      const pitch = truncateWords(decision.pitch, MAX_PITCH_WORDS);
      if (!decision.raise || !pitch) {
        if (state.queue.some((entry) => entry.debaterId === debater.id)) session.emit({ type: "hand_lowered", debaterId: debater.id });
        continue;
      }
      const target = decision.target !== debater.id && isParticipant(state, decision.target) ? decision.target : undefined;
      session.emit({ type: "hand_raised", debaterId: debater.id, kind: decision.kind, pitch, ...(target ? { target } : {}) });
      raised.push(`✋ ${debater.name} (${HAND_LABELS[decision.kind]}): ${pitch}`);
    }
    if (raised.length > 0) this.broadcast(`_...nel tavolo..._\n${raised.join("\n")}`);
  }

  private async giveFloor(session: DebateSession): Promise<string> {
    const { state } = session;
    const { moderator } = this.requireCore();
    let decision: z.infer<typeof moderatorTurnSchema> | null = null;
    try {
      decision = await generateObject(
        moderator.agent,
        routingPrompt(state),
        moderatorTurnSchema,
        this.callOptions(session, moderator.config.id, moderator.config.model, "routing", {
          tools: this.tools(debateConfig.roleTools.moderator),
        }),
      );
    } catch (err) {
      if (this.stopRequested) throw err;
      // A failed routing call must not end the debate: the fallback picks the speaker
      this.record(session, { type: "error", scope: "routing", message: errorMessage(err) });
    }

    const ops = (decision?.whiteboardOps ?? []).slice(0, MAX_MODERATOR_OPS).map(cleanBoardOp);
    if (ops.length > 0) session.emit({ type: "whiteboard_ops", author: MODERATOR_ID, ops });

    const choice = chooseSpeaker(state, decision);
    session.emit({ type: "floor_given", ...choice });
    // When the rules override the moderator pick, its transition would name the wrong person
    const transition = decision?.transition.trim();
    if (transition && decision?.nextSpeakerId === choice.speakerId) {
      session.emit({ type: "moderator_message", kind: "transition", text: transition });
      this.broadcast(`**[${moderator.config.name}]**\n\n${transition}`);
    }
    return choice.speakerId;
  }

  /** Returns false when nobody spoke: the user had the floor and let it go. */
  private async speak(session: DebateSession, speakerId: string): Promise<boolean> {
    if (speakerId === USER_ID) return this.userSpeaks(session);
    const { state } = session;
    const debater = this.debaters.get(speakerId);
    if (!debater) throw new Error(`No agent for debater ${speakerId}`);
    const { config, agent } = debater;

    const keys = [...new Set([...debateConfig.roleTools.debater, ...(config.tools ?? [])])];
    const webKeys = keys.filter((key) => WEB_TOOL_KEYS.includes(key));
    const localKeys = keys.filter((key) => !WEB_TOOL_KEYS.includes(key));
    // Web tools are Anthropic server tools: other providers cannot run them
    const research = webKeys.length > 0 && config.model.provider === "anthropic" ? await this.research(session, debater, webKeys) : null;

    const speech = await generateObject(
      agent,
      speechPrompt(state, config, research),
      speechSchema,
      this.callOptions(session, config.id, config.model, "speech", { tools: this.tools(localKeys) }),
    );

    const text = speech.text.trim() || "(intervento vuoto)";
    const replyTo = [...new Set(speech.replyTo)].filter((id) => id !== config.id && (id === MODERATOR_ID || isParticipant(state, id)));
    session.emit({ type: "speech", speakerId: config.id, text, replyTo });
    this.broadcast(`**[${config.name}]**\n\n${text}`);

    const notebook = speech.notebook.trim().slice(0, MAX_NOTEBOOK_CHARS);
    if (notebook && notebook !== state.notebooks[config.id]) {
      session.emit({ type: "notebook_updated", debaterId: config.id, notebook });
    }

    const proposals = this.proposals(session, config.id, speech.proposals);
    if (proposals.length > 0) session.emit({ type: "whiteboard_ops", author: config.id, ops: proposals });
    return true;
  }

  private async userSpeaks(session: DebateSession): Promise<boolean> {
    let text = this.pendingUserText;
    this.pendingUserText = null;
    if (!text) {
      this.broadcast("🎤 La parola a te: scrivi il tuo intervento in chat.");
      text = await this.waitForUserSpeech();
    }
    if (!text) {
      this.broadcast("Nessun intervento dal committente, si prosegue.");
      return false;
    }
    session.emit({ type: "speech", speakerId: USER_ID, text, replyTo: [] });
    this.broadcast(`**[${nameOf(session.state, USER_ID)}]**\n\n${text}`);
    return true;
  }

  // Resolves with null on timeout or /stop: the loop then moves on or stops
  private waitForUserSpeech(): Promise<string | null> {
    const signal = this.abort.signal;
    if (signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const done = (text: string | null) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.deliverUserSpeech = null;
        resolve(text);
      };
      const onAbort = () => done(null);
      const timer = setTimeout(() => done(null), this.options.userSpeechTimeoutMs ?? USER_SPEECH_TIMEOUT_MS);
      signal.addEventListener("abort", onAbort, { once: true });
      this.deliverUserSpeech = done;
    });
  }

  private async research(session: DebateSession, debater: SessionAgent, webKeys: ToolKey[]): Promise<TextResult | null> {
    const { config, agent } = debater;
    try {
      const result = await generateText(
        agent,
        researchPrompt(session.state, config),
        this.callOptions(session, config.id, config.model, "research", {
          tools: this.tools(webKeys),
          maxSteps: RESEARCH_STEPS,
        }),
      );
      const notes = result.text.trim();
      if (result.sources.length === 0 && (!notes || notes.toUpperCase().startsWith(NO_RESEARCH))) return null;
      session.emit({ type: "research_done", debaterId: config.id, notes, sources: result.sources });
      return { text: notes, sources: result.sources };
    } catch (err) {
      if (this.stopRequested) throw err;
      // The speech still happens, just without fresh data
      this.record(session, { type: "error", scope: "research", message: errorMessage(err) });
      return null;
    }
  }

  // Sources are only accepted with a URL the debater actually retrieved: models invent plausible URLs
  private proposals(
    session: DebateSession,
    debaterId: string,
    proposals: z.infer<typeof speechSchema>["proposals"],
  ): BoardOp[] {
    const retrieved = new Set((session.state.sources[debaterId] ?? []).map((source) => normalizeUrl(source.url)));
    const ops: BoardOp[] = [];
    for (const proposal of proposals.slice(0, MAX_PROPOSALS)) {
      const text = proposal.text.trim();
      if (!text) continue;
      const url = proposal.url.trim();
      const verified = url !== "" && retrieved.has(normalizeUrl(url));
      if (proposal.kind === "source" && !verified) {
        this.record(session, {
          type: "error",
          scope: "proposal",
          message: `${debaterId}: source "${url || "no url"}" was not retrieved by its web research`,
        });
        continue;
      }
      ops.push({ op: "propose", kind: proposal.kind, text, ...(verified ? { url } : {}) });
    }
    return ops;
  }

  private async judge(session: DebateSession): Promise<boolean> {
    const { judges } = this.requireCore();
    if (judges.length === 0) return false;
    const prompt = judgePrompt(session.state);
    const results = await Promise.allSettled(
      judges.map(async (judge) => ({
        judge,
        verdict: await generateObject(
          judge.agent,
          prompt,
          judgeOutputSchema,
          this.callOptions(session, judge.config.id, judge.config.model, "judge"),
        ),
      })),
    );
    this.throwIfStopped();

    const verdicts: Verdict[] = [];
    for (const result of results) {
      if (result.status === "rejected") {
        this.record(session, { type: "error", scope: "judge", message: errorMessage(result.reason) });
        continue;
      }
      const { judge, verdict } = result.value;
      session.emit({ type: "judge_verdict", judgeId: judge.config.id, judgeName: judge.config.name, ...verdict });
      verdicts.push(verdict);
    }
    return stageConcluded(verdicts, judges.length);
  }

  private async finish(session: DebateSession, reason: FinishReason) {
    if (session.state.phase === "finished") return;
    const { moderator } = this.requireCore();
    if (session.state.turn > 0) {
      this.broadcast(`🏁 **Il dibattito si è concluso${FINISH_NOTES[reason]}.** Il moderatore prepara il sunto.`);
      try {
        // Fresh signal: the summary must run even after /stop aborted the debate
        const result = await generateObject(
          moderator.agent,
          summaryPrompt(session.state, reason),
          summarySchema,
          this.callOptions(session, moderator.config.id, moderator.config.model, "summary", { abortSignal: undefined }),
        );
        const focalPoints = focalPointsOf(result.focalPoints);
        session.emit({ type: "moderator_message", kind: "summary", text: result.summary, inShort: result.inShort, focalPoints });
        const points = focalPoints.map((point, index) => `${index + 1}. ${point}`).join("\n");
        this.broadcast(
          `**[${moderator.config.name} (Sunto Finale)]**\n\n${result.inShort}${points ? `\n\n**Punti focali**\n${points}` : ""}`,
        );
      } catch (err) {
        console.error("[DebateManager] summary failed:", err);
        this.record(session, { type: "error", scope: "summary", message: errorMessage(err) });
      }
    }
    session.emit({ type: "debate_finished", reason });
    this.project(session, true);
    this.broadcast(`📁 Artefatti salvati in ${path.relative(process.cwd(), session.dir)}`);
    if (this.session === session) {
      this.currentStatus = "FINISHED";
      this.notifyFinished(session);
    }
  }
}
