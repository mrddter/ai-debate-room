import "dotenv/config";
import * as path from "path";
import { setupTelegramBot } from "./src/lib/telegram";
import { initializeAgents } from "./src/lib/agents";
import { start as startServer, yn } from "@volcanicminds/backend";

declare global {
  // @volcanicminds/tools logger stays silent unless this flag is set; backend 2.x never sets it
  var isLoggingEnabled: boolean | undefined;
}
global.isLoggingEnabled = true;

const start = async () => {
  await startServer({});

  // Inizializza Agenti Mastra
  await initializeAgents();

  // Avvia bot Telegram
  setupTelegramBot();
};
start();
