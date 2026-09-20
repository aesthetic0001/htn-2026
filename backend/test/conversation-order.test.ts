import assert from "node:assert/strict";
import { test } from "node:test";
import { applyProviderConversationOrder } from "../src/conversation-order.js";

test("keeps conversations in provider display order instead of title order", () => {
  const conversations = new Map([
    ["provider:1", { title: "Alpha" }],
    ["provider:2", { title: "Bravo" }],
    ["provider:3", { title: "Charlie" }],
  ]);

  applyProviderConversationOrder(conversations, ["provider:3", "provider:1", "provider:2"]);

  assert.deepEqual(
    [...conversations.values()].map(({ title }) => title),
    ["Charlie", "Alpha", "Bravo"],
  );
});

test("updates cached order when a provider moves a conversation to the top", () => {
  const conversations = new Map([
    ["provider:1", { title: "First" }],
    ["provider:2", { title: "Second" }],
    ["provider:3", { title: "Cached outside the latest DOM snapshot" }],
  ]);

  applyProviderConversationOrder(conversations, ["provider:2", "provider:1"]);

  assert.deepEqual([...conversations.keys()], ["provider:2", "provider:1", "provider:3"]);
});
