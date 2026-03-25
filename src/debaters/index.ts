export const addendum = `Regola d'ingaggio tassativa: Se l'attuale stato della discussione e dell'argomento non tocca la tua specifica area di competenza, o se non hai obiezioni/aggiunte di altissimo valore che cambiano le carte in tavola, rispondi ESATTAMENTE e SOLO con: 'Non ho nulla da dire. Passo la parola'. Non riassumere, non fare complimenti e non ripetere concetti già detti. Parla solo se devi distruggere un'idea o migliorarla concretamente. Max 80 parole per intervento, ma usane meno se puoi. Sii telegrafico, realista, cinico e vai dritto al punto.`;

export const models = {
  default: { provider: "ollama", model: "gemini-3-flash-preview:cloud" },
  mistral: {
    small: { provider: "mistral", model: "mistral-small-latest" },
    medium: { provider: "mistral", model: "mistral-medium-latest" },
    large: { provider: "mistral", model: "mistral-large-latest" },
  },
  ollama: {
    lfm: { provider: "ollama", model: "lfm2.5-thinking" },
  },
} as const;
