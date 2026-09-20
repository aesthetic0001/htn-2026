import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:http";
import { createApp } from "../src/app.js";
import { ProfileMergeStore } from "../src/profile-merge-store.js";
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
  sentConversationId?: string;
  reactionConversationId?: string;
  deletedMessage?: { conversationId: string; messageId: string };
  connectCalls = 0;
  messageAcknowledgements: boolean[] = [];
  constructor(
    readonly name: ProviderName,
    private readonly conversation: Conversation,
    private readonly message: Message | Message[],
  ) { super(); }
  status() { return { state: "connected" as const }; }
  async connect() { this.connectCalls += 1; }
  async disconnect() {}
  async listConversations() { return [this.conversation]; }
  async listMessages(_conversationId: string, _limit: number, acknowledge = false) {
    this.messageAcknowledgements.push(acknowledge);
    return Array.isArray(this.message) ? this.message : [this.message];
  }
  async sendMessage(id: string, input: SendMessageInput) {
    this.sent = input;
    this.sentConversationId = id;
    const message = Array.isArray(this.message) ? this.message[0]! : this.message;
    return { ...message, conversationId: id, content: input.content };
  }
  async deleteMessage(conversationId: string, messageId: string) {
    this.deletedMessage = { conversationId, messageId };
  }
  async addReaction(conversationId: string) { this.reactionConversationId = conversationId; }
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

test("validates, sends, and deletes messages", async () => {
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

  const deleted = await fetch(
    `${baseUrl}/api/conversations/discord%3A123/messages/discord%3A456`,
    { method: "DELETE" },
  );
  assert.equal(deleted.status, 204);
  assert.deepEqual(discordProvider.deletedMessage, {
    conversationId: "discord:123",
    messageId: "discord:456",
  });
});

test("manually merges direct messages and routes sends by frequency or override", async () => {
  const discordConversation: Conversation = {
    ...conversation,
    title: "Ada on Discord",
    preview: "latest discord message",
    lastUpdatedAt: "2026-01-03T00:00:00.000Z",
  };
  const discordMessages: Message[] = [
    { ...message, id: "discord:455", providerMessageId: "455", sentAt: "2026-01-01T00:00:00.000Z" },
    { ...message, id: "discord:456", providerMessageId: "456", sentAt: "2026-01-03T00:00:00.000Z" },
  ];
  const instagramConversation: Conversation = {
    ...instagram.conversation,
    title: "Ada on Instagram",
    preview: "instagram message",
    lastUpdatedAt: "2026-01-02T00:00:00.000Z",
  };
  const instagramMessage: Message = {
    ...instagram.message,
    sentAt: "2026-01-02T00:00:00.000Z",
  };
  const discord = new FakeProvider("discord", discordConversation, discordMessages);
  const instagramSource = new FakeProvider("instagram", instagramConversation, instagramMessage);
  const mergeServer = createServer(createApp(
    [discord, instagramSource],
    "*",
    new ProfileMergeStore(),
  ));
  await new Promise<void>((resolve) => mergeServer.listen(0, "127.0.0.1", resolve));

  try {
    const address = mergeServer.address();
    assert(address && typeof address !== "string");
    const mergeBaseUrl = `http://127.0.0.1:${address.port}`;

    const created = await fetch(`${mergeBaseUrl}/api/profile-merges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationIds: [discordConversation.id, instagramConversation.id] }),
    });
    assert.equal(created.status, 201);
    const profile = (await created.json() as { profile: { id: string } }).profile;
    assert.match(profile.id, /^profile:/);

    const listed = await fetch(`${mergeBaseUrl}/api/conversations`);
    const listedBody = await listed.json() as { conversations: Conversation[] };
    assert.equal(listedBody.conversations.length, 1);
    assert.deepEqual(listedBody.conversations[0], {
      id: profile.id,
      provider: "merged",
      providerConversationId: profile.id.slice("profile:".length),
      title: "Ada on Discord",
      kind: "direct",
      unread: true,
      preview: "latest discord message",
      notification: { kind: "unread" },
      lastUpdatedAt: "2026-01-03T00:00:00.000Z",
      sources: [
        { conversationId: "discord:123", provider: "discord", title: "Ada on Discord" },
        { conversationId: "instagram:abc", provider: "instagram", title: "Ada on Instagram" },
      ],
      sendRoute: "most_frequent",
    });

    const mergedMessages = await fetch(
      `${mergeBaseUrl}/api/conversations/${encodeURIComponent(profile.id)}/messages?limit=10&acknowledge=true`,
    );
    const mergedBody = await mergedMessages.json() as { messages: Message[] };
    assert.deepEqual(mergedBody.messages.map(({ id }) => id), ["discord:455", "instagram:def", "discord:456"]);
    assert.equal(discord.messageAcknowledgements.at(-1), true);
    assert.equal(instagramSource.messageAcknowledgements.at(-1), true);

    const automaticSend = await fetch(
      `${mergeBaseUrl}/api/conversations/${encodeURIComponent(profile.id)}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "automatic" }),
      },
    );
    assert.equal(automaticSend.status, 201);
    assert.equal(discord.sentConversationId, discordConversation.id);

    const overridden = await fetch(`${mergeBaseUrl}/api/profile-merges/${encodeURIComponent(profile.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sendConversationId: instagramConversation.id }),
    });
    assert.equal(overridden.status, 200);

    const overrideSend = await fetch(
      `${mergeBaseUrl}/api/conversations/${encodeURIComponent(profile.id)}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "override" }),
      },
    );
    assert.equal(overrideSend.status, 201);
    assert.equal(instagramSource.sentConversationId, instagramConversation.id);

    const reacted = await fetch(
      `${mergeBaseUrl}/api/conversations/${encodeURIComponent(profile.id)}/messages/instagram%3Adef/reactions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emoji: "❤️" }),
      },
    );
    assert.equal(reacted.status, 204);
    assert.equal(instagramSource.reactionConversationId, instagramConversation.id);

    const deleted = await fetch(
      `${mergeBaseUrl}/api/conversations/${encodeURIComponent(profile.id)}/messages/instagram%3Adef`,
      { method: "DELETE" },
    );
    assert.equal(deleted.status, 204);
    assert.deepEqual(instagramSource.deletedMessage, {
      conversationId: instagramConversation.id,
      messageId: "instagram:def",
    });

    const removed = await fetch(`${mergeBaseUrl}/api/profile-merges/${encodeURIComponent(profile.id)}`, {
      method: "DELETE",
    });
    assert.equal(removed.status, 204);
    const unmerged = await fetch(`${mergeBaseUrl}/api/conversations`);
    assert.equal((await unmerged.json() as { conversations: Conversation[] }).conversations.length, 2);
  } finally {
    await new Promise<void>((resolve, reject) => mergeServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("rejects invalid manual profile merges", async () => {
  const oneConversation = await fetch(`${baseUrl}/api/profile-merges`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationIds: [conversation.id] }),
  });
  assert.equal(oneConversation.status, 400);

  const missingConversation = await fetch(`${baseUrl}/api/profile-merges`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationIds: [conversation.id, "discord:missing"] }),
  });
  assert.equal(missingConversation.status, 400);
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
