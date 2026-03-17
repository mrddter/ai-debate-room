import "dotenv/config";
import * as path from "path";
import { setupTelegramBot } from "./src/lib/telegram";
import { initializeAgents } from "./src/lib/agents";
import { start as startServer, yn } from "@volcanicminds/backend";

const start = async () => {
  await startServer({});

  // Inizializza Agenti Mastra
  await initializeAgents();

  // Avvia bot Telegram
  setupTelegramBot();
};
start();
