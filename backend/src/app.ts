import { EventEmitter } from "node:events";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { AppError, errorMessage } from "./errors.js";
import type { MessageProvider, ProvidenceEvent } from "./types.js";

type EventProvider = MessageProvider & EventEmitter;
type AsyncHandler = (request: Request, response: Response, next: NextFunction) => Promise<void>;

export function createApp(provider: EventProvider, frontendOrigin = "*") {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: frontendOrigin === "*" ? "*" : frontendOrigin.split(",").map((origin) => origin.trim()) }));
  app.use(express.json({ limit: "32kb" }));
  app.use((_request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  app.get("/health", (_request, response) => {
    const providerStatus = provider.status();
    response.json({
      status: providerStatus.state === "connected" ? "ok" : "degraded",
      provider: { name: provider.name, ...providerStatus },
    });
  });

  app.get("/api/providers", (_request, response) => {
    response.json({ providers: [{ name: provider.name, ...provider.status() }] });
  });

  app.post(
    "/api/providers/discord/connect",
    asyncRoute(async (_request, response) => {
      await provider.connect();
      response.json({ provider: { name: provider.name, ...provider.status() } });
    }),
  );

  app.get(
    "/api/conversations",
    asyncRoute(async (_request, response) => {
      response.json({ conversations: await provider.listConversations() });
    }),
  );

  app.get(
    "/api/conversations/:conversationId/messages",
    asyncRoute(async (request, response) => {
      const conversationId = requiredParam(request.params.conversationId, "conversationId");
      const rawLimit = firstValue(request.query.limit);
      const limit = rawLimit === undefined ? 50 : Number.parseInt(rawLimit, 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new AppError("limit must be an integer from 1 to 100", 400, "INVALID_REQUEST");
      }
      response.json({ messages: await provider.listMessages(conversationId, limit) });
    }),
  );

  app.post(
    "/api/conversations/:conversationId/messages",
    asyncRoute(async (request, response) => {
      const conversationId = requiredParam(request.params.conversationId, "conversationId");
      const content = typeof request.body?.content === "string" ? request.body.content.trim() : "";
      if (!content || content.length > 2_000) {
        throw new AppError("content must contain 1 to 2000 characters", 400, "INVALID_REQUEST");
      }
      const message = await provider.sendMessage(conversationId, { content });
      response.status(201).json({ message });
    }),
  );

  app.post(
    "/api/conversations/:conversationId/messages/:messageId/reactions",
    asyncRoute(async (request, response) => {
      const conversationId = requiredParam(request.params.conversationId, "conversationId");
      const messageId = requiredParam(request.params.messageId, "messageId");
      const emoji = typeof request.body?.emoji === "string" ? request.body.emoji.trim() : "";
      if (!emoji || emoji.length > 100) {
        throw new AppError("emoji is required", 400, "INVALID_REQUEST");
      }
      await provider.addReaction(conversationId, messageId, emoji);
      response.status(204).end();
    }),
  );

  app.get("/api/events", (request, response) => {
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();

    const writeEvent = (event: ProvidenceEvent) => {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    heartbeat.unref();
    provider.on("event", writeEvent);
    response.write(`event: ready\ndata: ${JSON.stringify({ provider: provider.status() })}\n\n`);

    request.on("close", () => {
      clearInterval(heartbeat);
      provider.off("event", writeEvent);
    });
  });

  app.use((_request, _response, next) => next(new AppError("Route not found", 404, "NOT_FOUND")));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const statusCode = error instanceof AppError ? error.statusCode : 500;
    const code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
    if (statusCode >= 500) console.error(error);
    response.status(statusCode).json({ error: { code, message: errorMessage(error) } });
  });

  return app;
}

function asyncRoute(handler: AsyncHandler) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response, next).catch(next);
  };
}

function requiredParam(value: string | string[] | undefined, name: string): string {
  const parsed = firstValue(value);
  if (!parsed) throw new AppError(`${name} is required`, 400, "INVALID_REQUEST");
  return parsed;
}

function firstValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}
