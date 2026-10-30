import type { AgentConfig } from "./debateConfig";
import {
  MODE_LABELS,
  MODE_STAGES,
  MODERATOR_ID,
  STAGE_LABELS,
  USER_ID,
  type DebateMode,
  type DebateStage,
  type FinishReason,
} from "./session/events";
import { latestVerdicts, nameOf, type DebateState, type TranscriptMessage } from "./session/state";
import { renderBoard } from "./session/whiteboard";
import type { ChainPrompt, TextResult } from "./llm";

export type SelectionMode = { kind: "auto" } | { kind: "smart" } | { kind: "direct"; input: string } | { kind: "feedback"; input: string };

interface StageRules {
  debater: string;
  moderator: string;
  judge: string;
}

const STAGE_RULES: Record<DebateStage, StageRules> = {
  explore: {
    debater:
      "Allarga il quadro: porta opzioni, ipotesi, dati e domande. Puoi segnalare un rischio, ma non bocciare un'idea prima che sia definita.",
    moderator:
      "Fai emergere opzioni e ipotesi diverse, dai la parola a chi porta punti nuovi e rimanda le bocciature alla fase di critica.",
    judge:
      "La fase è completa quando le opzioni principali e le ipotesi chiave sono sul tavolo e i nuovi interventi non aggiungono alternative.",
  },
  critique: {
    debater:
      "Metti alla prova le opzioni emerse: cerca punti deboli, numeri che non tornano e rischi concreti, e proponi come correggerli.",
    moderator:
      "Fai stressare le opzioni una alla volta, chiama chi può smontarle o difenderle con dati e scarta in lavagna ciò che non regge.",
    judge: "La fase è completa quando ogni opzione rilevante è stata messa alla prova e restano poche alternative difendibili.",
  },
  decide: {
    debater:
      "Converge: indica cosa scegliere, a quali condizioni e con quali primi passi. Niente idee nuove, salvo per sbloccare una scelta.",
    moderator: "Porta il tavolo a scelte esplicite, registra le decisioni in lavagna e chiudi le domande aperte.",
    judge:
      "La fase è completa quando c'è una decisione chiara con condizioni e prossimi passi, oppure è chiaro perché non si può decidere.",
  },
  brainstorm: {
    debater:
      "Nessun freno: porta idee audaci, anche controintuitive, e costruisci su quelle degli altri ('sì, e' invece di 'no, ma'). In questa modalità la regola di distruggere le idee e di essere cinico non vale: non bocciare e non criticare. Passa la parola solo se non hai davvero un'idea nuova.",
    moderator:
      "Punta al maggior numero di idee distinte: dai la parola a chi porta idee nuove, scoraggia le critiche, registra in lavagna ogni idea distinta (tipo idea). Qui non serve tenere il focus su una sola idea alla volta.",
    judge:
      "Il brainstorming è completo quando il tavolo ha prodotto un ventaglio ampio di idee distinte e gli ultimi interventi ripetono o variano idee già emerse.",
  },
};

function stageLine(state: DebateState, role: keyof StageRules): string {
  return `FASE ATTUALE: ${STAGE_LABELS[state.stage]}. ${STAGE_RULES[state.stage][role]}`;
}

// Static on purpose: a stage change must not depend on a model call
export function stageAnnouncement(stage: DebateStage): string {
  return `Si passa alla fase di ${STAGE_LABELS[stage]}. ${STAGE_RULES[stage].debater}`;
}

function formatMessage(state: DebateState, message: TranscriptMessage): string {
  const replyTo = message.replyTo.length > 0 ? ` (a ${message.replyTo.map((id) => nameOf(state, id)).join(", ")})` : "";
  return `[t${message.turn}] ${nameOf(state, message.speakerId)}${replyTo}: ${message.text}`;
}

// Fixed once the debaters are selected: it opens every cached conversation
function conversationHeader(state: DebateState): string {
  const participants = state.debaters.map((debater) => `- ${debater.id}: ${debater.name}`).join("\n");
  return `DIBATTITO
Tema: "${state.topic}"
Modalità: ${MODE_LABELS[state.mode]}
Partecipanti:
${participants}
- ${USER_ID}: ${nameOf(state, USER_ID)} (ha commissionato il dibattito; interviene solo quando chiede la parola)
- ${MODERATOR_ID}: ${nameOf(state, MODERATOR_ID)}

Segue la trascrizione completa, un messaggio per blocco nel formato [tN] Nome (a destinatari): testo, dove N è il numero di interventi completati.`;
}

