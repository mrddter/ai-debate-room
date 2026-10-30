import { Telegraf } from "telegraf";
import { DebateManager, type UserHandResult } from "./debateManager";
import { MODE_LABELS, STAGE_LABELS, type DebateMode } from "./session/events";
import { spendLine } from "./session/projections";
import { nameOf } from "./session/state";

const missingTopicReply = (command: string) =>
  `Su quale tema? Scrivi /${command} seguito dall'argomento, per esempio:\n/${command} Creare una piattaforma SaaS per dentisti`;

const START_COMMANDS: readonly { command: string; mode: DebateMode }[] = [
  { command: "debate", mode: "structured" },
  { command: "brainstorm", mode: "wild" },
];

const HELP_TEXT = `Comandi:
/debate <tema>: dibattito strutturato (esplorazione, critica, decisione)
/brainstorm <tema>: brainstorming libero, senza freni
/hand [testo]: chiedi la parola; con il testo, è il tuo intervento quando il moderatore te la dà
/status: avanzamento, fase e spesa stimata
/whiteboard: la lavagna condivisa
/stop: chiude il dibattito con il sunto
/resume: riprende l'ultimo dibattito interrotto da un riavvio`;

// "submitted" has no reply: the debate echoes the speech in the chat
const HAND_REPLIES: Record<Exclude<UserHandResult, "submitted">, string> = {
  queued: "✋ Mano alzata: il moderatore ti darà la parola appena chiude l'intervento in corso.",
  has_floor: "Hai già la parola: scrivi il tuo intervento in chat.",
  not_running: "Nessun dibattito in corso: la mano si alza solo durante un dibattito.",
};

// Telegram rejects texts over 4096 characters with a 400; the margin covers how it counts emoji and entities
const MAX_MESSAGE_LENGTH = 4000;

