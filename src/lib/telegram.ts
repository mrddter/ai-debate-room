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

  manager.setOnMessage(async (msg) => {
    console.log(
      "[Telegram] Invio messaggio onMessage, activeChatId:",
      activeChatId,
      "msg length:",
      msg.length,
    );
    if (activeChatId)
      await bot.telegram
        .sendMessage(activeChatId, msg, { parse_mode: "Markdown" }) // Usa HTML
        .catch((err) =>
          console.error("[Telegram] Errore invio messaggio onMessage:", err),
        );
  });
  manager.setOnFinished(() => {
    activeChatId = null;
  });

  manager.setOnSelectionRequired(async (selection, allAvailable) => {
    console.log(
      "[Telegram] onSelectionRequired chiamato, activeChatId:",
      activeChatId,
      "selection length:",
      selection.length,
    );
    if (!activeChatId) return;

    const selectedIds = selection.map((s) => s.id);
    const unselected = allAvailable.filter((d) => !selectedIds.includes(d.id));

    let msg = `🤔 <b>Il moderatore ha proposto i seguenti partecipanti:</b>\n\n`;
    for (const sel of selection) {
      const config = allAvailable.find((d) => d.id === sel.id);
      msg += `✅ <b>${config?.name || sel.id}</b>\n<i>Motivo: ${sel.reason}</i>\n\n`;
    }

    msg += `❌ <b>Debaters non selezionati:</b>\n`;
    for (const uns of unselected) {
      msg += `- ${uns.name} (${uns.id})\n`;
    }

    msg += `\nRispondi con <b>"conferma"</b> (o "ok") per avviare il dibattito, oppure scrivi le tue modifiche (es. "aggiungi l'esperto UX/UI e rimuovi opponent").`;

    console.log(
      "[Telegram] Invio messaggio selezione, msg length:",
      msg.length,
    );
    console.log("[Telegram] Messaggio:", msg.substring(0, 500) + "..."); // Log parte del messaggio
    await bot.telegram
      .sendMessage(activeChatId, msg, { parse_mode: "Markdown" })
      .catch((err) =>
        console.error("[Telegram] Errore invio messaggio selezione:", err),
      );
  });

  bot.command(["start", "help"], (ctx) =>
    ctx.reply("Benvenuto! Usa /debate [argomento], /stop o /status."),
  );
  bot.command("debate", async (ctx) => {
    console.log("[Telegram] Comando /debate ricevuto, chat.id:", ctx.chat.id);
    if (manager.status === "RUNNING" || manager.status === "SELECTING_DEBATERS")
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