/** The whole debate as append-only blocks plus the tail of this call: every agent sees the same transcript. */
function conversation(state: DebateState, tail: string): ChainPrompt {
  return { blocks: [conversationHeader(state), ...state.messages.map((message) => formatMessage(state, message))], tail };
}

const board = (state: DebateState) => renderBoard(state.board, (id) => nameOf(state, id));
const roster = (state: DebateState) =>
  state.debaters.map((debater) => `- ${debater.id}: ${debater.name} (${state.spokenCount[debater.id] ?? 0} interventi)`).join("\n");

function persona(debater: AgentConfig): string {
  return [
    `${debater.name} (ID ${debater.id})`,
    debater.description,
    debater.skills?.length ? `Competenze: ${debater.skills.join(", ")}` : "",
    debater.whenToUse ? `Quando interviene: ${debater.whenToUse}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function selectionPrompt(topic: string, sortedAvailable: AgentConfig[], mode: SelectionMode): string {
  const rosterList = sortedAvailable
    .map(
      (d, i) =>
        `- INDICE: ${i + 1} | ID: ${d.id} | Name: ${d.name} | Skills: ${d.skills?.join(", ") || ""} | WhenToUse: ${d.whenToUse || ""} | Descrizione: ${d.description ? d.description + " - " : ""}${d.instructions}`,
    )
    .join("\n\n");

  const base = `Sei il moderatore. L'argomento del dibattito è: "${topic}".
Ecco l'elenco di tutti i profili disponibili per partecipare:
${rosterList}

REGOLE PER LA SELEZIONE (MOLTO IMPORTANTE):
1. Assicurati che la discussione sia di valore e proceda in modo incrementale.
2. Se il topic riguarda una nuova idea, un nuovo business o un tema ignoto, coinvolgi SEMPRE in prima battuta le figure fondamentali per posizionare e definire l'idea (es. Founder, Esperto di Mercato, Business Analyst).
3. NON coinvolgere prematuramente figure di freno (es. Avvocato, esperto GDPR, Legale) se l'idea non è ancora solida o matura, a meno che non siano strettamente pertinenti al core del topic. L'obiettivo è creare prima un quadro molto solido.
4. L'array "debaters" DEVE contenere ALMENO 5 e MASSIMO 13 debaters che ritieni più adatti.
`;

  switch (mode.kind) {
    case "smart":
      return `${base}
L'UTENTE HA RICHIESTO LA MODALITÀ SMART.
Devi analizzare in profondità il topic e decidere di quali figure necessita il tavolo.
Cerca i candidati ideali tra i profili disponibili sopra e includi i loro "id" in "debaters".
TUTTAVIA, se ti accorgi che mancano figure fondamentali o necessiti di ruoli specifici non presenti, DEVI crearli da zero.
Per i nuovi debaters, popolali nell'array "newDebaters", fornendo "id" (formato snake_case univoco e diverso dagli ID esistenti, ad es. "esperto_blockchain"), "name", "reason", "skills", "whenToUse", "description", "instructions" (un prompt comportamentale dettagliato per la personalità dell'agente) e opzionalmente "tools" (array di stringhe, che può includere "webSearch" per ricerche web e/o "webFetch" per leggere URL specifici, assegnali solo se realmente utili al ruolo).
Rispondi in formato JSON con:
- "debaters": array dei debaters scelti dall'elenco.
- "newDebaters": array dei debaters creati al volo (può essere vuoto se non necessari).
- "moderatorMessage": spiega brevemente in italiano le tue scelte e presenta all'utente i nuovi profili proposti.`;
    case "direct":
      return `${base}
L'UTENTE HA FORNITO IL SUO ELENCO DI PREFERENZE IN NUMERI (che corrispondono agli "INDICE" sopra):
"${mode.input}"

ATTENZIONE: DEVI estrarre gli "INDICE" forniti dall'utente e trovare gli "ID" corrispondenti nell'elenco. DEVI accettare incondizionatamente le scelte dell'utente includendo TUTTI (e solo) i relativi "ID" da lui scelti nel campo "debaters".
Tuttavia, se lo ritieni necessario, puoi valutare questa lista ed emettere dei suggerimenti nel campo opzionale "moderatorMessage". Ad esempio puoi dire:
"Ho ricevuto il tuo elenco e l'ho impostato come richiesto. Visto il topic, ti consiglio di includere anche [Nome] e di escludere [Nome] per [motivo]. Che ne pensi? Vuoi che proceda così o vuoi applicare le mie modifiche?"
Se l'elenco dell'utente va benissimo così, puoi scrivere semplicemente: "L'elenco proposto mi sembra ottimo e copre tutti gli aspetti essenziali. Vuoi che proceda e dia il via al dibattito?"

Rispondi in formato JSON con l'oggetto contenente:
- "debaters": la lista degli agenti scelti (che DEVE includere ESATTAMENTE quelli chiesti dall'utente). Ogni oggetto ha "id" e "reason".
- "moderatorMessage": la tua risposta conversazionale (in italiano) rivolta all'utente, dove gli comunichi eventuali suggerimenti e gli chiedi conferma.`;
    case "feedback":
      return `${base}
L'UTENTE HA FORNITO UN FEEDBACK SULLA TUA PRECEDENTE SELEZIONE (i numeri forniti dall'utente corrispondono agli "INDICE" sopra):
"${mode.input}"

Analizza il messaggio dell'utente. Devi variare l'elenco con le modifiche richieste dall'utente convertendo i numeri negli ID corrispondenti.
Rispondi in formato JSON con l'oggetto aggiornato che contiene la chiave "debaters" (ognuno con "id" e "reason"). Se lo ritieni opportuno, puoi compilare il campo "moderatorMessage" per commentare le variazioni apportate.`;
    case "auto":
      return `${base}
Seleziona gli agenti migliori per iniziare la mappa mentale e la discussione attorno al topic, tenendo conto delle regole sopra.
Rispondi in formato JSON con un oggetto che contiene la chiave "debaters", il cui valore è un array di oggetti dove ogni oggetto ha "id" e "reason" (una breve spiegazione del perché lo hai scelto, max 20 parole).`;
    default: {
      const unknownMode: never = mode;
      throw new Error(`Unknown selection mode ${JSON.stringify(unknownMode)}`);
    }
  }
}

