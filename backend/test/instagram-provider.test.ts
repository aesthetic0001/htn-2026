import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeInstagramConversationTitle } from "../src/instagram-provider.js";

test("extracts an Instagram conversation title from the visible thread row", () => {
  assert.equal(
    normalizeInstagramConversationTitle("Nora Chen\nSent a reel\n2h", "", ["Nora Chen's profile picture"], "123"),
    "Nora Chen",
  );
});

test("falls back to accessible labels, image alt text, and provider IDs", () => {
  assert.equal(normalizeInstagramConversationTitle("", "Weekend plans, unread", [], "123"), "Weekend plans");
  assert.equal(normalizeInstagramConversationTitle("", "", ["Grace's profile picture"], "123"), "Grace");
  assert.equal(normalizeInstagramConversationTitle("", "", [], "123"), "Instagram 123");
});
