import * as fs from "fs";
import * as path from "path";
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { debateConfig, JudgeOutput, AgentConfig } from "./debateConfig";
import {
  debaterSelectionSchema,
  routeNextSpeakerSchema,
  speechSchema,
  judgeOutputSchema,
  summarySchema,
} from "./schemas";
import {
  moderatorAgent,
  debaterAgents,
  judgeAgents,
  initializeDebaterAgents,
} from "./agents";
import * as log from "@volcanicminds/tools/logger";

export type DebateStatus =
  | "IDLE"
  | "SELECTING_DEBATERS"
  | "RUNNING"
  | "FINISHED";
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  name?: string;
}

export interface DebaterSelection {
  id: string;
  reason: string;
}

export let activeDebate: DebateManager | null = null;

export class DebateManager {
  public status: DebateStatus = "IDLE";
  public topic: string = debateConfig.defaultTopic;
  public turnCount: number = 0;
  public maxTurns: number = debateConfig.maxTurns;
  public history: ChatMessage[] = [];

  public startTime: Date | null = null;
  public endTime: Date | null = null;
  public judgesAgree: number = 0;
  public judgesDisagree: number = 0;
  public lastJudgesOutputs: {
    id: string;
    name: string;
    output: JudgeOutput;
  }[] = [];

  private currentDebaterIndex = 0;
  public allAvailableDebaters: AgentConfig[] = [];
  public currentSelection: DebaterSelection[] = [];

  private onMessageCallback?: (msg: string) => void;
  private onFinishedCallback?: () => void;
  private onSelectionRequiredCallback?: (
    selection: DebaterSelection[],
    allAvailable: AgentConfig[],
  ) => void;

  public setOnMessage(cb: (msg: string) => void) {
    this.onMessageCallback = cb;
  }
  public setOnFinished(cb: () => void) {
    this.onFinishedCallback = cb;
  }
  public setOnSelectionRequired(
    cb: (selection: DebaterSelection[], allAvailable: AgentConfig[]) => void,
  ) {
    this.onSelectionRequiredCallback = cb;
  }

  private async generate<T>(
    agent: Agent,
    prompt: string,
    schema?: z.ZodSchema<T>,
  ): Promise<T | string> {
    console.log(
      new Date().toISOString(),
      `[DebateManager] Before Wait - Generating ${schema ? "structured " : ""}response from ${agent.name}...`,
    );
    await new Promise((resolve) => setTimeout(resolve, 5000));
    console.log(
      new Date().toISOString(),
      `[DebateManager] Generating response from ${agent.name}...`,
    );

    if (schema) {
      const response = await agent.generate(prompt, {
        output: schema,
      });
      return response.object as T;
    }

    const response = await agent.generate(prompt);
    return response.text;
  }

  private async loadAvailableDebaters(): Promise<AgentConfig[]> {
    const debatersDir = path.join(__dirname, "..", "debaters");
    console.log("[DebateManager] Caricamento debaters da:", debatersDir);
    const files = fs
      .readdirSync(debatersDir)
      .filter((f) => f.match(/\.(ts|js)$/) && !f.startsWith("index."));
    console.log("[DebateManager] File trovati:", files);
    const configs: AgentConfig[] = [];

    for (const file of files) {
      try {
        const module = await import(path.join(debatersDir, file));
        if (module.default && module.default.id) {
          configs.push(module.default as AgentConfig);
          console.log("[DebateManager] Caricato debater:", module.default.id);
        } else {
          console.warn(
            "[DebateManager] File senza export default valido:",
            file,
          );
        }
      } catch (err) {
        console.error(`[DebateManager] Failed to load debater ${file}:`, err);
        log.error(`Failed to load debater ${file}: ${err}`);
      }
    }
    console.log("[DebateManager] Totale debaters caricati:", configs.length);
    return configs;
  }

