import type { ModelConfig } from "./volcanicAI";

export type DebateRole = "moderator" | "debater" | "judge";

export interface AgentConfig {
  id: string;
  enabled: boolean;
  name: string;
  role: DebateRole;
  instructions: string;
  model: ModelConfig;
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
4. Assicurati che vengano prodotte ed elencate chiaramente 5 idee di business distinte.
5. Alla fine, genera un sunto neutrale salvandolo come artefatto. Massimo 400 parole.`,
    model: models.mistral.small,
  },

  judges: [
    {
      enabled: true,
      id: "judge-1",
      name: "Giudice Logico",
      role: "judge",
      instructions: `Analizza la cronologia. Il dibattito è pronto SOLO SE sono state approvate 5 IDEE distinte dai validatori. Se sono meno di 5, continua a far parlare il tavolo.
Rispondi SEMPRE e SOLO in formato JSON: {"isReady": boolean, "reason": "string", "maturityDegree": number (1-5)}`,
      model: models.mistral.small,
    },
    {
      enabled: true,
      id: "judge-2",
      name: "Giudice Coerente",
      role: "judge",
      instructions: `Analizza la conversazione. Valuta se le implicazioni tecniche, di business o fortemente focali alla discussione sono state sviscerate e analizzate.
Rispondi SEMPRE e SOLO in formato JSON: {"isReady": boolean, "reason": "string", "maturityDegree": number (1-5)}`,
      model: models.mistral.small,
    },
    {
      enabled: true,
      id: "judge-3",
      name: "Giudice Pratico",
      role: "judge",
      instructions: `Sei un giudice pragmatico. Ti annoi in fretta se la conversazione non porta a nulla di concreto ma sai attendere i giusti risultati (secondo l'argomento introdotto dal moderatore). Se vedi che girano in tondo, decreta la fine.
Rispondi SEMPRE e SOLO in formato JSON: {"isReady": boolean, "reason": "string", "maturityDegree": number (1-5)}`,
      model: models.mistral.small,
    },
  ],
};
