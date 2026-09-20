import { EventEmitter } from "node:events";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { AppError, errorMessage } from "./errors.js";
import { ProfileMergeStore } from "./profile-merge-store.js";
import type { Conversation, Message, MessageProvider, ProfileMerge, ProvidenceEvent, ProviderName } from "./types.js";

type EventProvider = MessageProvider & EventEmitter;
type AsyncHandler = (request: Request, response: Response, next: NextFunction) => Promise<void>;

export function createApp(
  providerInput: EventProvider | readonly EventProvider[],
  frontendOrigin = "*",
  profileMerges = new ProfileMergeStore(),
) {
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
      const conversations = await listConnectedConversations(providers);
      response.json({ conversations: applyProfileMerges(conversations, profileMerges.list()) });
    }),
  );

  app.get(
    "/api/profile-merges/candidates",
    asyncRoute(async (_request, response) => {
      const conversations = await listConnectedConversations(providers);
      response.json({
        conversations: conversations
          .filter(({ kind }) => kind === "direct")
          .map((conversation) => ({
            ...conversation,
            assignedToProfileId: profileMerges.profileForConversation(conversation.id)?.id,
          })),
      });
    }),
  );

  app.get("/api/profile-merges", (_request, response) => {
    response.json({ profiles: profileMerges.list() });
  });

  app.post(
    "/api/profile-merges",
    asyncRoute(async (request, response) => {
      const conversationIds = stringArray(request.body?.conversationIds, "conversationIds");
      const conversations = await listConnectedConversations(providers);
      validateMergeCandidates(conversationIds, conversations);
      const profile = profileMerges.create({
        conversationIds,
        ...optionalDisplayName(request.body?.displayName),
        ...optionalSendConversationId(request.body?.sendConversationId),
      });
      response.status(201).json({ profile });
    }),
  );

  app.patch(
    "/api/profile-merges/:profileId",
    asyncRoute(async (request, response) => {
      const profileId = requiredParam(request.params.profileId, "profileId");
      const input = {
        ...optionalDisplayName(request.body?.displayName),
        ...optionalSendConversationId(request.body?.sendConversationId, true),
      };
      if (Object.keys(input).length === 0) {
        throw new AppError("Provide a displayName or sendConversationId", 400, "INVALID_REQUEST");
      }
      response.json({ profile: profileMerges.update(profileId, input) });
    }),
  );

  app.delete("/api/profile-merges/:profileId", (request, response) => {
    const profileId = requiredParam(request.params.profileId, "profileId");
    if (!profileMerges.delete(profileId)) throw new AppError("Merged profile not found", 404, "PROFILE_NOT_FOUND");
    response.status(204).end();
  });

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
      const profile = profileMerges.get(conversationId);
      if (profile) {
        const messages = await listMergedMessages(profile, providerByName, limit, acknowledge);
        response.json({ messages });
        return;
      }
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
      const profile = profileMerges.get(conversationId);
      const targetId = profile
        ? await selectSendConversation(profile, providerByName)
        : conversationId;
      const provider = providerForQualifiedId(providerByName, targetId);
      const message = await provider.sendMessage(targetId, { content });
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
      const profile = profileMerges.get(conversationId);
      const targetId = profile
        ? await conversationForMergedMessage(profile, messageId, providerByName)
        : conversationId;
      const provider = providerForQualifiedId(providerByName, targetId);
      await provider.addReaction(targetId, messageId, emoji);
      response.status(204).end();
    }),
  );

  app.get("/api/events", (request, response) => {
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.socket?.setNoDelay(true);
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

async function listConnectedConversations(providers: readonly EventProvider[]): Promise<Conversation[]> {
  const connected = providers.filter((provider) => provider.status().state === "connected");
  const conversationLists = await Promise.all(connected.map((provider) => provider.listConversations()));
  return conversationLists.flat();
}

function applyProfileMerges(conversations: Conversation[], profiles: ProfileMerge[]): Conversation[] {
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const mergedIds = new Set(profiles.flatMap(({ conversationIds }) => conversationIds));
  const merged = profiles.flatMap((profile) => {
    const sources = profile.conversationIds
      .map((id) => byId.get(id))
      .filter((conversation): conversation is Conversation => conversation !== undefined);
    return sources.length === 0 ? [] : [mergedConversation(profile, sources)];
  });
  return [...conversations.filter(({ id }) => !mergedIds.has(id)), ...merged]
    .sort((left, right) => conversationTimestamp(right) - conversationTimestamp(left));
}

function mergedConversation(profile: ProfileMerge, sources: Conversation[]): Conversation {
  const mostRecent = [...sources].sort((left, right) => conversationTimestamp(right) - conversationTimestamp(left))[0]!;
  const updatedTimestamps = sources
    .map(({ lastUpdatedAt }) => lastUpdatedAt)
    .filter((value): value is string => value !== undefined)
    .sort();
  const acknowledgedTimestamps = sources
    .map(({ lastAcknowledgedAt }) => lastAcknowledgedAt)
    .filter((value): value is string => value !== undefined)
    .sort();
  const unread = sources.some((source) => source.unread);
  const notificationCount = sources.reduce((sum, source) => sum + (source.notification?.count ?? 0), 0);
  const sendConversationId = sources.some(({ id }) => id === profile.sendConversationId)
    ? profile.sendConversationId
    : undefined;

  return {
    id: profile.id,
    provider: "merged",
    providerConversationId: profile.id.slice("profile:".length),
    title: profile.displayName || mostRecent.title,
    kind: "direct",
    avatarUrl: mostRecent.avatarUrl,
    unread,
    preview: mostRecent.preview,
    ...(unread ? { notification: notificationCount > 0
      ? { kind: "mention" as const, count: notificationCount }
      : { kind: "unread" as const } } : {}),
    ...(updatedTimestamps.length ? { lastUpdatedAt: updatedTimestamps.at(-1) } : {}),
    ...(acknowledgedTimestamps.length ? { lastAcknowledgedAt: acknowledgedTimestamps[0] } : {}),
    sources: sources.map(({ id, provider, title, avatarUrl }) => ({
      conversationId: id,
      provider: provider as ProviderName,
      title,
      ...(avatarUrl ? { avatarUrl } : {}),
    })),
    ...(sendConversationId ? { sendConversationId } : {}),
    sendRoute: sendConversationId ? "override" : "most_frequent",
  };
}

function conversationTimestamp(conversation: Conversation): number {
  const timestamp = conversation.lastUpdatedAt ? Date.parse(conversation.lastUpdatedAt) : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

async function listMergedMessages(
  profile: ProfileMerge,
  providers: ReadonlyMap<ProviderName, EventProvider>,
  limit: number,
  acknowledge: boolean,
): Promise<Message[]> {
  const availableIds = availableConversationIds(profile, providers);
  if (availableIds.length === 0) {
    throw new AppError("None of this profile's providers are connected", 409, "PROFILE_PROVIDERS_DISCONNECTED");
  }
  const messageLists = await Promise.all(availableIds.map((conversationId) =>
    providerForQualifiedId(providers, conversationId).listMessages(conversationId, limit, acknowledge),
  ));
  return messageLists.flat()
    .sort((left, right) => messageTimestamp(left) - messageTimestamp(right))
    .slice(-limit);
}

async function selectSendConversation(
  profile: ProfileMerge,
  providers: ReadonlyMap<ProviderName, EventProvider>,
): Promise<string> {
  const availableIds = availableConversationIds(profile, providers);
  if (availableIds.length === 0) {
    throw new AppError("None of this profile's providers are connected", 409, "PROFILE_PROVIDERS_DISCONNECTED");
  }
  if (profile.sendConversationId && availableIds.includes(profile.sendConversationId)) {
    return profile.sendConversationId;
  }

  const usage = await Promise.all(availableIds.map(async (conversationId, order) => {
    const messages = await providerForQualifiedId(providers, conversationId)
      .listMessages(conversationId, 100, false);
    const latest = messages.reduce((timestamp, message) => Math.max(timestamp, messageTimestamp(message)), 0);
    return { conversationId, count: messages.length, latest, order };
  }));
  usage.sort((left, right) => right.count - left.count || right.latest - left.latest || left.order - right.order);
  return usage[0]!.conversationId;
}

function messageTimestamp(message: Message): number {
  const timestamp = message.sentAt ? Date.parse(message.sentAt) : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function availableConversationIds(
  profile: ProfileMerge,
  providers: ReadonlyMap<ProviderName, EventProvider>,
): string[] {
  return profile.conversationIds.filter((id) => {
    try {
      return providerForQualifiedId(providers, id).status().state === "connected";
    } catch {
      return false;
    }
  });
}

async function conversationForMergedMessage(
  profile: ProfileMerge,
  messageId: string,
  providers: ReadonlyMap<ProviderName, EventProvider>,
): Promise<string> {
  const providerPrefix = messageId.split(":", 1)[0];
  const candidates = profile.conversationIds.filter((id) => id.startsWith(`${providerPrefix}:`));
  if (candidates.length === 1) return candidates[0]!;
  for (const conversationId of candidates) {
    const messages = await providerForQualifiedId(providers, conversationId).listMessages(conversationId, 100, false);
    if (messages.some(({ id }) => id === messageId)) return conversationId;
  }
  throw new AppError("Message does not belong to this merged profile", 404, "MESSAGE_NOT_FOUND");
}

function validateMergeCandidates(conversationIds: string[], conversations: Conversation[]): void {
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  for (const id of conversationIds) {
    const conversation = byId.get(id);
    if (!conversation) throw new AppError("Every selected conversation must be available", 400, "INVALID_PROFILE_MERGE");
    if (conversation.kind !== "direct") {
      throw new AppError("Only direct messages can be merged", 400, "INVALID_PROFILE_MERGE");
    }
  }
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new AppError(`${name} must be an array of IDs`, 400, "INVALID_REQUEST");
  }
  return value.map((item) => (item as string).trim());
}

function optionalDisplayName(value: unknown): { displayName?: string } {
  if (value === undefined) return {};
  if (typeof value !== "string" || value.trim().length > 100) {
    throw new AppError("displayName must be at most 100 characters", 400, "INVALID_REQUEST");
  }
  return { displayName: value.trim() };
}

function optionalSendConversationId(value: unknown): { sendConversationId?: string };
function optionalSendConversationId(value: unknown, allowNull: true): { sendConversationId?: string | null };
function optionalSendConversationId(
  value: unknown,
  allowNull = false,
): { sendConversationId?: string | null } {
  if (value === undefined) return {};
  if (allowNull && value === null) return { sendConversationId: null };
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError("sendConversationId must be a conversation ID", 400, "INVALID_REQUEST");
  }
  return { sendConversationId: value.trim() };
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