  public async startDebate(customTopic?: string) {
    activeDebate = this;
    console.log("[DebateManager] startDebate chiamato con topic:", customTopic);
    if (this.status === "RUNNING" || this.status === "SELECTING_DEBATERS") {
      console.log("[DebateManager] Debate già in corso, ritorno.");
      return;
    }

    if (!moderatorAgent) {
      console.log("[DebateManager] Moderatore non inizializzato.");
      this.broadcast("❌ Errore: Moderatore non inizializzato o disabilitato.");
      return;
    }

    this.status = "SELECTING_DEBATERS";
    this.topic = customTopic || debateConfig.defaultTopic;
    this.turnCount = 0;
    this.history = [];
    this.startTime = new Date();
    this.endTime = null;
    this.judgesAgree = 0;
    this.judgesDisagree = 0;
    this.currentDebaterIndex = 0;
    this.currentSelection = [];

    this.broadcast(
      `⏳ Valutazione dell'argomento e selezione dei partecipanti ottimali...`,
    );

    this.allAvailableDebaters = await this.loadAvailableDebaters();
    console.log(
      "[DebateManager] Debaters caricati:",
      this.allAvailableDebaters.length,
    );
    await this.proposeDebaters();
  }

  private async proposeDebaters(userFeedback?: string) {
    console.log(
      "[DebateManager] proposeDebaters chiamato con feedback:",
      userFeedback,
    );
    const rosterList = this.allAvailableDebaters
      .map(
        (d) =>
          `- ID: ${d.id} | Name: ${d.name} | Skills: ${d.skills?.join(", ") || ""} | WhenToUse: ${d.whenToUse || ""} | Descrizione: ${d.description ? d.description + " - " : ""}${d.instructions}`,
      )
      .join("\n\n");

    let prompt = `Sei il moderatore. L'argomento del dibattito è: "${this.topic}".
Ecco l'elenco di tutti i profili disponibili per partecipare:
${rosterList}

Seleziona ALMENO 5 e MASSIMO 13 debaters che ritieni più adatti a sviscerare questo argomento da diverse angolazioni.
Rispondi SOLO con un array JSON di oggetti, dove ogni oggetto ha "id" (l'id del debater) e "reason" (una breve spiegazione del perché lo hai scelto, max 20 parole).`;

    if (userFeedback) {
      prompt += `\n\nAttenzione, l'utente ha fornito un feedback sulla tua precedente selezione. Modifica la selezione tenendo conto di questo feedback: "${userFeedback}". Rispondi sempre e solo con l'array JSON aggiornato.`;
    }

    console.log(
      "[DebateManager] Prompt per moderatore:",
      prompt.substring(0, 200) + "...",
    );
    try {
      const selectionResult = await this.generate(
        moderatorAgent,
        prompt,
        debaterSelectionSchema,
      );

      const selection = (selectionResult as z.infer<typeof debaterSelectionSchema>)
        .debaters;

      console.log(
        "[DebateManager] Selezione parsata:",
        selection.length,
        "debaters",
      );
      this.currentSelection = selection;

      if (this.onSelectionRequiredCallback) {
        console.log("[DebateManager] Chiamo onSelectionRequiredCallback");
        this.onSelectionRequiredCallback(
          this.currentSelection,
          this.allAvailableDebaters,
        );
      }
    } catch (err) {
      console.error("[DebateManager] Errore in proposeDebaters:", err);
      log.error("Errore durante la selezione dei debaters: " + err);
      this.broadcast(
        "❌ Errore durante la selezione dei debaters. Annullamento.",
      );
      this.status = "IDLE";
    }
  }

  public async handleDebaterSelectionInput(input: string) {
    if (this.status !== "SELECTING_DEBATERS") return;

    if (
      input.trim().toLowerCase() === "conferma" ||
      input.trim().toLowerCase() === "ok"
    ) {
      this.broadcast(`✅ Selezione confermata. Inizializzazione in corso...`);

      const selectedConfigs = this.currentSelection
        .map((sel) => this.allAvailableDebaters.find((d) => d.id === sel.id))
        .filter((c): c is AgentConfig => !!c);

      if (selectedConfigs.length === 0) {
        this.broadcast("❌ Nessun debater selezionato valido. Annullamento.");
        this.status = "IDLE";
        return;
      }

      await initializeDebaterAgents(selectedConfigs);

      this.status = "RUNNING";
      this.broadcast(`🎙️ **DIBATTITO AVVIATO** 🎙️\n**Tema:** ${this.topic}\n`);
      await this.runTurn();
    } else {
      this.broadcast(
        `🔄 Rielaborazione della selezione in base al tuo feedback...`,
      );
      await this.proposeDebaters(input);
    }
  }

