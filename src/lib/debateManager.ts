import * as fs from "fs";
import * as path from "path";
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { debateConfig, JudgeOutput, AgentConfig } from "./debateConfig";
import { models, addendum } from "../lib/models";
import {
  debaterSelectionSchema,
  routeNextSpeakerSchema,
  speechSchema,
  judgeOutputSchema,
  summarySchema,
  moderatorAnalysisSchema,
  raiseHandSchema,
} from "./schemas";
import {
  moderatorAgent,
  debaterAgents,
  judgeAgents,
  initializeDebaterAgents,
} from "./agents";
import { saveArtifactTool } from "../mcp/saveArtifactTool";
import * as log from "@volcanicminds/tools/logger";

export type DebateStatus =
  | "IDLE"
  | "ASKING_SELECTION_PREFERENCE"
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

export interface NewDebater {
  id: string;
  name: string;
  reason: string;
  skills: string[];
  whenToUse: string;
  description: string;
  instructions: string;
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
  public whiteboard: string = "";
  public lastJudgesOutputs: {
    id: string;
    name: string;
    output: JudgeOutput;
  }[] = [];

  private currentDebaterIndex = 0;
  public allAvailableDebaters: AgentConfig[] = [];
  public currentSelection: DebaterSelection[] = [];
  public newDebatersProposed: NewDebater[] = [];

  private onMessageCallback?: (msg: string) => void;
  private onFinishedCallback?: () => void;
  private onSelectionRequiredCallback?: (
    selection: DebaterSelection[],
    allAvailable: AgentConfig[],
    moderatorMessage?: string,
  ) => void;
  private onPreferenceAskedCallback?: (allAvailable: AgentConfig[]) => void;

  public setOnMessage(cb: (msg: string) => void) {
    this.onMessageCallback = cb;
  }
  public setOnFinished(cb: () => void) {
    this.onFinishedCallback = cb;
  }
  public setOnSelectionRequired(
    cb: (
      selection: DebaterSelection[],
      allAvailable: AgentConfig[],
      moderatorMessage?: string,
    ) => void,
  ) {
    this.onSelectionRequiredCallback = cb;
  }
  public setOnPreferenceAsked(cb: (allAvailable: AgentConfig[]) => void) {
    this.onPreferenceAskedCallback = cb;
  }

