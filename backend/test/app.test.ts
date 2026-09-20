import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:http";
import { createApp } from "../src/app.js";
import type { Conversation, Message, MessageProvider, ProviderName, SendMessageInput } from "../src/types.js";

const conversation: Conversation = {
  id: "discord:123",
  provider: "discord",
  providerConversationId: "123",
  title: "Friends",
  kind: "direct",
  unread: false,
};

const message: Message = {
  id: "discord:456",
  provider: "discord",
  providerMessageId: "456",
  conversationId: conversation.id,
  author: { displayName: "Ada" },
  content: "hello",
  sentAt: "2026-01-01T00:00:00.000Z",
  edited: false,
  attachments: [],
  reactions: [],
};

function instagramFixture() {
  const instagramConversation: Conversation = {
    id: "instagram:abc",
    provider: "instagram",
    providerConversationId: "abc",
    title: "Grace",
    kind: "direct",
    unread: true,
  };
  const instagramMessage: Message = {
    ...message,
    id: "instagram:def",
    provider: "instagram",
    providerMessageId: "def",
    conversationId: instagramConversation.id,
    author: { displayName: "Grace" },
  };
  return { conversation: instagramConversation, message: instagramMessage };
}

class FakeProvider extends EventEmitter implements MessageProvider {
  sent?: SendMessageInput;
  connectCalls = 0;
  messageAcknowledgements: boolean[] = [];
  constructor(
    readonly name: ProviderName,
    private readonly conversation: Conversation,
    private readonly message: Message,
  ) { super(); }
  status() { return { state: "connected" as const }; }
  async connect() { this.connectCalls += 1; }
  async disconnect() {}
  async listConversations() { return [this.conversation]; }
  async listMessages(_conversationId: string, _limit: number, acknowledge = false) {
    this.messageAcknowledgements.push(acknowledge);
    return [this.message];
  }
  async sendMessage(_id: string, input: SendMessageInput) {
    this.sent = input;
    return { ...this.message, content: input.content };
  }
  async addReaction() {}
}

const instagram = instagramFixture();
const discordProvider = new FakeProvider("discord", conversation, message);
const instagramProvider = new FakeProvider("instagram", instagram.conversation, instagram.message);
let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer(createApp([discordProvider, instagramProvider]));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("reports provider health", async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    providers: [
      { name: "discord", state: "connected" },
      { name: "instagram", state: "connected" },
    ],
  });
});

test("lists normalized conversations and messages", async () => {
  const conversations = await fetch(`${baseUrl}/api/conversations`);
  assert.deepEqual(await conversations.json(), { conversations: [conversation, instagram.conversation] });

  const messages = await fetch(`${baseUrl}/api/conversations/discord%3A123/messages?limit=20`);
  assert.deepEqual(await messages.json(), { messages: [message] });

  const instagramMessages = await fetch(`${baseUrl}/api/conversations/instagram%3Aabc/messages?limit=20`);
  assert.deepEqual(await instagramMessages.json(), { messages: [instagram.message] });

  const acknowledgedMessages = await fetch(
    `${baseUrl}/api/conversations/discord%3A123/messages?limit=20&acknowledge=true`,
  );
  assert.equal(acknowledgedMessages.status, 200);
  assert.deepEqual(discordProvider.messageAcknowledgements.slice(-2), [false, true]);
});

test("validates and sends messages", async () => {
  const invalid = await fetch(`${baseUrl}/api/conversations/discord%3A123/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "" }),
  });
  assert.equal(invalid.status, 400);

  const sent = await fetch(`${baseUrl}/api/conversations/discord%3A123/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "new message" }),
  });
  assert.equal(sent.status, 201);
  assert.deepEqual(discordProvider.sent, { content: "new message" });

  const instagramSent = await fetch(`${baseUrl}/api/conversations/instagram%3Aabc/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "instagram message" }),
  });
  assert.equal(instagramSent.status, 201);
  assert.deepEqual(instagramProvider.sent, { content: "instagram message" });
});

test("connects the requested provider and rejects unknown ID prefixes", async () => {
  const connected = await fetch(`${baseUrl}/api/providers/instagram/connect`, { method: "POST" });
  assert.equal(connected.status, 200);
  assert.equal(instagramProvider.connectCalls, 1);

  const unknown = await fetch(`${baseUrl}/api/conversations/slack%3A123/messages`);
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json() as { error: { code: string } }).error.code, "INVALID_PROVIDER_ID");
});

test("streams provider events over SSE without response buffering", async () => {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  assert(response.body);

  discordProvider.emit("event", {
    type: "conversation.updated",
    provider: "discord",
    occurredAt: "2026-09-20T12:00:00.000Z",
    data: { ...conversation, unread: true },
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let streamed = "";
  try {
    while (!streamed.includes("event: conversation.updated")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      streamed += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel();
    controller.abort();
  }

  assert.match(streamed, /event: ready/);
  assert.match(streamed, /event: conversation\.updated/);
});

test("starts in a degraded setup state when no providers are configured", async () => {
  const emptyServer = createServer(createApp([]));
  await new Promise<void>((resolve) => emptyServer.listen(0, "127.0.0.1", resolve));
  try {
    const address = emptyServer.address();
    assert(address && typeof address !== "string");
    const emptyBaseUrl = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${emptyBaseUrl}/health`);
    assert.deepEqual(await health.json(), { status: "degraded", providers: [] });

    const listed = await fetch(`${emptyBaseUrl}/api/conversations`);
    assert.deepEqual(await listed.json(), { conversations: [] });
  } finally {
    await new Promise<void>((resolve, reject) => emptyServer.close((error) => error ? reject(error) : resolve()));
  }
});
