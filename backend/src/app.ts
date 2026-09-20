import { EventEmitter } from "node:events";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { AppError, errorMessage } from "./errors.js";
import type { MessageProvider, ProvidenceEvent, ProviderName } from "./types.js";

type EventProvider = MessageProvider & EventEmitter;
type AsyncHandler = (request: Request, response: Response, next: NextFunction) => Promise<void>;

export function createApp(providerInput: EventProvider | readonly EventProvider[], frontendOrigin = "*") {
  const providers = Array.isArray(providerInput) ? [...providerInput] : [providerInput];
  const providerByName = new Map(providers.map((provider) => [provider.name, provider]));
  if (providerByName.size !== providers.length) {
    throw new AppError("Only one instance of each provider may be registered", 500, "CONFIG_ERROR");
  }

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
    const statuses = providers.map((provider) => ({ name: provider.name, ...provider.status() }));
    response.json({
      status: statuses.length > 0 && statuses.every(({ state }) => state === "connected") ? "ok" : "degraded",
      providers: statuses,
    });
  });

  app.get("/api/providers", (_request, response) => {
    response.json({ providers: providers.map((provider) => ({ name: provider.name, ...provider.status() })) });
  });

  app.post(
    "/api/providers/:provider/connect",
    asyncRoute(async (request, response) => {
      const provider = providerByName.get(requiredProviderName(request.params.provider));
      if (!provider) throw new AppError("Provider is not configured", 404, "PROVIDER_NOT_FOUND");
      await provider.connect();
      response.json({ provider: { name: provider.name, ...provider.status() } });
    }),
  );

  app.get(
    "/api/conversations",
    asyncRoute(async (_request, response) => {
      const connected = providers.filter((provider) => provider.status().state === "connected");
      const conversationLists = await Promise.all(connected.map((provider) => provider.listConversations()));
      response.json({ conversations: conversationLists.flat() });
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
      const acknowledge = firstValue(request.query.acknowledge) === "true";
      const provider = providerForQualifiedId(providerByName, conversationId);
      response.json({ messages: await provider.listMessages(conversationId, limit, acknowledge) });
    }),
  );

  app.post(
    "/api/conversations/:conversationId/messages",
    asyncRoute(async (request, response) => {
      const conversationId = requiredParam(request.params.conversationId, "conversationId");
      const content = typeof request.body?.content === "string" ? request.body.content.trim() : "";
      if (!content || content.length > 1_000) {
        throw new AppError("content must contain 1 to 1000 characters", 400, "INVALID_REQUEST");
      }
      const provider = providerForQualifiedId(providerByName, conversationId);
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
      const provider = providerForQualifiedId(providerByName, conversationId);
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
    for (const provider of providers) provider.on("event", writeEvent);
    response.write(`event: ready\ndata: ${JSON.stringify({
      providers: providers.map((provider) => ({ name: provider.name, ...provider.status() })),
    })}\n\n`);

    request.on("close", () => {
      clearInterval(heartbeat);
      for (const provider of providers) provider.off("event", writeEvent);
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

function providerForQualifiedId(
  providers: ReadonlyMap<ProviderName, EventProvider>,
  qualifiedId: string,
): EventProvider {
  const providerName = qualifiedId.split(":", 1)[0];
  if (providerName !== "discord" && providerName !== "instagram") {
    throw new AppError("ID must be qualified with a configured provider", 400, "INVALID_PROVIDER_ID");
  }
  const provider = providers.get(providerName);
  if (!provider) throw new AppError("Provider is not configured", 404, "PROVIDER_NOT_FOUND");
  return provider;
}

function requiredProviderName(value: string | string[] | undefined): ProviderName {
  const parsed = requiredParam(value, "provider");
  if (parsed !== "discord" && parsed !== "instagram") {
    throw new AppError("Unknown provider", 404, "PROVIDER_NOT_FOUND");
  }
  return parsed;
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
