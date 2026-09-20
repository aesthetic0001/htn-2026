import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { AppError } from "./errors.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendDirectory = [
  path.resolve(moduleDirectory, ".."),
  path.resolve(moduleDirectory, "../.."),
  process.cwd(),
  path.resolve(process.cwd(), "backend"),
].find((candidate) => fs.existsSync(path.join(candidate, "package.json"))) ?? process.cwd();
dotenv.config({ path: path.join(backendDirectory, ".env"), quiet: true });

function optional(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const config = {
  host: process.env.HOST?.trim() || "127.0.0.1",
  port: integer("PORT", 3001),
  discordEmail: optional("DISCORD_EMAIL"),
  discordPassword: optional("DISCORD_PASSWORD"),
  instagramEmail: optional("INSTAGRAM_EMAIL"),
  instagramPassword: optional("INSTAGRAM_PASSWORD"),
  customChromiumPath: process.env.CUSTOM_CHROMIUM_PATH?.trim() || undefined,
  discordUserDataDir: path.resolve(
    backendDirectory,
    process.env.DISCORD_USER_DATA_DIR?.trim() || process.env.USER_DATA_DIR?.trim() || "user-data",
  ),
  instagramUserDataDir: path.resolve(
    backendDirectory,
    process.env.INSTAGRAM_USER_DATA_DIR?.trim() || "instagram-user-data",
  ),
  headless: process.env.HEADLESS === "true",
  pollIntervalMs: integer("POLL_INTERVAL_MS", 5_000),
  frontendOrigin: process.env.FRONTEND_ORIGIN?.trim() || "*",
};

export function configuredCredentials(
  provider: "Discord" | "Instagram",
  email: string | undefined,
  password: string | undefined,
): { email: string; password: string } | undefined {
  if (!email && !password) return undefined;
  if (!email || !password) {
    throw new AppError(
      `${provider} requires both its email and password environment variables`,
      500,
      "CONFIG_ERROR",
    );
  }
  return { email, password };
}
