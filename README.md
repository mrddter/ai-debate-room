# AI Debate Room 🎙️🧠

Un sistema avanzato basato su AI Agent orchestrati per simulare e condurre un vero e proprio "tavolo tecnico" di alto livello. Il sistema sfrutta modelli LLM e il framework @mastra/core per far interagire tra loro Agenti autonomi (esperti di settore, CEO, avvocati, growth hacker) e un Moderatore autoritario, con lo scopo di sviscerare idee, validare business e produrre output progettuali concreti.

## Opportunità e Modo di Lavorare

La AI Debate Room non è una semplice simulazione, ma un potente strumento di **progettazione e brain-storming**. Le meccaniche chiave includono:

- **La Lavagna (Whiteboard) Condivisa**: Durante il dibattito, il Moderatore condensa i punti assodati su una "lavagna". Questo mantiene il tavolo focalizzato sull'obiettivo ed evita deragliamenti, portando ad un risultato finale molto più elevato rispetto a una semplice chat di botta e risposta.
- **Meccanica "Alzata di Mano"**: A fine turno, il Moderatore interpella i profili più adatti alla situazione corrente chiedendo quanto sia cruciale un loro intervento immediato (su una scala da 1 a 10). L'agente più motivato e pertinente ottiene la parola, creando una dinamica realistica in cui gli esperti intervengono "di prepotenza" se viene toccata la loro materia (es. l'avvocato se emergono problemi legali).
- **Modalità "Smart" per Creazione Agenti**: Oltre all'ampio roster di debaters già pre-configurati in `src/debaters/`, il Moderatore può analizzare il tuo argomento e **creare nuovi ruoli al volo**, salvandoli fisicamente come file TypeScript per essere riutilizzati in futuro, se ritiene che manchino le giuste competenze al tavolo.
- **Giudici Imparziali**: Fino a 5 agenti Giudici osservano in background valutando obiettivamente maturità, flusso e concretezza della discussione per decretarne la fine in modo naturale.

## Comandi Telegram

L'interfaccia utente principale è un Bot Telegram. Ecco i comandi a disposizione:

- `/start` o `/help`: Avvia il bot e mostra le istruzioni base.
- `/debate [argomento]`: Inizia un nuovo dibattito (es. `/debate Creare una piattaforma SaaS per dentisti`).
- `/status`: Mostra lo stato attuale del dibattito, l'argomento e il numero di turni in corso.
- `/whiteboard`: Stampa a schermo la **Lavagna (Stato dell'Arte)** aggiornata in tempo reale dal Moderatore.
- `/stop`: Interrompe immediatamente il dibattito e forza il Moderatore a generare un sunto finale di quanto discusso finora.

Come copia incolla si può usare:

```
start - Messaggio di benvenuto
help - Mostra istruzioni di base
debate - Inizia un dibattito (es /debate Nuova idea)
status - Mostra stato attuale
whiteboard - Stampa la lavagna aggiornata
stop - Interrompe il dibattito
```

**In Fase di Selezione**:
Quando avvii un dibattito, il bot ti chiederà come vuoi scegliere i partecipanti:

- Inviando **numeri** (es. `1, 4, 7`): Scegli tu dalla lista i partecipanti esatti.
- Scrivendo **`mod`** o **`automatico`**: Il Moderatore sceglierà la squadra ottimale dalla lista esistente.
- Scrivendo **`smart`**: Il Moderatore creerà e aggiungerà nuovi ruoli altamente specifici per il tuo topic qualora non fossero presenti.

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
   OPENAI_API_KEY="la_tua_chiave_openai"
   \`\`\`
7. Installa le dipendenze con `npm install` e avvia con `npm run dev`.
