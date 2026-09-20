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

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new AppError(`Missing required environment variable ${name}`, 500, "CONFIG_ERROR");
  return value;
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
  discordEmail: required("DISCORD_EMAIL"),
  discordPassword: required("DISCORD_PASSWORD"),
  customChromiumPath: process.env.CUSTOM_CHROMIUM_PATH?.trim() || undefined,
  userDataDir: path.resolve(backendDirectory, process.env.USER_DATA_DIR?.trim() || "user-data"),
  headless: process.env.HEADLESS === "true",
  pollIntervalMs: integer("POLL_INTERVAL_MS", 5_000),
  frontendOrigin: process.env.FRONTEND_ORIGIN?.trim() || "*",
};
