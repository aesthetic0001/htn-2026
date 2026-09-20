import { createServer } from "node:http";
import { createApp } from "./src/app.js";
import { config } from "./src/config.js";
import { DiscordProvider } from "./src/discord-provider.js";

const discord = new DiscordProvider({
  email: config.discordEmail,
  password: config.discordPassword,
  userDataDir: config.userDataDir,
  executablePath: config.customChromiumPath,
  headless: config.headless,
  pollIntervalMs: config.pollIntervalMs,
});

const server = createServer(createApp(discord, config.frontendOrigin));
server.listen(config.port, config.host, () => {
  console.log(`Providence backend listening at http://${config.host}:${config.port}`);
  void discord.connect().catch((error: unknown) => {
    console.error("Discord failed to connect:", error);
  });
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; shutting down`);
  server.close();
  await discord.disconnect().catch((error: unknown) => console.error("Discord shutdown failed:", error));
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
