import "dotenv/config";
import * as path from "path";
import { setupTelegramBot } from "./lib/telegram";
const { Server } = require("@volcanicminds/backend");

const start = async () => {
  const server = new Server();
  await server.init({ projectDir: path.join(__dirname, ".."), options: {} });

  // Avvia bot Telegram
  setupTelegramBot();

  await server.start();
};
start();
