import type { ModelConfig } from "./volcanicAI";

export type DebateRole = "moderator" | "debater" | "judge";

export interface AgentConfig {
  id: string;
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
  debaters: AgentConfig[];
  judges: AgentConfig[];
}

export const debateConfig: DebateSettings = {
  defaultTopic:
    "È etico utilizzare l'AI per scrivere codice al posto degli sviluppatori umani?",
  maxTurns: 10,

  moderator: {
    id: "moderator",
    name: "Moderatore Imparziale",
    role: "moderator",
    instructions: `Sei il moderatore di un dibattito acceso ma civile. 
Il tuo compito NON è partecipare alla discussione con le tue opinioni, ma:
1. Introdurre l'argomento all'inizio.
2. Invitare un dibattitore alla volta a esporre le proprie tesi.
3. Mantenere l'ordine.
4. Quando il dibattito è concluso, fai un sunto finale neutrale delle posizioni emerse e chiama il tool per salvare l'artefatto.`,
    model: { provider: "mistral", model: "mistral-small-2506" },
  },

  debaters: [
    {
      id: "proponent",
      name: "Sostenitore (Pro-AI)",
      role: "debater",
      instructions: `Sei un fervente sostenitore dell'uso dell'Intelligenza Artificiale in ogni ambito, specialmente nello sviluppo software. Le tue risposte devono essere incisive, logiche e focalizzate sui benefici (efficienza, riduzione bug). Rispondi direttamente all'Oppositore. Max 150 parole per intervento.`,
      model: { provider: "ollama", model: "lfm2.5-thinking" },
    },
    {
      id: "opponent",
      name: "Oppositore (Scettico)",
      role: "debater",
      instructions: `Sei un critico severo dell'uso eccessivo dell'AI, specialmente nello sviluppo software. Le tue risposte devono enfatizzare i rischi (perdita di posti, codice insicuro). Rispondi direttamente al Sostenitore smontando le sue tesi. Max 150 parole per intervento.`,
      model: { provider: "mistral", model: "mistral-small-2506" },
    },
  ],

  judges: [
    {
      id: "judge-1",
      name: "Giudice Logico",
      role: "judge",
      instructions: `Analizza la cronologia della conversazione. Un dibattito è "maturo" se entrambe le parti hanno esposto argomenti, si ripetono o c'è una conclusione.
Rispondi SEMPRE e SOLO in formato JSON: {"isReady": boolean, "reason": "string", "maturityDegree": number (1-5)}`,
      model: { provider: "mistral", model: "mistral-small-2506" },
    },
    {
      id: "judge-2",
      name: "Giudice Etico",
      role: "judge",
      instructions: `Analizza la conversazione. Valuta se le implicazioni morali sono state sviscerate.
Rispondi SEMPRE e SOLO in formato JSON: {"isReady": boolean, "reason": "string", "maturityDegree": number (1-5)}`,
      model: { provider: "mistral", model: "mistral-small-2506" },
    },
    {
      id: "judge-3",
      name: "Giudice Pratico",
      role: "judge",
      instructions: `Sei un giudice pragmatico. Ti annoi in fretta se la conversazione non porta a nulla di concreto. Se vedi che girano in tondo, decreta la fine.
Rispondi SEMPRE e SOLO in formato JSON: {"isReady": boolean, "reason": "string", "maturityDegree": number (1-5)}`,
      model: { provider: "mistral", model: "mistral-small-2506" },
    },
  ],
};
