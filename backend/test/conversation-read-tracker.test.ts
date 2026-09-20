import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationReadTracker } from "../src/conversation-read-tracker.js";
import type { Conversation, Message } from "../src/types.js";

test("keeps a conversation unread after the provider clears its native bubble", () => {
  const tracker = new ConversationReadTracker();
  tracker.observeNativeNotification("discord:1", { kind: "mention", count: 1 });
  tracker.observeNativeNotification("discord:1", undefined);

  const tracked = tracker.apply(conversation());
  assert.equal(tracked.unread, true);
  assert.equal(tracked.notification?.kind, "unread");
  assert.notEqual(tracked.lastUpdatedAt, tracked.lastAcknowledgedAt);
});

test("only acknowledges updates when the Providence thread explicitly does so", () => {
  const tracker = new ConversationReadTracker();
  tracker.observeNativeNotification("discord:1", { kind: "unread" });
  const updated = tracker.apply(conversation());
  tracker.acknowledge("discord:1");
  const acknowledged = tracker.apply(conversation());

  assert.equal(updated.unread, true);
  assert.equal(acknowledged.unread, false);
  assert.equal(acknowledged.lastAcknowledgedAt, acknowledged.lastUpdatedAt);
});

test("detects new incoming messages in a provider tab that remained open", () => {
  const tracker = new ConversationReadTracker();
  tracker.observeMessages("discord:1", [message("discord:10")]);
  tracker.acknowledge("discord:1");

  assert.equal(tracker.observeMessages("discord:1", [message("discord:10"), message("discord:11")]), true);
  assert.equal(tracker.apply(conversation()).unread, true);
});

test("does not mark outgoing messages as unread", () => {
  const tracker = new ConversationReadTracker();
  tracker.observeMessages("discord:1", [message("discord:10")]);
  tracker.acknowledge("discord:1");

  assert.equal(tracker.observeMessages("discord:1", [message("discord:10"), message("discord:11", true)]), false);
  assert.equal(tracker.apply(conversation()).unread, false);
});

function conversation(): Conversation {
  return {
    id: "discord:1",
    provider: "discord",
    providerConversationId: "1",
    title: "Alice",
    kind: "direct",
    unread: false,
  };
}

function message(id: string, mine = false): Message {
  return {
    id,
    provider: "discord",
    providerMessageId: id.split(":")[1] ?? id,
    conversationId: "discord:1",
    author: { ...(mine ? { id: "me" } : {}), displayName: mine ? "You" : "Alice" },
    content: id,
    sentAt: "2026-09-20T12:00:00.000Z",
    edited: false,
    attachments: [],
    reactions: [],
  };
}
