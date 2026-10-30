# AI Debate Room 🎙️🧠

Un sistema avanzato basato su AI Agent orchestrati per simulare e condurre un vero e proprio "tavolo tecnico" di alto livello. Il sistema sfrutta modelli LLM e il framework @mastra/core per far interagire tra loro Agenti autonomi (esperti di settore, CEO, avvocati, growth hacker) e un Moderatore autoritario, con lo scopo di sviscerare idee, validare business e produrre output progettuali concreti.

## Come funziona

La AI Debate Room è uno strumento di progettazione e brainstorming: un moderatore conduce il tavolo, i debater discutono e tre giudici stabiliscono quando il confronto ha prodotto abbastanza. Ogni dibattito viene registrato come sequenza di eventi su disco, quindi niente va perso e un dibattito interrotto può ripartire da dove si era fermato.

### Alzata di mano

Dopo ogni intervento, ciascun debater decide con una chiamata breve a Haiku se chiedere la parola, dichiarando il tipo di intervento (replica, nuovo punto, domanda, dato) e un pitch di al massimo 12 parole. Le mani restano in coda finché non vengono servite o abbassate. Il moderatore sceglie dalla coda oppure chiama direttamente chi serve; se indica un partecipante inesistente o chi ha appena parlato, il sistema passa la parola alla prima mano in coda o a chi ha parlato meno.

### Lavagna

La lavagna raccoglie decisioni, domande aperte, ipotesi, fonti e note, ciascuna con un identificativo (W1, W2 e così via). I debater possono solo proporre elementi; il moderatore li accetta o li scarta, chiude le domande risolte e collega gli elementi tra loro. Gli elementi scartati restano visibili come "non riproporre". Una fonte entra in lavagna solo se il suo URL è stato restituito davvero dalla ricerca web di quel debater, così gli indirizzi inventati dal modello vengono scartati.

### Memoria dei debater

Ogni debater tiene un taccuino personale che aggiorna a ogni intervento. Nel prompt riceve gli ultimi 8 messaggi del tavolo (`contextWindow`) più quelli rivolti a lui anche se più vecchi, e con lo strumento `searchTranscript` può cercare nell'intera trascrizione.

### Giudici

Tre giudici valutano il dibattito una volta per giro, cioè ogni N interventi con N pari al numero di partecipanti (`judgeEvery` in `src/lib/debateConfig.ts` cambia la frequenza). Il dibattito si chiude quando sono tutti pronti, oppure quando almeno due terzi sono pronti e due terzi assegnano maturità 5; il limite di sicurezza è di 500 interventi.

### Debater fissi e smart

Il roster pre-configurato è in `src/debaters/`. In modalità smart il moderatore può proporre ruoli nuovi quando mancano competenze: vengono scritti come file TypeScript in `src/debaters/` solo alla conferma della selezione e non sovrascrivono mai un debater esistente.

## Strumenti

Gli strumenti si assegnano per ruolo in `roleTools` (`src/lib/debateConfig.ts`) e per singolo debater nel campo `tools`:

- `calculator`: valuta espressioni aritmetiche senza eseguire codice; attivo per tutti i debater.
- `searchTranscript`: cerca nella trascrizione del dibattito; attivo per moderatore e debater.
- `webSearch` e `webFetch`: ricerca e lettura web native di Anthropic, al massimo 3 usi per chiamata. Le usano solo i debater che le hanno nel campo `tools` (oggi `trend_hunter`), in una fase di ricerca separata prima dell'intervento; le fonti trovate entrano nel prompt e possono essere proposte in lavagna. Ogni ricerca si paga a parte rispetto ai token (listino Anthropic: 10 dollari ogni 1.000 ricerche).

## Comandi Telegram

L'interfaccia è un bot Telegram con questi comandi:

- `/start` o `/help`: mostra le istruzioni base.
- `/debate <argomento>`: avvia un nuovo dibattito (es. `/debate Creare una piattaforma SaaS per dentisti`); senza argomento il bot chiede su quale tema e non avvia nulla.
- `/status`: stato, argomento, interventi, mani alzate e consumo (chiamate LLM, token, ricerche web).
- `/whiteboard`: mostra la lavagna corrente.
- `/stop`: interrompe il dibattito anche durante una chiamata in corso e fa comunque generare il sunto finale; durante la selezione la annulla.
- `/resume`: riprende l'ultimo dibattito rimasto a metà, per esempio dopo un riavvio del bot.

Da incollare in BotFather:

```
start - Messaggio di benvenuto
help - Mostra istruzioni di base
debate - Inizia un dibattito (es /debate Nuova idea)
status - Mostra stato e consumi
whiteboard - Mostra la lavagna
stop - Interrompe il dibattito
resume - Riprende un dibattito interrotto
```

Quando avvii un dibattito, il bot chiede come scegliere i partecipanti:

- numeri (es. `1, 4, 7`): scegli tu dalla lista;
- `mod` o `automatico`: il moderatore sceglie la squadra dalla lista esistente;
- `smart`: il moderatore sceglie e, se mancano competenze, crea ruoli nuovi.

Sulla proposta del moderatore rispondi `ok` o `conferma` per partire; qualunque altro testo vale come feedback (es. `aggiungi 2, togli il legale`) e il moderatore rivede la squadra.

## Artefatti e ripresa

Ogni dibattito ha una cartella `artifacts/<aammgg-hhmmss>-debate/`. La fonte di verità è `events.jsonl`, un evento per riga scritto subito su disco: interventi, mani alzate, scelte del moderatore, lavagna, ricerche, voti dei giudici e consumo di token. Da questo file si ricostruiscono `topic.md`, `chat.md`, `whiteboard.md`, `sunto-finale.md` (con le metriche) e `viewer.html`, una pagina autonoma con cronologia filtrabile, lavagna e metriche. Per rigenerarli: `npm run render -- artifacts/<cartella>`.

## Sviluppo

`npm run type-check` controlla i tipi. `npm test` esegue la suite con modelli finti, senza chiamate a pagamento: regole di turno, lavagna, log degli eventi, file dei debater generati e dibattiti completi, compresi interruzione e ripresa.

## Come Configurare il Bot Telegram

Per far funzionare il progetto, devi collegare il bot usando **BotFather** su Telegram.

1. Apri Telegram e cerca **@BotFather**.
2. Scrivi `/newbot` e segui le istruzioni per dare un nome e uno username al tuo bot.
3. BotFather ti fornirà un **Token HTTP API** (es. `123456789:ABCDefghIJKLmnopQRST...`). Copialo.
4. Vai nella chat del bot appena creato o in un gruppo in cui lo hai aggiunto e scrivi un messaggio qualsiasi.
5. Per ottenere il tuo `Chat ID`, puoi forwardare il messaggio al bot `@userinfobot` o usare le API di Telegram per leggere il tuo ID (il bot include un middleware di sicurezza che risponderà **solo** alla chat configurata in questo ID).
6. Crea un file `.env` nella root del progetto o esporta queste variabili d'ambiente:
   \`\`\`bash
   TELEGRAM_BOT_TOKEN="il_tuo_token_qui"
   TELEGRAM_CHAT_ID="il_tuo_chat_id_qui"
   ANTHROPIC_API_KEY="la_tua_chiave_anthropic"
   \`\`\`
   I modelli per ruolo (moderatore, debater, giudici, alzata di mano) si scelgono in `src/lib/models.ts`; ogni provider legge la chiave da `<PROVIDER>_API_KEY` (es. `MISTRAL_API_KEY`).
7. Installa le dipendenze con `npm install` e avvia con `npm run dev`.