export function introPrompt(state: DebateState): string {
  return `Il dibattito sta per iniziare. Tema: "${state.topic}".
Modalità: ${MODE_LABELS[state.mode]}.
${stageLine(state, "moderator")}
Partecipanti:
${roster(state)}

Introduci brevemente il tema (max 100 parole), indica il primo nodo da sciogliere e invita chi ha qualcosa di pertinente ad alzare la mano. Rispondi solo con il testo dell'introduzione.`;
}

export function handPrompt(state: DebateState, debater: AgentConfig): ChainPrompt {
  const queue = state.queue.map((hand) => `- ${nameOf(state, hand.debaterId)} [${hand.kind}]: ${hand.pitch}`).join("\n");
  return conversation(
    state,
    `PARTECIPANTE CHE RAPPRESENTI:
${persona(debater)}

IL SUO TACCUINO:
${state.notebooks[debater.id] || "vuoto"}

LAVAGNA:
${board(state)}

MANI GIÀ ALZATE:
${queue || "nessuna"}

${stageLine(state, "debater")}

Deve alzare la mano adesso? Alzala solo per una replica a un punto preciso, un punto nuovo, una domanda che sblocca o un dato concreto, e non se ripete ciò che è in lavagna o nelle mani già alzate.
ID validi per target: ${[...state.debaters.map((d) => d.id), USER_ID].join(", ")}.`,
  );
}

