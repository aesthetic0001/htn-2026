import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDiscordConversationTitle } from "../src/discord-conversation-title.js";

test("removes Discord UI annotations from conversation titles", () => {
  assert.equal(normalizeDiscordConversationTitle("Alice (direct message)"), "Alice");
  assert.equal(normalizeDiscordConversationTitle("Study Group (group message), Muted"), "Study Group");
  assert.equal(normalizeDiscordConversationTitle("Weekend Plans, 8 Members, Unread, Selected"), "Weekend Plans");
  assert.equal(normalizeDiscordConversationTitle("tallbingo, Do Not Disturb"), "tallbingo");
  assert.equal(normalizeDiscordConversationTitle("Alice (direct message), Online, Muted"), "Alice");
  assert.equal(normalizeDiscordConversationTitle("Unread, aesthetic"), "aesthetic");
  assert.equal(normalizeDiscordConversationTitle("Unread, aesthetic (direct message), Online"), "aesthetic");
});

test("preserves punctuation and words that belong to the title", () => {
  assert.equal(normalizeDiscordConversationTitle("Smith, John (direct message), Muted"), "Smith, John");
  assert.equal(normalizeDiscordConversationTitle("Muted"), "Muted");
  assert.equal(normalizeDiscordConversationTitle("Friends (2026)"), "Friends (2026)");
});
