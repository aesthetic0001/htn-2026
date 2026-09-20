import assert from "node:assert/strict";
import { test } from "node:test";
import {
  conversationNotificationChanged,
  discordConversationNotification,
  extractInstagramConversationPreview,
  instagramConversationNotification,
} from "../src/conversation-notification.js";
import type { Conversation } from "../src/types.js";

test("reads Discord mention counts from native badge text", () => {
  assert.deepEqual(
    discordConversationNotification("Alice, 2 mentions", "2 Mentions", true, true),
    { unread: true, notification: { kind: "mention", count: 2 } },
  );
});

test("keeps Discord unread indicators without inventing a count", () => {
  assert.deepEqual(
    discordConversationNotification("Alice, unread", "Unread", true, false),
    { unread: true, notification: { kind: "unread" } },
  );
});

test("recognizes Instagram row copy and blue-dot state as unread", () => {
  assert.deepEqual(
    instagramConversationNotification("Nora Chen\nNew messages...\n2h", "", false),
    { unread: true, notification: { kind: "unread" } },
  );
  assert.equal(instagramConversationNotification("Nora Chen\nSent a reel\n2h", "", true).unread, true);
});

test("extracts Instagram's next-text preview and normalizes its new-message copy", () => {
  assert.equal(extractInstagramConversationPreview("Nora Chen\nSent a reel\n2h", "Nora Chen"), "Sent a reel");
  assert.equal(extractInstagramConversationPreview("Nora Chen\nNew messages...\n2h", "Nora Chen"), "New messages…");
});

test("emits another notification when an unread preview or badge count changes", () => {
  const previous = conversation({ preview: "First message", count: 1 });
  assert.equal(
    conversationNotificationChanged(previous, conversation({ preview: "Second message", count: 1 })),
    true,
  );
  assert.equal(
    conversationNotificationChanged(previous, conversation({ preview: "First message", count: 2 })),
    true,
  );
  assert.equal(conversationNotificationChanged(previous, previous), false);
});

function conversation({ preview, count }: { preview: string; count: number }): Conversation {
  return {
    id: "discord:1",
    provider: "discord",
    providerConversationId: "1",
    title: "Alice",
    kind: "direct",
    unread: true,
    preview,
    notification: { kind: "mention", count },
  };
}