export function routingPrompt(state: DebateState): ChainPrompt {
  const pending = state.board.items
    .filter((item) => item.status === "proposed")
    .map((item) => `- [${item.id}] (${item.kind}) ${item.text}${item.url ? ` ${item.url}` : ""} · da ${nameOf(state, item.author)}`)
    .join("\n");
  const queue = state.queue
    .map((hand) => {
      const target = hand.target ? ` → ${nameOf(state, hand.target)}` : "";
      return `- ${hand.debaterId} (${nameOf(state, hand.debaterId)}) [${hand.kind}] "${hand.pitch}"${target}, in attesa da ${state.turn - hand.raisedTurn} turni`;
    })
    .join("\n");
  const last = state.lastSpeakerId ? `${state.lastSpeakerId} (${nameOf(state, state.lastSpeakerId)})` : "nessuno";
  const userWaiting = state.queue.some((hand) => hand.debaterId === USER_ID)
    ? `\nIL COMMITTENTE HA CHIESTO LA PAROLA: dagliela ora (nextSpeakerId "${USER_ID}", source "queue") con una transizione rivolta a lui.\n`
    : "";

  return conversation(
    state,
    `Sei il moderatore e il custode della lavagna. Interventi finora: ${state.turn}.
${stageLine(state, "moderator")}

LAVAGNA:
${board(state)}

PROPOSTE IN ATTESA DI RATIFICA:
${pending || "nessuna"}

CODA DELLE MANI ALZATE (in ordine di arrivo):
${queue || "nessuna mano alzata"}

PARTECIPANTI:
${roster(state)}
${userWaiting}
Fai due cose:
1) Lavagna: per ogni proposta in attesa decidi "accept" o "reject" (motivazione in "text"). Usa "add" per registrare decisioni o domande aperte emerse dal tavolo, "resolve" per chiudere una domanda con l'esito, "link" per collegare elementi, "edit" per correggere un testo. Non duplicare elementi già presenti.
2) Parola: scegli chi parla ora. Preferisci la coda (source "queue") quando una mano alzata porta avanti il punto aperto; chiama direttamente (source "called") chi serve quando nessuno in coda copre il punto o qualcuno deve una replica. Non dare la parola a chi ha appena parlato: ${last}.`,
  );
}

export function researchPrompt(state: DebateState, debater: AgentConfig): ChainPrompt {
  return conversation(
    state,
    `Sei ${debater.name} (ID ${debater.id}) e il moderatore ti ha appena dato la parola.
${stageLine(state, "debater")}

LAVAGNA:
${board(state)}

Prima di intervenire puoi verificare dati attuali sul web. Cerca solo se il tuo intervento dipende da dati, prezzi, concorrenti o fatti recenti.
Scrivi note sintetiche (max 150 parole) con i dati trovati e l'URL di ogni fonte. Se non serve cercare, rispondi solo: NESSUNA RICERCA.`,
  );
}

export function speechPrompt(state: DebateState, debater: AgentConfig, research: TextResult | null): ChainPrompt {
  const sources = research?.sources.map((source) => `- ${source.title}: ${source.url}`).join("\n");
  const researchBlock = research
    ? `\nLA TUA RICERCA WEB:\n${research.text}\n${sources ? `Fonti citabili:\n${sources}\n` : ""}`
    : "";

  return conversation(
    state,
    `Sei ${debater.name} (ID ${debater.id}).
${stageLine(state, "debater")}

LAVAGNA (stato condiviso, ID tra parentesi quadre):
${board(state)}

IL TUO TACCUINO PRIVATO:
${state.notebooks[debater.id] || "vuoto"}
${researchBlock}
PARTECIPANTI:
${roster(state)}

È il tuo turno. Rispondi mantenendo fermamente il tuo ruolo, costruendo sul discorso precedente e su ciò che è in lavagna, nel rispetto della fase attuale.
Campi da compilare:
- "text": il tuo intervento.
- "replyTo": ID dei partecipanti a cui rispondi direttamente (anche "${MODERATOR_ID}" o "${USER_ID}").
- "notebook": il tuo taccuino aggiornato (posizioni, impegni, obiezioni aperte), sostituisce il precedente.
- "proposals": massimo 3 proposte per la lavagna; le fonti ("source") solo con un URL preso dalla tua ricerca web.`,
  );
}