  public async stopDebate() {
    this.broadcast(`🛑 **DIBATTITO INTERROTTO** 🛑`);
    await this.finishDebate(true);
  }

  private broadcast(msg: string) {
    if (this.onMessageCallback) this.onMessageCallback(msg);
  }

  private formatHistoryForPrompt(): string {
    return this.history
      .map((msg) => `[${msg.name || msg.role}]: ${msg.content}`)
      .join("\n\n");
  }

  /**
   * Returns a formatted roster of active debaters for the moderator prompt.
   */
  private getDebaterRoster(): string {
    return debaterAgents.map((d) => `- ${d.id}: ${d.name}`).join("\n");
  }

  /**
   * Asks the moderator to process the last response and choose who speaks next.
   * Falls back to round-robin if JSON parsing fails.
   */
  private async routeNextSpeaker(lastDebaterName: string): Promise<void> {
    const roster = this.getDebaterRoster();
    const prompt = `Hai appena ascoltato l'intervento di ${lastDebaterName}.
Cronologia completa:\n${this.formatHistoryForPrompt()}

Ecco i dibattitori disponibili al tavolo:
${roster}

Basandoti sul contenuto dell'ultimo intervento e sul flusso della discussione, decidi chi deve parlare dopo.
Rispondi SOLO in formato JSON: {"nextSpeakerId": "id_del_prossimo", "transition": "breve commento di transizione max 30 parole"}`;

    try {
      const result = (await this.generate(
        moderatorAgent,
        prompt,
        routeNextSpeakerSchema,
      )) as z.infer<typeof routeNextSpeakerSchema>;

      // Broadcast the moderator's transition comment
      if (result.transition) {
        this.history.push({
          role: "assistant",
          content: result.transition,
          name: moderatorAgent.name,
        });
        this.broadcast(`**[${moderatorAgent.name}]**\n\n${result.transition}`);
      }

      // Find the chosen debater by ID
      const chosenIndex = debaterAgents.findIndex(
        (d) => d.id === result.nextSpeakerId,
      );

      if (chosenIndex !== -1) {
        this.currentDebaterIndex = chosenIndex;
        log.debug(
          `> Moderatore ha scelto: ${debaterAgents[chosenIndex].name} (${result.nextSpeakerId})`,
        );
      } else {
        // Fallback: round-robin
        log.debug(
          `> ID "${result.nextSpeakerId}" non trovato, fallback round-robin`,
        );
        this.currentDebaterIndex =
          (this.currentDebaterIndex + 1) % debaterAgents.length;
      }
    } catch (err) {
      // Fallback: round-robin on any error
      log.debug("> Routing moderatore fallito, fallback round-robin");
      this.currentDebaterIndex =
        (this.currentDebaterIndex + 1) % debaterAgents.length;
    }
  }

  private async runTurn() {
    if (this.status !== "RUNNING") return;
    try {
      if (this.turnCount === 0) {
        log.debug("> Il dibattito ha inizio");

        const prompt = `Il dibattito sta per iniziare. Tema: "${this.topic}". Introduci brevemente (max 100 parole) e dai la parola a: ${debaterAgents[0].name}.`;
        const response = (await this.generate(
          moderatorAgent,
          prompt,
          speechSchema,
        )) as z.infer<typeof speechSchema>;

        const content = response.text || "";
        this.history.push({
          role: "assistant",
          content,
          name: moderatorAgent.name,
        });
        this.broadcast(`**[${moderatorAgent.name}]**\n\n${content}`);
      } else {
        // 1. Il debater corrente parla
        const debater = debaterAgents[this.currentDebaterIndex];
        log.debug("> La parola a " + debater.id);

        const prompt = `Il tema è: "${this.topic}". Cronologia:\n${this.formatHistoryForPrompt()}\nÈ il tuo turno. Rispondi mantenendo fermamente il tuo ruolo.`;
        const response = (await this.generate(
          debater,
          prompt,
          speechSchema,
        )) as z.infer<typeof speechSchema>;

        const content = response.text || "";
        this.history.push({ role: "assistant", content, name: debater.name });
        this.broadcast(`**[${debater.name}]**\n\n${content}`);

        // 2. Il moderatore processa la risposta e sceglie il prossimo
        await this.routeNextSpeaker(debater.name);
      }

      this.turnCount++;

      if (this.turnCount > debaterAgents.length) {
        const isFinished = await this.evaluateDebate();
        if (isFinished || this.turnCount >= this.maxTurns) {
          log.debug("> Il dibattito si è concluso");
          await this.finishDebate();
          return;
        }
      }
      setTimeout(() => this.runTurn(), 1100);
    } catch (err) {
      this.stopDebate();
    }
  }

