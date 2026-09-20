import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeDiscordMessages,
  type RawDiscordMessage,
} from "../src/discord-message-normalizer.js";

const conversationId = "discord:123456789012345678";
const messageId = "175928847299117063";

function raw(overrides: Partial<RawDiscordMessage> = {}): RawDiscordMessage {
  return {
    id: messageId,
    author: "Ada",
    content: "hello",
    timestamp: "2026-09-20T04:10:00.000Z",
    edited: false,
    attachments: [],
    reactions: [],
    ...overrides,
  };
}

test("drops Discord UI rows and empty message shells", () => {
  const messages = normalizeDiscordMessages([
    raw({ id: "chat-messages___divider-before-unread", content: "Unread" }),
    raw({ id: "123456789012345679", content: "", attachments: [] }),
    raw(),
  ], conversationId, 50);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.providerMessageId, messageId);
});

test("merges duplicate DOM nodes without replacing complete message data", () => {
  const messages = normalizeDiscordMessages([
    raw({
      avatarUrl: "https://cdn.discordapp.com/avatar.png",
      attachments: [{ name: "notes.pdf", url: "https://cdn.discordapp.com/notes.pdf" }],
    }),
    raw({ author: undefined, avatarUrl: undefined, content: "", timestamp: undefined }),
  ], conversationId, 50);

  assert.deepEqual(messages, [{
    id: `discord:${messageId}`,
    provider: "discord",
    providerMessageId: messageId,
    conversationId,
    author: { displayName: "Ada", avatarUrl: "https://cdn.discordapp.com/avatar.png" },
    content: "hello",
    sentAt: "2026-09-20T04:10:00.000Z",
    edited: false,
    attachments: [{ name: "notes.pdf", url: "https://cdn.discordapp.com/notes.pdf" }],
    reactions: [],
  }]);
});

test("derives a stable timestamp from the Discord snowflake when the DOM omits it", () => {
  const [message] = normalizeDiscordMessages([
    raw({ timestamp: undefined }),
  ], conversationId, 50);

  assert.equal(message?.sentAt, "2016-04-30T11:18:25.796Z");
});