export function judgePrompt(state: DebateState): ChainPrompt {
  const stages = MODE_STAGES[state.mode];
  const position = stages.indexOf(state.stage);
  const next = stages[position + 1];
  const outcome = next
    ? `Se la fase è conclusa il tavolo passa alla fase di ${STAGE_LABELS[next]}.`
    : "È l'ultima fase: se è conclusa il dibattito termina.";
  return conversation(
    state,
    `Sei un giudice del dibattito. Interventi finora: ${state.turn}.
FASE DA VALUTARE: ${STAGE_LABELS[state.stage]} (${position + 1} di ${stages.length}). ${STAGE_RULES[state.stage].judge}

LAVAGNA (stato ratificato dal moderatore):
${board(state)}

Valuta se la fase attuale è giunta a conclusione tenendo conto del tuo specifico ruolo di giudice. ${outcome} Le regole generali sono:
1. Obiettivo raggiunto: l'obiettivo della fase è raggiunto (isReady: true).
2. Loop: i partecipanti girano in tondo ripetendosi senza progredire da troppo tempo (isReady: true, con una reason adeguata).

Se la fase sta procedendo proficuamente ma non ha ancora raggiunto l'obiettivo, rispondi con isReady: false.
Rispondi SOLO in formato JSON valido: {"isReady": boolean, "reason": "string", "maturityDegree": numero_da_1_a_5}`,
  );
}

const FINISH_TEXT: Record<FinishReason, string> = {
  judges: "per il voto dei giudici",
  max_turns: "per il raggiungimento del numero massimo di turni",
  budget: "per il raggiungimento del budget di spesa",
  user_stop: "per interruzione dell'utente",
  error: "per un errore tecnico",
};

const FOCUS_BY_MODE: Record<DebateMode, string> = {
  structured: "decisioni prese con le loro condizioni, numeri chiave, rischi aperti e prossimi passi concreti",
  wild: "le idee più promettenti, ciascuna con il motivo per cui vale la pena approfondirla",
};

export function summaryPrompt(state: DebateState, reason: FinishReason): ChainPrompt {
  const verdicts = latestVerdicts(state).map(({ judgeName, isReady, reason: why, maturityDegree }) => ({ judgeName, isReady, reason: why, maturityDegree }));
  const budget = state.settings.maxCostUsd > 0 ? `, budget: ${state.settings.maxCostUsd} USD` : "";
  return conversation(
    state,
    `Dibattito terminato ${FINISH_TEXT[reason]}. Fase raggiunta: ${STAGE_LABELS[state.stage]}.

LAVAGNA FINALE:
${board(state)}

Fai un sunto neutrale della discussione fin qui svoltasi, partendo da ciò che la lavagna registra come deciso, aperto o scartato.

DEVI includere una sezione "Giudizio Finale" nel campo "summary" in cui indichi:
- Perché il dibattito si è concluso: ${FINISH_TEXT[reason]} (limite massimo: ${state.settings.maxTurns} turni${budget}).
- Quali giudici hanno votato cosa, riportando la loro reason e il loro score di maturityDegree. I dati dei voti dei giudici sono: ${JSON.stringify(verdicts)}
- Il numero totale di debaters coinvolti (${state.debaters.length}) e di interventi (${state.turn}).

IL CAMPO "inShort" DEVE invece essere estremamente diretto al punto del dibattito. Deve risultare una sintesi umana, di alto valore, schietta e professionale, senza frasi fatte o sterili tipo "Il dibattito si è concluso...". Deve comunicare *l'esito reale*, la *decisione o realtà* emersa e l'utilità di ciò che è stato discusso, max 3 frasi.
Esempio "inShort" di valore: "L'idea XYZ ha un posizionamento di mercato sensato, ma i costi di acquisizione tramite i canali tradizionali (5K€) non sono sostenibili. La via operativa validata è il pivot su Growth Autopsy a costo zero, sfruttando la trasparenza per generare lead."
Non usare mai resoconti finti senza utilità.

IL CAMPO "focalPoints" contiene da 3 a 7 punti focali, ciascuno di massimo 35 parole, da leggere in 1-2 minuti in tutto: ${FOCUS_BY_MODE[state.mode]}. Non ripetere l'inShort e non usare frasi generiche.

Rispondi in formato JSON: {"summary": "sintesi estesa (max 400 parole)", "inShort": "la sintesi schietta e di alto valore per la chat (max 200 caratteri)", "focalPoints": ["punto 1", "punto 2"]}`,
  );
}