  private async evaluateDebate(): Promise<boolean> {
    this.lastJudgesOutputs = [];
    const historyText = this.formatHistoryForPrompt();
    const prompt = `Ecco la cronologia:\n${historyText}\n
Valuta se il dibattito è giunto a una conclusione tenendo conto del tuo specifico ruolo di giudice. Le regole generali per terminare sono:
1. Obiettivo Raggiunto: L'argomento è stato analizzato a fondo ed è stato raggiunto un esito o una conclusione chiara. (isReady: true).
2. Tempo Spreco/Loop: I partecipanti girano in tondo ripetendosi senza progredire da troppo tempo (isReady: true, indicare reason adeguata).

Se il dibattito sta procedendo proficuamente ma non ha ancora raggiunto l'obiettivo, rispondi con isReady: false.
Rispondi SOLO in formato JSON valido: {"isReady": boolean, "reason": "string", "maturityDegree": numero_da_1_a_5}`;

    let readyCount = 0;
    let matureCount = 0;
    const judgesCount = judgeAgents.length;
    for (const judge of judgeAgents) {
      try {
        const result = (await this.generate(
          judge,
          prompt,
          judgeOutputSchema,
        )) as JudgeOutput;

        this.lastJudgesOutputs.push({
          id: judge.id,
          name: judge.name,
          output: result,
        });
        if (result.isReady) readyCount++;
        if (result.maturityDegree >= 5) matureCount++;
      } catch (err) {}
    }

    this.judgesAgree = readyCount;
    this.judgesDisagree = judgesCount - readyCount;

    if (readyCount === judgesCount) return true;
    const twoThirds = Math.ceil((judgesCount * 2) / 3);
    if (readyCount >= twoThirds && matureCount >= twoThirds) return true;
    return false;
  }

  private async finishDebate(interrupted: boolean = false) {
    this.status = "FINISHED";
    this.endTime = new Date();
    this.broadcast(
      `🏁 **Il dibattito si è concluso${interrupted ? " anticipatamente" : ""}.** Moderatore elabora sunto...`,
    );
    try {
      const prompt = `Dibattito terminato${interrupted ? " anticipatamente (interrotto)" : ""}. Cronologia:\n${this.formatHistoryForPrompt()}\n
Fai un sunto neutrale della discussione fin qui svoltasi.

DEVI includere una sezione "Giudizio Finale" in cui indichi:
- Se il dibattito si è concluso per il raggiungimento massimo dei turns (${this.maxTurns}) oppure per il voto dei giudici.
- Quali giudici hanno votato cosa, riportando la loro reason e il loro score di maturityDegree. I dati dei voti dei giudici sono: ${JSON.stringify(this.lastJudgesOutputs)}
- Nelle metriche o nel testo, indica il numero totale di debaters coinvolti (${debaterAgents.length}).

Fornisci anche una sintesi ultraconcisa di massimo 1-2 frasi da passare a "inShort". Poi usa il tool "saveArtifact" per salvare l'artefatto con "summary" e "inShort". Massimo 400 parole per la sintesi estesa.`;
      const result = (await this.generate(
        moderatorAgent,
        prompt,
        summarySchema,
      )) as z.infer<typeof summarySchema>;

      const content = result.summary || "";
      this.history.push({
        role: "assistant",
        content,
        name: moderatorAgent.name,
      });
      this.broadcast(`**[${moderatorAgent.name} (Sunto Finale)]**\n${content}`);
    } catch (err) {}
    if (this.onFinishedCallback) this.onFinishedCallback();
  }
}