/** Cuts at the last line break that fits, so a long board or summary arrives in several messages instead of failing. */
export function splitMessage(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    // Never split an emoji: a lone surrogate half is invalid UTF-16
    if (/[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

export function setupTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) return;

  const bot = new Telegraf(token);
  const manager = new DebateManager();
  let activeChatId: number | null = null;

  // Every outgoing text goes through here: cut under the length limit, formatted when the markup parses, plain
  // otherwise. It never throws: an unhandled send error once killed the process in the middle of a debate
  const send = async (chat: number, text: string, parseMode?: "Markdown" | "HTML") => {
    for (const part of splitMessage(text)) {
      try {
        await bot.telegram.sendMessage(chat, part, parseMode ? { parse_mode: parseMode } : {});
      } catch (err) {
        if (!parseMode) {
          console.error("[Telegram] Invio fallito:", err);
          continue;
        }
        console.error(`[Telegram] Errore invio ${parseMode}, riprovo come testo semplice:`, err);
        await bot.telegram.sendMessage(chat, part).catch((fallbackErr) => console.error("[Telegram] Fallback fallito:", fallbackErr));
      }
    }
  };

  // Middleware di sicurezza: ascolta solo dal chat ID configurato
  bot.use(async (ctx, next) => {
    const currentChatId = ctx.chat?.id.toString();
    if (currentChatId !== chatId) {
      console.warn(
        `[Security] Messaggio ignorato da chat ID non autorizzato: ${currentChatId}`,
      );
      return;
    }
    return next();
  });

  const statusReport = (): string => {
    const lines = [`Stato: ${manager.status}`, `Argomento: ${manager.topic ?? "nessuno"}`, `Interventi: ${manager.turnCount}`];
    const state = manager.state;
    if (state) {
      lines.push(`Modalità: ${MODE_LABELS[state.mode]}, fase attuale: ${STAGE_LABELS[state.stage]}`);
      lines.push(`Spesa stimata: ${spendLine(state)}`);
      if (manager.awaitingUserSpeech) lines.push("Hai la parola: scrivi il tuo intervento in chat.");
      const queue = state.queue.map((hand) => `- ${nameOf(state, hand.debaterId)} (${hand.kind}): ${hand.pitch}`);
      lines.push(`Mani alzate: ${queue.length > 0 ? `\n${queue.join("\n")}` : "nessuna"}`);
      const { inputTokens, cachedInputTokens, outputTokens, webSearches, calls } = state.usage.total;
      lines.push(`Chiamate LLM: ${calls}, token in ${inputTokens} (${cachedInputTokens} da cache), token out ${outputTokens}, ricerche web ${webSearches}`);
    }
    return lines.join("\n");
  };

  manager.setOnMessage(async (msg) => {
    console.log(
      "[Telegram] Invio messaggio onMessage, activeChatId:",
      activeChatId,
      "msg length:",
      msg.length,
    );
    if (activeChatId) await send(activeChatId, msg, "Markdown");
  });
  manager.setOnFinished(() => {
    activeChatId = null;
  });

  manager.setOnPreferenceAsked(async (allAvailable) => {
    if (!activeChatId) return;

    // Sort all available debaters alphabetically by name
    const sortedAll = [...allAvailable].sort((a, b) => a.name.localeCompare(b.name));

    // Create a map to securely tie each debater to a specific, stable index (1-based)
    const debaterIndexMap = new Map<string, number>();
    sortedAll.forEach((d, i) => debaterIndexMap.set(d.id, i + 1));

    let msg = `🤔 <b>Vuoi scegliere tu i debaters o preferisci che faccia io (il moderatore)?</b>\n\n`;
    msg += `Se vuoi che faccia io, rispondi con "mod", "automatico" o "procedi".\n`;
    msg += `Se vuoi che proponga debaters generati ad hoc per il tuo caso, rispondi con "smart".\n`;
    msg += `Se vuoi scegliere tu, inviami semplicemente i numeri degli agenti che desideri (es. "1, 3, 4").\n\n`;

    msg += `<b>Elenco di tutti i debaters:</b>\n`;
    for (const d of sortedAll) {
      msg += `${debaterIndexMap.get(d.id)}- ${d.name}\n`;
    }

    console.log("[Telegram] Invio messaggio richiesta preferenze.");
    await send(activeChatId, msg, "HTML");
  });

  manager.setOnSelectionRequired(async (selection, allAvailable, moderatorMessage) => {
    console.log(
      "[Telegram] onSelectionRequired chiamato, activeChatId:",
      activeChatId,
      "selection length:",
      selection.length,
    );
    if (!activeChatId) return;

    // Sort all available debaters alphabetically by name
    const sortedAll = [...allAvailable].sort((a, b) => a.name.localeCompare(b.name));

    // Create a map to securely tie each debater to a specific, stable index (1-based)
    const debaterIndexMap = new Map<string, number>();
    sortedAll.forEach((d, i) => debaterIndexMap.set(d.id, i + 1));

    // Gather the selected debaters, preserving the stable index
    const proposed = selection.map(sel => {
      const config = sortedAll.find(d => d.id === sel.id);
      return {
        id: sel.id,
        name: config?.name || sel.id,
        index: debaterIndexMap.get(sel.id) || 0
      };
    });

    // Sort the proposed list alphabetically as well
    proposed.sort((a, b) => a.name.localeCompare(b.name));

    let msg = moderatorMessage ? `🗣️ <b>${moderatorMessage}</b>\n\n` : `🤔 <b>Il moderatore ha proposto i seguenti partecipanti:</b>\n\n`;
    for (const p of proposed) {
      msg += `${p.index}- ${p.name}\n`;
    }

    msg += `\n<b>Elenco di tutti i debaters:</b>\n`;
    for (const d of sortedAll) {
      msg += `${debaterIndexMap.get(d.id)}- ${d.name}\n`;
    }

    msg += `\nRispondi con "conferma" (o "ok") per avviare il dibattito, oppure scrivi le tue modifiche (es. "aggiungi debaters 1, 3,4 e rimuovi 7,8").`;

    console.log(
      "[Telegram] Invio messaggio selezione, msg length:",
      msg.length,
    );
    console.log("[Telegram] Messaggio:", msg.substring(0, 500) + "..."); // Log parte del messaggio
    await send(activeChatId, msg, "HTML");
  });

  // Handlers never await a debate step: Telegraf polls the next updates only after the current batch
  // is handled, so a long await here would delay /stop until the step is over
  const logError = (scope: string) => (err: unknown) => console.error(`[Telegram] Errore in ${scope}:`, err);

  bot.command(["start", "help"], (ctx) => ctx.reply(`Benvenuto!\n\n${HELP_TEXT}`));
  for (const { command, mode } of START_COMMANDS) {
    bot.command(command, async (ctx) => {
      console.log(`[Telegram] Comando /${command} ricevuto, chat.id:`, ctx.chat.id);
      if (manager.isActive)
        return ctx.reply(
          "Dibattito in corso o in fase di selezione. Usa /stop prima.",
        );
      // payload also covers /debate@BotName and multi-line topics
      const topic = ctx.payload.trim();
      if (!topic) return ctx.reply(missingTopicReply(command));
      activeChatId = ctx.chat.id;
      console.log("[Telegram] activeChatId impostato a:", activeChatId, "topic:", topic, "mode:", mode);
      try {
        await manager.startDebate(topic, mode);
      } catch (err) {
        console.error(`[Telegram] Errore in /${command}:`, err);
        await send(ctx.chat.id, "Errore interno durante l'avvio del dibattito. Controlla i log del server.");
      }
    });
  }
  bot.command("hand", (ctx) => {
    const result = manager.raiseUserHand(ctx.payload);
    if (result !== "submitted") return ctx.reply(HAND_REPLIES[result]);
  });
  bot.command("stop", async (ctx) => {
    if (!manager.isActive) return ctx.reply("Nessun dibattito in corso.");
    if (manager.status === "RUNNING") await ctx.reply("Sto fermando il dibattito e generando un sunto...");
    manager.stopDebate().catch(logError("/stop"));
  });
  bot.command("resume", async (ctx) => {
    if (manager.isActive) return ctx.reply("Dibattito in corso o in fase di selezione. Usa /stop prima.");
    activeChatId = ctx.chat.id;
    try {
      if (!(await manager.resume())) await ctx.reply("Nessun dibattito interrotto da riprendere.");
    } catch (err) {
      logError("/resume")(err);
      await ctx.reply("Errore durante la ripresa del dibattito. Controlla i log del server.");
    }
  });
  bot.command(["status", "stats"], (ctx) => send(ctx.chat.id, statusReport()));
  bot.command("whiteboard", (ctx) => {
    if (!manager.state) return ctx.reply("Nessun dibattito in corso.");
    // Plain text: board items carry model-written text that would break Markdown parsing
    return send(ctx.chat.id, `Lavagna\n\n${manager.whiteboard}`);
  });

  // Gestore messaggi di testo semplici (non comandi)
  bot.on("text", async (ctx) => {
    // Telegraf gestisce già i comandi separatamente, ma per sicurezza filtriamo
    if (ctx.message.text.startsWith("/")) return;

    if (manager.status === "RUNNING") {
      // While the user has the floor, plain text is their speech
      if (manager.submitUserSpeech(ctx.message.text)) return;
      return ctx.reply(
        "Un dibattito è in corso. Per intervenire usa /hand (anche con il testo: /hand <intervento>), /status per l'avanzamento, /stop per chiuderlo.",
      );
    }

    if (manager.status === "ASKING_SELECTION_PREFERENCE") {
      manager.handleSelectionPreferenceInput(ctx.message.text).catch(logError("selezione"));
      return;
    }

    if (manager.status === "SELECTING_DEBATERS") {
      manager.handleDebaterSelectionInput(ctx.message.text).catch(logError("selezione"));
      return;
    }

    const topic = ctx.message.text.trim();
    activeChatId = ctx.chat.id;
    send(ctx.chat.id, "🚀 Ricevuto! Inizio la fase di selezione dei debaters per il tema.");
    manager.startDebate(topic).catch((err) => {
      console.error("[Telegram] Errore avvio dibattito:", err);
    });
  });

  // Telegraf's default handler rethrows and the process exits: a failed reply must never stop a running debate
  bot.catch((err, ctx) => console.error(`[Telegram] Errore non gestito sull'update ${ctx.update.update_id}:`, err));

  bot.launch();
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
