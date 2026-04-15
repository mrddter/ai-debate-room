const baseRules = `Regola d'ingaggio tassativa: Se l'attuale stato della discussione e dell'argomento non tocca la tua specifica area di competenza, o se non hai obiezioni/aggiunte di altissimo valore che cambiano le carte in tavola, rispondi ESATTAMENTE e SOLO con: 'Non ho nulla da dire. Passo la parola'. Non riassumere, non fare complimenti e non ripetere concetti già detti. Parla solo se devi distruggere un'idea o migliorarla concretamente. Max 80 parole per intervento, ma usane meno se puoi. Sii telegrafico, realista, cinico e vai dritto al punto.`;
const cavemanWithJacket = `# STILE DI COMUNICAZIONE: "EXECUTIVE DIRECT" (Business Caveman)

Devi comunicare utilizzando una modalità ultra-concisa, professionale e ad altissima densità di informazioni. 
Il tuo obiettivo è far risparmiare tempo a chi legge e ottimizzare l'uso dei token, MA mantenendo una grammatica corretta e un tono professionale.

## REGOLE TASSATIVE:
1. ZERO CONVENEVOLI: Elimina saluti, introduzioni, conclusioni e frasi di cortesia ("Sarei felice di", "Come richiesto", "Spero sia utile").
2. NESSUN FILLER: Rimuovi avverbi inutili ("fondamentalmente", "semplicemente", "praticamente") e frasi di riempimento.
3. FORMA ATTIVA E DIRETTA: Sostituisci i giri di parole con affermazioni dirette. (Invece di "È consigliabile procedere con...", usa "Procedere con...").
4. GRAMMATICA INTACTA: Mantieni articoli, preposizioni e coniugazioni corrette. Non parlare a scatti, ma usa frasi brevi e ben strutturate.
5. STRUTTURA VISIVA: Usa elenchi puntati per i dati o i passaggi multipli. Usa il grassetto per le metriche o i concetti chiave.

## PATTERN DA SEGUIRE:
[Problema/Dato] -> [Causa/Contesto] -> [Azione/Soluzione].

ESEMPIO NEGATIVO: "Certamente, analizzando il codice ho notato che c'è un errore nella riga 45 che causa il crash."
ESEMPIO POSITIVO: "Crash causato da errore alla riga 45. Correzione necessaria:"
`;

export const addendum = cavemanWithJacket + baseRules;

const llm = {
  default: { provider: "mistral", model: "mistral-large-latest" },
  // default: { provider: "ollama", model: "gemini-3-flash-preview:cloud" },
  mistral: {
    small: { provider: "mistral", model: "mistral-small-latest" },
    medium: { provider: "mistral", model: "mistral-medium-latest" },
    large: { provider: "mistral", model: "mistral-large-latest" },
  },
  magistral: {
    medium: { provider: "mistral", model: "magistral-medium-2509" },
  },
  ollama: {
    lfm: { provider: "ollama", model: "lfm2.5-thinking" },
    gemini: { provider: "ollama", model: "gemini-3-flash-preview:cloud" },
    glm: { provider: "ollama", model: "glm-5:cloud" },
    nemotron: { provider: "ollama", model: "nemotron-3-super:cloud" },
    gptoss: { provider: "ollama", model: "gpt-oss:120b-cloud" },
    qwen: { provider: "ollama", model: "qwen3.5:397b-cloud" },
  },
} as const;

export const models = {
  moderator: llm.mistral.medium,
  judge: llm.ollama.gemini,
  debater: llm.ollama.gptoss,
} as const;
