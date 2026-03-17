import { Telegraf } from "telegraf";
import { DebateManager } from "./debateManager";

export function setupTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const bot = new Telegraf(token);
  const manager = new DebateManager();
  let activeChatId: number | null = null;

  manager.setOnMessage(async (msg) => {
    if (activeChatId)
      await bot.telegram
        .sendMessage(activeChatId, msg, { parse_mode: "Markdown" })
        .catch(() => {});
  });
  manager.setOnFinished(() => {
    activeChatId = null;
  });

  bot.command("start", (ctx) =>
    ctx.reply("Benvenuto! Usa /debate [argomento], /stop o /status."),
  );
  bot.command("debate", async (ctx) => {
    if (manager.status === "RUNNING")
      return ctx.reply("Dibattito in corso. Usa /stop prima.");
    const topicMatch = ctx.message.text.match(/^\/debate(?:\s+(.+))?$/i);
    activeChatId = ctx.chat.id;
    manager.startDebate(topicMatch?.[1]?.trim()).catch(() => {});
  });
  bot.command("stop", (ctx) => {
    if (manager.status !== "RUNNING")
      return ctx.reply("Nessun dibattito in corso.");
    manager.stopDebate();
    ctx.reply("Hai fermato il dibattito.");
  });
  bot.command("status", (ctx) => {
    ctx.reply(
      `Stato: ${manager.status}\nArgomento: ${manager.topic}\nTurni: ${manager.turnCount}`,
    );
  });
  bot.command("help", (ctx) => {
    ctx.reply(`Usa /debate [argomento], /stop o /status.`);
  });

  bot.launch();
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
