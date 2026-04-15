import { Telegraf } from "telegraf";
import { DebateManager } from "./debateManager";

export function setupTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) return;

  const bot = new Telegraf(token);
  const manager = new DebateManager();
  let activeChatId: number | null = null;

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

  const escapeMarkdown = (text: string) => {
    return text
      .replace(/_/g, "\\_")
      .replace(/\*/g, "\\*")
      .replace(/\[/g, "\\[")
      .replace(/\]/g, "\\]")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
      .replace(/~/g, "\\~")
      .replace(/`/g, "\\`")
      .replace(/>/g, "\\>")
      .replace(/#/g, "\\#")
      .replace(/\+/g, "\\+")
      .replace(/-/g, "\\-")
      .replace(/=/g, "\\=")
      .replace(/\|/g, "\\|")
      .replace(/\{/g, "\\{")
      .replace(/\}/g, "\\}")
      .replace(/\./g, "\\.")
      .replace(/!/g, "\\!");
  };

  manager.setOnMessage(async (msg) => {
    console.log(
      "[Telegram] Invio messaggio onMessage, activeChatId:",
      activeChatId,
      "msg length:",
      msg.length,
    );
    if (activeChatId) {
      // In Markdown mode, we can't just send raw JSON or strings with unclosed entities
      // However, we want to keep bold for headers. We switch to MarkdownV2 or simply keep Markdown but clean content.
      try {
        await bot.telegram.sendMessage(activeChatId, msg, {
          parse_mode: "Markdown",
        });
      } catch (err) {
        console.error(
          "[Telegram] Errore invio Markdown, riprovo come testo semplice:",
          err,
        );
        await bot.telegram
          .sendMessage(activeChatId, msg) // Fallback to plain text
          .catch((e) => console.error("[Telegram] Fallback fallito:", e));
      }
    }
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
    msg += `Se vuoi scegliere tu, inviami semplicemente i numeri degli agenti che desideri (es. "1, 3, 4").\n\n`;

    msg += `<b>Elenco di tutti i debaters:</b>\n`;
    for (const d of sortedAll) {
      msg += `${debaterIndexMap.get(d.id)}- ${d.name}\n`;
    }

    console.log("[Telegram] Invio messaggio richiesta preferenze.");
    await bot.telegram
      .sendMessage(activeChatId, msg, { parse_mode: "HTML" })
      .catch((err) =>
        console.error("[Telegram] Errore invio messaggio preferenze:", err),
      );
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
    await bot.telegram
      .sendMessage(activeChatId, msg, { parse_mode: "HTML" })
      .catch((err) =>
        console.error("[Telegram] Errore invio messaggio selezione:", err),
      );
  });

  bot.command(["start", "help"], (ctx) =>
    ctx.reply("Benvenuto! Usa /debate [argomento], /stop o /status."),
  );
  bot.command("debate", async (ctx) => {
    console.log("[Telegram] Comando /debate ricevuto, chat.id:", ctx.chat.id);
    if (manager.status === "RUNNING" || manager.status === "SELECTING_DEBATERS" || manager.status === "ASKING_SELECTION_PREFERENCE")
      return ctx.reply(
        "Dibattito in corso o in fase di selezione. Usa /stop prima.",
      );
    const topicMatch = ctx.message.text.match(/^\/debate(?:\s+(.+))?$/i);
    activeChatId = ctx.chat.id;
    console.log(
      "[Telegram] activeChatId impostato a:",
      activeChatId,
      "topic:",
      topicMatch?.[1]?.trim(),
    );
    try {
      await manager.startDebate(topicMatch?.[1]?.trim());
    } catch (err) {
      console.error("[Telegram] Errore in /debate:", err);
      ctx.reply(
        "Errore interno durante l'avvio del dibattito. Controlla i log del server.",
      );
    }
  });
  bot.command("stop", async (ctx) => {
    if (manager.status === "IDLE")
      return ctx.reply("Nessun dibattito in corso.");
    ctx.reply("Sto fermando il dibattito e generando un sunto...");
    await manager.stopDebate();
  });
  bot.command(["status", "stats"], (ctx) => {
    ctx.reply(
      `Stato: ${manager.status}\nArgomento: ${manager.topic}\nTurni: ${manager.turnCount}`,
    );
  });

  // Gestore messaggi di testo semplici (non comandi)
  bot.on("text", async (ctx) => {
    // Telegraf gestisce già i comandi separatamente, ma per sicurezza filtriamo
    if (ctx.message.text.startsWith("/")) return;

    if (manager.status === "RUNNING") {
      return ctx.reply(
        "Un dibattito è già in corso. Usa /stop se vuoi cambiarne il tema o /status per vederne l'avanzamento.",
      );
    }

    if (manager.status === "ASKING_SELECTION_PREFERENCE") {
      await manager.handleSelectionPreferenceInput(ctx.message.text);
      return;
    }

    if (manager.status === "SELECTING_DEBATERS") {
      await manager.handleDebaterSelectionInput(ctx.message.text);
      return;
    }

    const topic = ctx.message.text.trim();
    activeChatId = ctx.chat.id;
    ctx.reply(
      `🚀 Ricevuto! Inizio la fase di selezione debaters per il topic...`,
    );
    manager.startDebate(topic).catch((err) => {
      console.error("[Telegram] Errore avvio dibattito:", err);
    });
  });

  bot.launch();
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