  private async generate<T>(
    agent: Agent,
    prompt: string,
    schema?: z.ZodSchema<T>,
  ): Promise<T | string> {
    const maxRetries = 3;
    let attempt = 0;

    // Enforce prompt instructions when schema is provided
    let finalPrompt = prompt;
    if (schema) {
      finalPrompt +=
        "\n\nIMPORTANT: You must return ONLY a valid JSON object. Do not include any other text or markdown formatting outside the JSON object.";
    }

    while (attempt < maxRetries) {
      console.log(
        new Date().toISOString(),
        `[DebateManager] Before Wait - Generating ${schema ? "structured " : ""}response from ${agent.name}... (Attempt ${attempt + 1})`,
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));
      console.log(
        new Date().toISOString(),
        `[DebateManager] Generating response from ${agent.name}...`,
      );

      try {
        if (schema) {
          const response = await agent.generate(finalPrompt, {
            output: schema,
          });
          return response.object as T;
        }

        const response = await agent.generate(finalPrompt);
        return response.text;
      } catch (err: any) {
        if (
          schema &&
          (err.name === "NoObjectGeneratedError" ||
            err.message?.includes("No object generated") ||
            err.message?.includes("JSON") ||
            err.message?.includes("parse"))
        ) {
          attempt++;
          console.warn(
            `[DebateManager] Schema generation failed for ${agent.name} on attempt ${attempt}: ${err.message}`,
          );
          if (attempt >= maxRetries) {
            console.warn(
              `[DebateManager] Max retries reached for structured generation. Attempting fallback text generation and manual parse.`,
            );
            try {
              // Fallback to text generation
              const response = await agent.generate(finalPrompt);
              const text = response.text || "";

              // Try to extract JSON from text
              const jsonMatch = text.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                // Validate with schema
                return schema.parse(parsed);
              } else {
                throw new Error("No JSON found in fallback text response");
              }
            } catch (fallbackErr: any) {
              console.error(
                `[DebateManager] Fallback parsing also failed: ${fallbackErr.message}`,
              );
              throw err; // Throw the original error or the new one, this will trigger the forcefully stop (stopDebate)
            }
          }
        } else {
          // If not a schema-related error or no schema, just throw
          throw err;
        }
      }
    }
    throw new Error("Unexpected end of generate method");
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
    if (
      this.status === "RUNNING" ||
      this.status === "SELECTING_DEBATERS" ||
      this.status === "ASKING_SELECTION_PREFERENCE"
    ) {
      console.log(
        "[DebateManager] Debate già in corso o in selezione, ritorno.",
      );
      return;
    }

    if (!moderatorAgent) {
      console.log("[DebateManager] Moderatore non inizializzato.");
      this.broadcast("❌ Errore: Moderatore non inizializzato o disabilitato.");
      return;
    }

    this.status = "ASKING_SELECTION_PREFERENCE";
    this.topic = customTopic || debateConfig.defaultTopic;
    this.turnCount = 0;
    this.history = [];
    this.startTime = new Date();
    this.endTime = null;
    this.judgesAgree = 0;
    this.judgesDisagree = 0;
    this.whiteboard = "Lavagna vuota. Nessun dato consolidato al momento.";
    this.currentDebaterIndex = 0;
    this.currentSelection = [];

    this.allAvailableDebaters = await this.loadAvailableDebaters();
    console.log(
      "[DebateManager] Debaters caricati:",
      this.allAvailableDebaters.length,
    );

    if (this.onPreferenceAskedCallback) {
      this.onPreferenceAskedCallback(this.allAvailableDebaters);
    }
  }

  public async handleSelectionPreferenceInput(input: string) {
    if (this.status !== "ASKING_SELECTION_PREFERENCE") return;

    const lowerInput = input.trim().toLowerCase();
    const isSmart = lowerInput === "smart";
    const isAuto =
      ["mod", "automatico", "procedi", "ok"].includes(lowerInput) ||
      lowerInput.length > 50;

    this.status = "SELECTING_DEBATERS";
    if (isSmart) {
      this.broadcast(
        `🧠 Analisi smart dell'argomento... il moderatore proporrà o creerà i partecipanti ideali al volo.`,
      );
      await this.proposeDebaters(undefined, false, true);
    } else if (isAuto) {
      this.broadcast(
        `⏳ Valutazione dell'argomento e selezione dei partecipanti ottimali da parte del moderatore...`,
      );
      await this.proposeDebaters();
    } else {
      this.broadcast(
        `⏳ Acquisizione della tua selezione e valutazione da parte del moderatore...`,
      );
      await this.proposeDebaters(input, true);
    }
  }

  private async proposeDebaters(
    userFeedback?: string,
    isDirectUserSelection: boolean = false,
    isSmartSelection: boolean = false,
  ) {
    console.log(
      "[DebateManager] proposeDebaters chiamato con feedback:",
      userFeedback,
    );

    // Sort available debaters exactly as in telegram.ts to match user's visual indices
    const sortedAvailable = [...this.allAvailableDebaters].sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    const rosterList = sortedAvailable
      .map(
        (d, i) =>
          `- INDICE: ${i + 1} | ID: ${d.id} | Name: ${d.name} | Skills: ${d.skills?.join(", ") || ""} | WhenToUse: ${d.whenToUse || ""} | Descrizione: ${d.description ? d.description + " - " : ""}${d.instructions}`,
      )
      .join("\n\n");

    let prompt = `Sei il moderatore. L'argomento del dibattito è: "${this.topic}".
Ecco l'elenco di tutti i profili disponibili per partecipare:
${rosterList}

REGOLE PER LA SELEZIONE (MOLTO IMPORTANTE):
1. Assicurati che la discussione sia di valore e proceda in modo incrementale.
2. Se il topic riguarda una nuova idea, un nuovo business o un tema ignoto, coinvolgi SEMPRE in prima battuta le figure fondamentali per posizionare e definire l'idea (es. Founder, Esperto di Mercato, Business Analyst).
3. NON coinvolgere prematuramente figure di freno (es. Avvocato, esperto GDPR, Legale) se l'idea non è ancora solida o matura, a meno che non siano strettamente pertinenti al core del topic. L'obiettivo è creare prima un quadro molto solido.
4. L'array "debaters" DEVE contenere ALMENO 5 e MASSIMO 13 debaters che ritieni più adatti.
`;

    if (isSmartSelection) {
      prompt += `\nL'UTENTE HA RICHIESTO LA MODALITÀ SMART.
Devi analizzare in profondità il topic e decidere di quali figure necessita il tavolo.
Cerca i candidati ideali tra i profili disponibili sopra e includi i loro "id" in "debaters".
TUTTAVIA, se ti accorgi che mancano figure fondamentali o necessiti di ruoli specifici non presenti, DEVI crearli da zero.
Per i nuovi debaters, popolali nell'array "newDebaters", fornendo "id" (formato snake_case univoco, ad es. "esperto_blockchain"), "name", "reason", "skills", "whenToUse", "description" e "instructions" (un prompt comportamentale dettagliato per la personalità dell'agente).
Rispondi in formato JSON con:
- "debaters": array dei debaters scelti dall'elenco.
- "newDebaters": array dei debaters creati al volo (può essere vuoto se non necessari).
- "moderatorMessage": spiega brevemente in italiano le tue scelte e presenta all'utente i nuovi profili proposti.`;
    } else if (isDirectUserSelection && userFeedback) {
      prompt += `\nL'UTENTE HA FORNITO IL SUO ELENCO DI PREFERENZE IN NUMERI (che corrispondono agli "INDICE" sopra):
"${userFeedback}"

ATTENZIONE: DEVI estrarre gli "INDICE" forniti dall'utente e trovare gli "ID" corrispondenti nell'elenco. DEVI accettare incondizionatamente le scelte dell'utente includendo TUTTI (e solo) i relativi "ID" da lui scelti nel campo "debaters".
Tuttavia, se lo ritieni necessario, puoi valutare questa lista ed emettere dei suggerimenti nel campo opzionale "moderatorMessage". Ad esempio puoi dire:
"Ho ricevuto il tuo elenco e l'ho impostato come richiesto. Visto il topic, ti consiglio di includere anche [Nome] e di escludere [Nome] per [motivo]. Che ne pensi? Vuoi che proceda così o vuoi applicare le mie modifiche?"
Se l'elenco dell'utente va benissimo così, puoi scrivere semplicemente: "L'elenco proposto mi sembra ottimo e copre tutti gli aspetti essenziali. Vuoi che proceda e dia il via al dibattito?"

Rispondi in formato JSON con l'oggetto contenente:
- "debaters": la lista degli agenti scelti (che DEVE includere ESATTAMENTE quelli chiesti dall'utente). Ogni oggetto ha "id" e "reason".
- "moderatorMessage": la tua risposta conversazionale (in italiano) rivolta all'utente, dove gli comunichi eventuali suggerimenti e gli chiedi conferma.`;
    } else if (userFeedback) {
      prompt += `\nL'UTENTE HA FORNITO UN FEEDBACK SULLA TUA PRECEDENTE SELEZIONE (i numeri forniti dall'utente corrispondono agli "INDICE" sopra):
"${userFeedback}"

Analizza il messaggio dell'utente. Devi variare l'elenco con le modifiche richieste dall'utente convertendo i numeri negli ID corrispondenti.
Rispondi in formato JSON con l'oggetto aggiornato che contiene la chiave "debaters" (ognuno con "id" e "reason"). Se lo ritieni opportuno, puoi compilare il campo "moderatorMessage" per commentare le variazioni apportate.`;
    } else {
      prompt += `\nSeleziona gli agenti migliori per iniziare la mappa mentale e la discussione attorno al topic, tenendo conto delle regole sopra.
Rispondi in formato JSON con un oggetto che contiene la chiave "debaters", il cui valore è un array di oggetti dove ogni oggetto ha "id" e "reason" (una breve spiegazione del perché lo hai scelto, max 20 parole).`;
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

      const parsedResult = selectionResult as z.infer<
        typeof debaterSelectionSchema
      >;
      const selection = parsedResult.debaters;
      const newDebaters = parsedResult.newDebaters || [];

      console.log(
        "[DebateManager] Selezione parsata:",
        selection.length,
        "debaters,",
        newDebaters.length,
        "new debaters",
      );
      this.currentSelection = selection;
      this.newDebatersProposed = newDebaters;

      // Add temporary references of newDebaters to selection so they can be shown to the user
      // User approval of new debaters will trigger physical file creation.
      const allCombinedSelection = [
        ...selection,
        ...newDebaters.map((nd) => ({ id: nd.id, reason: nd.reason })),
      ];

      // Add the proposed new debaters to a temporary pool so the telegram bot can show their names
      const allAvailableWithNew: AgentConfig[] = [
        ...this.allAvailableDebaters,
        ...newDebaters.map((nd) => ({
          id: nd.id,
          name: nd.name,
          role: "debater" as const,
          model: models.debater,
          enabled: true,
          skills: nd.skills,
          whenToUse: nd.whenToUse,
          description: nd.description,
          instructions: nd.instructions + " " + addendum,
        })),
      ];

      if (this.onSelectionRequiredCallback) {
        console.log("[DebateManager] Chiamo onSelectionRequiredCallback");
        this.onSelectionRequiredCallback(
          allCombinedSelection,
          allAvailableWithNew,
          parsedResult.moderatorMessage,
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

      // Write proposed new debaters to physical files if any
      if (this.newDebatersProposed.length > 0) {
        this.broadcast(
          `⏳ Salvataggio dei nuovi debaters generati su disco...`,
        );
        const debatersDir = path.join(__dirname, "..", "debaters");
        for (const nd of this.newDebatersProposed) {
          // Sanitize ID to prevent path traversal or invalid filenames
          const safeId = nd.id.replace(/[^a-zA-Z0-9_]/g, "");
          if (!safeId) continue;

          const filePath = path.join(debatersDir, `${safeId}.ts`);
          const fileContent = `import { AgentConfig } from "../lib/debateConfig";
import { models, addendum } from "../lib/models";

const config: AgentConfig = {
  id: ${JSON.stringify(safeId)},
  name: ${JSON.stringify(nd.name)},
  role: "debater",
  model: models.debater,
  enabled: true,
  skills: ${JSON.stringify(nd.skills, null, 2)},
  whenToUse: ${JSON.stringify(nd.whenToUse)},
  description: ${JSON.stringify(nd.description)},
  instructions: ${JSON.stringify(nd.instructions) + " " + addendum},
};

export default config;
`;
          try {
            fs.writeFileSync(filePath, fileContent, "utf8");
            console.log(`[DebateManager] Salvato nuovo debater: ${filePath}`);

            // Add to allAvailableDebaters so it can be found below
            this.allAvailableDebaters.push({
              id: nd.id,
              name: nd.name,
              role: "debater" as const,
              model: models.debater,
              enabled: true,
              skills: nd.skills,
              whenToUse: nd.whenToUse,
              description: nd.description,
              instructions: nd.instructions + " " + addendum,
            });

            // Add to currentSelection so it gets included
            this.currentSelection.push({
              id: nd.id,
              reason: nd.reason,
            });
          } catch (err) {
            console.error(
              `[DebateManager] Errore salvataggio nuovo debater ${nd.id}:`,
              err,
            );
          }
        }

        // Reset the proposed list
        this.newDebatersProposed = [];
      }

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

    // FASE 1: Analisi moderatore e scelta candidati
    const analysisPrompt = `L'intervento di ${lastDebaterName} si è appena concluso.
Come Moderatore con scopo di raggiungere un altissimo livello progettuale, fai due cose:
1) Sintetizza e aggiorna lo "Stato dell'Arte" (la lavagna). Non perdere i punti chiave già assodati. Integra con le ultime novità.
2) Decidi da 1 a 4 debaters da cui vorresti sentire l'opinione adesso (candidateIds).

LAVAGNA ATTUALE:
${this.whiteboard}

ULTIMI INTERVENTI (Cronologia):
${this.formatHistoryForPrompt()}

ELENCO DIBATTITORI DISPONIBILI:
${roster}

Rispondi in JSON:
- "updatedWhiteboard": il testo aggiornato e compatto della lavagna.
- "candidateIds": array di ID (max 4) dei debaters che vuoi interpellare ora.`;

    let candidateIds: string[] = [];
    try {
      const analysisResult = (await this.generate(
        moderatorAgent,
        analysisPrompt,
        moderatorAnalysisSchema,
      )) as z.infer<typeof moderatorAnalysisSchema>;

      this.whiteboard = analysisResult.updatedWhiteboard;
      candidateIds = analysisResult.candidateIds || [];
      log.debug(
        `> Lavagna aggiornata. Candidati selezionati dal moderatore: ${candidateIds.join(", ")}`,
      );
    } catch (err) {
      log.error(`> Errore in FASE 1 di routing: ${err}`);
      // Fallback
      candidateIds = debaterAgents.map((d) => d.id).slice(0, 3);
    }

    if (candidateIds.length === 0) {
      // Se nessun candidato, round-robin
      this.currentDebaterIndex =
        (this.currentDebaterIndex + 1) % debaterAgents.length;
      return;
    }

    // Filtra per ID validi
    const candidateAgents = debaterAgents.filter((d) =>
      candidateIds.includes(d.id),
    );
    if (candidateAgents.length === 0) {
      this.currentDebaterIndex =
        (this.currentDebaterIndex + 1) % debaterAgents.length;
      return;
    }

    // FASE 2: Interpellare i candidati scelti ("Alzata di mano" selettiva)
    log.debug(`> Interpellando i candidati scelti per l'alzata di mano...`);
    const handsRaised = await Promise.all(
      candidateAgents.map(async (agent) => {
        const handPrompt = `Sei ${agent.name}.
Cronologia recente:
${this.formatHistoryForPrompt()}

Stato della Lavagna (assodato):
${this.whiteboard}

Il moderatore ti ha interpellato. Quanto è cruciale che tu intervenga proprio ADESSO per aggiungere valore al progetto o correggere un errore fatale?
Rispondi SOLO in JSON: {"score": 1-10, "reason": "spiega brevemente perché devi parlare ora"}`;

        try {
          const res = (await this.generate(
            agent,
            handPrompt,
            raiseHandSchema,
          )) as z.infer<typeof raiseHandSchema>;
          return { agent, score: res.score, reason: res.reason };
        } catch (err) {
          return { agent, score: 0, reason: "Errore" };
        }
      }),
    );

    // Formatta risultati alzate di mano per il moderatore
    const handsSummary = handsRaised
      .sort((a, b) => b.score - a.score)
      .map((h) => `- ${h.agent.id} (Score: ${h.score}/10): ${h.reason}`)
      .join("\n");

    // Mostra in UI (opzionale) un riassunto dell'alzata di mano per dare senso di dinamismo reale
    const logHandsUi = handsRaised
      .filter((h) => h.score > 5)
      .sort((a, b) => b.score - a.score)
      .map((h) => `✋ ${h.agent.name} (Volontà ${h.score}/10)`)
      .join("\n");
    if (logHandsUi) {
      this.broadcast(`_...nel tavolo..._\n${logHandsUi}`);
    }

    // FASE 3: Decisione Finale del Moderatore
    const finalPrompt = `Ecco i risultati dell'alzata di mano tra i debaters che hai interpellato:
${handsSummary}

Come Moderatore autoritario, in base alle loro motivazioni (score e reason) e allo stato della Lavagna:
Decidi a chi cedere la parola. Non sei costretto a prendere quello col punteggio più alto se ritieni che la sua motivazione sia fuori fuoco per questa fase.

Rispondi in JSON:
{"nextSpeakerId": "id_scelto", "transition": "tua breve frase per dare la parola"}
`;

    try {
      const result = (await this.generate(
        moderatorAgent,
        finalPrompt,
        routeNextSpeakerSchema,
      )) as z.infer<typeof routeNextSpeakerSchema>;

      if (result.transition) {
        this.history.push({
          role: "assistant",
          content: result.transition,
          name: moderatorAgent.name,
        });
        this.broadcast(`**[${moderatorAgent.name}]**\n\n${result.transition}`);
      }

      const chosenIndex = debaterAgents.findIndex(
        (d) => d.id === result.nextSpeakerId,
      );
      if (chosenIndex !== -1) {
        this.currentDebaterIndex = chosenIndex;
        log.debug(
          `> Moderatore ha dato la parola a: ${debaterAgents[chosenIndex].name} (${result.nextSpeakerId})`,
        );
      } else {
        log.debug(
          `> ID "${result.nextSpeakerId}" non trovato, fallback round-robin`,
        );
        this.currentDebaterIndex =
          (this.currentDebaterIndex + 1) % debaterAgents.length;
      }
    } catch (err) {
      log.debug("> Decisione finale fallita, fallback round-robin");
      this.currentDebaterIndex =
        (this.currentDebaterIndex + 1) % debaterAgents.length;
    }
  }

  private async runTurn() {
    if (this.status !== "RUNNING") return;
    try {
      if (this.turnCount === 0) {
        log.debug("> Il dibattito ha inizio");

        const prompt = `Il dibattito sta per iniziare. Tema: "${this.topic}". Introduci brevemente (max 100 parole) e dai la parola a: ${debaterAgents[0].name}.
Rispondi in formato JSON: {"text": "il tuo discorso qui"}`;
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

        // Aggiungiamo anche lo stato della lavagna al prompt del debater per aiutarlo a mantenere il focus.
        const prompt = `Il tema è: "${this.topic}".
Stato della Lavagna (Punti assodati dal tavolo finora):
${this.whiteboard}

Cronologia recente:\n${this.formatHistoryForPrompt()}\n
È il tuo turno. Rispondi mantenendo fermamente il tuo ruolo.
IMPORTANTE PER LA CREAZIONE DI VALORE: Cerca di costruire sul discorso precedente tenendo conto di cosa c'è sulla lavagna. Se l'idea o il quadro del problema è ancora nelle fasi iniziali, abbi cura di delinearlo in modo solido e incrementale senza porre freni inutili o pretese premature che esulano dalla fase di validazione/scoperta in corso.
IMPORTANTE: Rispondi ESATTAMENTE in questo formato JSON: {"text": "qui scrivi il tuo intervento"}`;
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
      console.error("[DebateManager] Errore critico durante il turno:", err);
      log.error(`Errore critico durante il turno: ${err}`);
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

DEVI includere una sezione "Giudizio Finale" nel campo "summary" in cui indichi:
- Se il dibattito si è concluso per il raggiungimento massimo dei turns (${this.maxTurns}) oppure per il voto dei giudici (o interruzione utente).
- Quali giudici hanno votato cosa, riportando la loro reason e il loro score di maturityDegree. I dati dei voti dei giudici sono: ${JSON.stringify(this.lastJudgesOutputs)}
- Nelle metriche o nel testo, indica il numero totale di debaters coinvolti (${debaterAgents.length}).

IL CAMPO "inShort" DEVE invece essere estremamente diretto al punto del dibattito. Deve risultare una sintesi umana, di alto valore, schietta e professionale, senza frasi fatte o sterili tipo "Il dibattito si è concluso...". Deve comunicare *l'esito reale*, la *decisione o realtà* emersa e l'utilità di ciò che è stato discusso, max 3 frasi.
Esempio "inShort" di valore: "L'idea XYZ ha un posizionamento di mercato sensato, ma i costi di acquisizione tramite i canali tradizionali (5K€) non sono sostenibili. La via operativa validata è il pivot su Growth Autopsy a costo zero, sfruttando la trasparenza per generare lead."
Non usare mai resoconti finti senza utilità.

Poi USA il tool "saveArtifact" per salvare l'artefatto con "summary" e "inShort".
Rispondi in formato JSON: {"summary": "sintesi estesa (max 400 parole)", "inShort": "la sintesi schietta e di alto valore per la chat (max 200 caratteri)"}`;

      const result = (await this.generate(
        moderatorAgent,
        prompt,
        summarySchema,
      )) as z.infer<typeof summarySchema>;

      const fullSummary = result.summary || "";
      const inShort = result.inShort || "";

      this.history.push({
        role: "assistant",
        content: fullSummary,
        name: moderatorAgent.name,
      });

      // We ONLY broadcast the straight-to-the-point 'inShort' to the Telegram chat
      this.broadcast(
        `**[${moderatorAgent.name} (Sunto Finale)]**\n\n${inShort}`,
      );

      // Manual call to saveArtifactTool as safety measure if Agent didn't trigger it via schema generation
      // This ensures files are ALWAYS created even if tool_use wasn't explicitly triggered by the LLM
      try {
        if (
          saveArtifactTool &&
          typeof saveArtifactTool.execute === "function"
        ) {
          await saveArtifactTool.execute({
            context: {
              summary: result.summary,
              inShort: result.inShort,
            },
            mastra: undefined,
            runtimeContext: {} as any,
          } as any);
          console.log(
            "[DebateManager] Artifacts salvati manualmente con successo.",
          );
        } else {
          console.error(
            "[DebateManager] Errore: saveArtifactTool.execute non disponibile.",
          );
        }
      } catch (saveErr) {
        console.error(
          "[DebateManager] Errore salvataggio manuale artifacts:",
          saveErr,
        );
      }
    } catch (err) {
      console.error("[DebateManager] Errore in finishDebate:", err);
    }
    if (this.onFinishedCallback) this.onFinishedCallback();
  }
}
