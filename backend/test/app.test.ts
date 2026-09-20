import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:http";
import { createApp } from "../src/app.js";
import type { Conversation, Message, MessageProvider, SendMessageInput } from "../src/types.js";

const conversation: Conversation = {
  id: "discord:123",
  provider: "discord",
  providerConversationId: "123",
  title: "Friends",
  kind: "direct",
  unread: false,
  muted: false,
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

class FakeProvider extends EventEmitter implements MessageProvider {
  readonly name = "discord" as const;
  sent?: SendMessageInput;
  status() { return { state: "connected" as const }; }
  async connect() {}
  async disconnect() {}
  async listConversations() { return [conversation]; }
  async listMessages() { return [message]; }
  async sendMessage(_id: string, input: SendMessageInput) { this.sent = input; return { ...message, content: input.content }; }
  async addReaction() {}
}

const provider = new FakeProvider();
let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer(createApp(provider));
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
  assert.deepEqual(await response.json(), { status: "ok", provider: { name: "discord", state: "connected" } });
});

test("lists normalized conversations and messages", async () => {
  const conversations = await fetch(`${baseUrl}/api/conversations`);
  assert.deepEqual(await conversations.json(), { conversations: [conversation] });

  const messages = await fetch(`${baseUrl}/api/conversations/discord%3A123/messages?limit=20`);
  assert.deepEqual(await messages.json(), { messages: [message] });
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
  assert.deepEqual(provider.sent, { content: "new message" });
});
