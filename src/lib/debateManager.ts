import { debateConfig, JudgeOutput } from "./debateConfig";
import { moderatorAgent, debaterAgents, judgeAgents } from "./agents";
import * as log from "@volcanicminds/tools/logger";

export type DebateStatus = "IDLE" | "RUNNING" | "FINISHED";
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  name?: string;
}

export class DebateManager {
  public status: DebateStatus = "IDLE";
  public topic: string = debateConfig.defaultTopic;
  public turnCount: number = 0;
  public maxTurns: number = debateConfig.maxTurns;
  public history: ChatMessage[] = [];

  private currentDebaterIndex = 0;
  private onMessageCallback?: (msg: string) => void;
  private onFinishedCallback?: () => void;

  public setOnMessage(cb: (msg: string) => void) {
    this.onMessageCallback = cb;
  }
  public setOnFinished(cb: () => void) {
    this.onFinishedCallback = cb;
  }

  public async startDebate(customTopic?: string) {
    if (this.status === "RUNNING") return;

    if (!moderatorAgent) {
      this.broadcast("❌ Errore: Moderatore non inizializzato o disabilitato.");
      return;
    }

    if (debaterAgents.length === 0) {
      this.broadcast("❌ Errore: Nessun dibattitore attivo (tutti dormienti).");
      return;
    }

    this.status = "RUNNING";
    this.topic = customTopic || debateConfig.defaultTopic;
    this.turnCount = 0;
    this.history = [];
    this.currentDebaterIndex = 0;
    this.broadcast(`🎙️ **DIBATTITO AVVIATO** 🎙️\n**Tema:** ${this.topic}\n`);
    await this.runTurn();
  }

  public stopDebate() {
    this.status = "FINISHED";
    this.broadcast(`🛑 **DIBATTITO INTERROTTO** 🛑`);
    if (this.onFinishedCallback) this.onFinishedCallback();
  }

  private broadcast(msg: string) {
    if (this.onMessageCallback) this.onMessageCallback(msg);
  }

  private formatHistoryForPrompt(): string {
    return this.history
      .map((msg) => `[${msg.name || msg.role}]: ${msg.content}`)
      .join("\n\n");
  }

  private async runTurn() {
    if (this.status !== "RUNNING") return;
    try {
      if (this.turnCount === 0) {
        log.debug("> Il dibattito ha inizio");

        const prompt = `Il dibattito sta per iniziare. Tema: "${this.topic}". Introduci brevemente (max 100 parole) e dai la parola a: ${debaterAgents[0].name}.`;
        const response = await moderatorAgent.generate(prompt);
        const content = response.text || "";
        this.history.push({
          role: "assistant",
          content,
          name: moderatorAgent.name,
        });
        this.broadcast(`**[${moderatorAgent.name}]**\n${content}`);
      } else {
        const debater = debaterAgents[this.currentDebaterIndex];
        log.debug("> La parola a " + debater.id);

        const prompt = `Il tema è: "${this.topic}". Cronologia:\n${this.formatHistoryForPrompt()}\nÈ il tuo turno. Rispondi mantenendo fermamente il tuo ruolo.`;
        const response = await debater.generate(prompt);
        const content = response.text || "";
        this.history.push({ role: "assistant", content, name: debater.name });
        this.broadcast(`**[${debater.name}]**\n${content}`);
        this.currentDebaterIndex =
          (this.currentDebaterIndex + 1) % debaterAgents.length;
      }

      this.turnCount++;

      if (this.turnCount > 1) {
        const isFinished = await this.evaluateDebate();
        if (isFinished || this.turnCount >= this.maxTurns) {
          log.debug("> Il dibattito si è concluso");
          await this.finishDebate();
          return;
        }
      }
      setTimeout(() => this.runTurn(), 3000);
    } catch (err) {
      this.stopDebate();
    }
  }

  private async evaluateDebate(): Promise<boolean> {
    const historyText = this.formatHistoryForPrompt();
    const prompt = `Ecco la cronologia:\n${historyText}\nValuta se il dibattito ha raggiunto la maturità. Rispondi SOLO con JSON: "isReady" (boolean), "reason" (string), "maturityDegree" (1-5).`;

    let readyCount = 0;
    let matureCount = 0;
    const judgesCount = judgeAgents.length;
    for (const judge of judgeAgents) {
      try {
        const response = await judge.generate(prompt);
        let text = response.text || "{}";
        text = text
          .replace(/\`\`\`json/g, "")
          .replace(/\`\`\`/g, "")
          .trim();
        const result: JudgeOutput = JSON.parse(text);
        if (result.isReady) readyCount++;
        if (result.maturityDegree >= 5) matureCount++;
      } catch (err) {}
    }
    if (readyCount === judgesCount) return true;
    const twoThirds = Math.ceil((judgesCount * 2) / 3);
    if (readyCount >= twoThirds && matureCount >= twoThirds) return true;
    return false;
  }

  private async finishDebate() {
    this.status = "FINISHED";
    this.broadcast(
      `🏁 **Il dibattito si è concluso.** Moderatore elabora sunto...`,
    );
    try {
      const prompt = `Dibattito terminato. Cronologia:\n${this.formatHistoryForPrompt()}\nFai un sunto neutrale ed evidenzia i punti in comune. Poi usa il tool per salvare l'artefatto.`;
      const response = await moderatorAgent.generate(prompt);
      const content = response.text || "";
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
