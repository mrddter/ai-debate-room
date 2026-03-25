import type { ModelConfig } from "./volcanicAI";

export type DebateRole = "moderator" | "debater" | "judge";

export interface AgentConfig {
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

export interface JudgeOutput {
  isReady: boolean;
  reason: string;
  maturityDegree: number;
}

export interface DebateSettings {
  defaultTopic: string;
  maxTurns: number;
  moderator: AgentConfig;
  judges: AgentConfig[];
}

import { models } from "../debaters/index";

export const debateConfig: DebateSettings = {
  defaultTopic:
    "È etico utilizzare l'AI per scrivere codice al posto degli sviluppatori umani?",
  maxTurns: 500,

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
5. Alla fine, genera un sunto neutrale salvandolo come artefatto chiamando 'saveArtifact'. Includi anche un sunto ultraconciso 'in short' per il paragrafo riassuntivo. Massimo 400 parole.`,
    model: models.mistral.small,
  },

  judges: [
    {
      enabled: true,
      id: "judge-1",
      name: "Giudice della Concretezza",
      role: "judge",
      instructions: `Analizza la conversazione. Valuta se il dibattito produce punti concreti e azionabili. Se il tavolo ha raggiunto conclusioni chiare e applicabili, decreta la fine. Rispondi SEMPRE e SOLO in formato JSON: {"isReady": boolean, "reason": "string", "maturityDegree": number (1-5)}`,
      model: models.mistral.small,
    },
    {
      enabled: true,
      id: "judge-2",
      name: "Giudice del Flusso",
      role: "judge",
      instructions: `Sei un giudice del flusso del dibattito. Analizza se i partecipanti girano in tondo ripetendo gli stessi argomenti. Se il dibattito è in stallo o se la discussione è matura ed esaurita, decreta la fine. Rispondi SEMPRE e SOLO in formato JSON: {"isReady": boolean, "reason": "string", "maturityDegree": number (1-5)}`,
      model: models.mistral.small,
    },
    {
      enabled: true,
      id: "judge-3",
      name: "Giudice Obbiettivo",
      role: "judge",
      instructions: `Analizza la conversazione in modo ultra obiettivo. Valuta se le implicazioni centrali dell'argomento sono state sviscerate. Se pensi che il dibattito sia maturo e si possa considerare concluso in modo trasparente, dillo. Rispondi SEMPRE e SOLO in formato JSON: {"isReady": boolean, "reason": "string", "maturityDegree": number (1-5)}`,
      model: models.mistral.small,
    },
  ],
};
