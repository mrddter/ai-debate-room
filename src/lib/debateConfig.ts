import { models } from "../lib/models";
import type { ModelConfig } from "./volcanicAI";
import { judgeOutputSchema } from "./schemas";
import type { ToolKey } from "../mcp/index";
import { z } from "zod";

export type DebateRole = "moderator" | "debater" | "judge";

export interface AgentConfig {
  // Extra tools on top of the role defaults in debateConfig.roleTools
  tools?: ToolKey[];
  id: string;
  enabled: boolean;
  name: string;
  role: DebateRole;
  instructions: string;
  model: ModelConfig;
  description?: string;
  skills?: string[];
  whenToUse?: string;
}

export type JudgeOutput = z.infer<typeof judgeOutputSchema>;

export interface DebateSettings {
  // Safety cap on speeches
  maxTurns: number;
  // Spend cap per debate in USD, estimated from src/lib/pricing.ts; 0 disables it
  maxCostUsd: number;
  // Judges vote every N speeches inside a stage; 0 means once per round (number of debaters)
  judgeEvery: number;
  roleTools: Record<DebateRole, ToolKey[]>;
  handModel: ModelConfig;
  moderator: AgentConfig;
  judges: AgentConfig[];
}

export const debateConfig: DebateSettings = {
  // Just above what the budget buys, so the budget is the real stop and this only bounds a run with the budget off
  maxTurns: 120,
  // Measured on Opus debaters: $0.32 fixed (selection, summary), about $0.16 per speech, and the transcript grows about
  // 1K tokens per speech, so cache reads add about $0.0003 x N² over N speeches: $20 buys about 100 speeches
  maxCostUsd: 20,
  judgeEvery: 0,
  roleTools: {
    moderator: [],
    debater: ["calculator"],
    judge: [],
  },
  handModel: models.hand,

  moderator: {
    enabled: true,
    id: "moderator",
    name: "🦸🏻‍♂️ Moderatore",
    role: "moderator",
    instructions: `Sei il moderatore autoritario di un dibattito tecnico. 
Il tuo compito NON è partecipare con opinioni, ma:
1. Introdurre l'argomento.
2. Coordinare il tavolo: tieni il focus su una sola idea alla volta finché non c'è consenso o bocciatura.
3. Chiedi attivamente una nuova proposta solo quando la precedente è stata validata o scartata o se l'avvocato del diavolo e/o l'avvocato diritto rifiutano l'idea.
4. Assicurati che il tavolo giunga a una chiara e utile conclusione dell'argomento.
5. Custodisci la lavagna: accetta, scarta, risolvi o collega le proposte dei debaters e aggiungi tu le decisioni prese dal tavolo. Solo ciò che accetti diventa stato condiviso.
6. Dai la parola preferendo chi ha alzato la mano con un tema pertinente, ma chiama direttamente chi serve quando la coda non copre il punto aperto.
7. Alla fine, genera un sunto neutrale con un sunto ultraconciso 'in short'. Massimo 400 parole.`,
    model: models.moderator,
  },

  judges: [
    {
      enabled: true,
      id: "judge-1",
      name: "Giudice della Concretezza",
      role: "judge",
      instructions: `Analizza la conversazione. Valuta se il dibattito produce punti concreti e azionabili. Se il tavolo ha raggiunto conclusioni chiare e applicabili, decreta la fine.`,
      model: models.judge,
    },
    {
      enabled: true,
      id: "judge-2",
      name: "Giudice del Flusso",
      role: "judge",
      instructions: `Sei un giudice del flusso del dibattito. Analizza se i partecipanti girano in tondo ripetendo gli stessi argomenti. Se il dibattito è in stallo o se la discussione è matura ed esaurita, decreta la fine.`,
      model: models.judge,
    },
    {
      enabled: true,
      id: "judge-3",
      name: "Giudice Obbiettivo",
      role: "judge",
      instructions: `Analizza la conversazione in modo ultra obiettivo. Valuta se le implicazioni centrali dell'argomento sono state sviscerate. Se pensi che il dibattito sia maturo e si possa considerare concluso in modo trasparente, dillo.`,
      model: models.judge,
    },
  ],
};
