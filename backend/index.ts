import { createServer } from "node:http";
import { createApp } from "./src/app.js";
import { config, configuredCredentials } from "./src/config.js";
import { DiscordProvider } from "./src/discord-provider.js";
import { AppError } from "./src/errors.js";
import { InstagramProvider } from "./src/instagram-provider.js";

const providers: Array<DiscordProvider | InstagramProvider> = [];
const discordCredentials = configuredCredentials("Discord", config.discordEmail, config.discordPassword);
const instagramCredentials = configuredCredentials("Instagram", config.instagramEmail, config.instagramPassword);

if (discordCredentials) {
  providers.push(new DiscordProvider({
    ...discordCredentials,
    userDataDir: config.discordUserDataDir,
    executablePath: config.customChromiumPath,
    headless: config.headless,
    pollIntervalMs: config.pollIntervalMs,
  }));
}

if (instagramCredentials) {
  providers.push(new InstagramProvider({
    ...instagramCredentials,
    userDataDir: config.instagramUserDataDir,
    executablePath: config.customChromiumPath,
    headless: config.headless,
    pollIntervalMs: config.pollIntervalMs,
  }));
}

if (providers.length === 0) {
  throw new AppError(
    "Configure credentials for at least one provider (Discord or Instagram)",
    500,
    "CONFIG_ERROR",
  );
}

const server = createServer(createApp(providers, config.frontendOrigin));
server.listen(config.port, config.host, () => {
  console.log(`Providence backend listening at http://${config.host}:${config.port}`);
  for (const provider of providers) {
    void provider.connect().catch((error: unknown) => {
      console.error(`${provider.name} failed to connect:`, error);
    });
  }
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; shutting down`);
  server.close();
  await Promise.all(providers.map((provider) =>
    provider.disconnect().catch((error: unknown) => console.error(`${provider.name} shutdown failed:`, error)),
  ));
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
