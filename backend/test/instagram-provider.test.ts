import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyInstagramLoginState,
  instagramThreadRowProviderId,
  normalizeInstagramConversationTitle,
  normalizeInstagramTimestamp,
} from "../src/instagram-provider.js";

test("recognizes current Instagram login outcomes", () => {
  assert.equal(classifyInstagramLoginState("/direct/inbox/", ""), "authenticated");
  assert.equal(classifyInstagramLoginState("/accounts/onetap/", "Save your login info?"), "authenticated");
  assert.equal(
    classifyInstagramLoginState(
      "/accounts/login/",
      "The login information you entered is incorrect. Find your account and log in.",
    ),
    "invalid-credentials",
  );
  assert.equal(classifyInstagramLoginState("/challenge/", "Enter your security code"), "verification");
  assert.equal(classifyInstagramLoginState("/accounts/login/", "Log into Instagram"), "pending");
});

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

test("gives linkless Instagram thread rows a stable identity without opening them", () => {
  const first = instagramThreadRowProviderId(
    "Nora Chen",
    "https://instagram.example/nora.jpg",
    ["Nora Chen's profile picture"],
  );
  const second = instagramThreadRowProviderId(
    "Nora Chen",
    "https://instagram.example/nora.jpg?signature=refreshed",
    ["Nora Chen's profile picture"],
  );

  assert.match(first, /^row-[a-f0-9]{24}$/);
  assert.equal(second, first);
});

test("normalizes Instagram date-bar timestamps without inventing missing times", () => {
  const reference = new Date(2026, 8, 20, 10, 30);

  assert.equal(
    normalizeInstagramTimestamp("00:07", reference),
    new Date(2026, 8, 20, 0, 7).toISOString(),
  );
  assert.equal(
    normalizeInstagramTimestamp("2:13 PM", reference),
    new Date(2026, 8, 20, 14, 13).toISOString(),
  );
  assert.equal(
    normalizeInstagramTimestamp("Yesterday, 2:13 AM", reference),
    new Date(2026, 8, 19, 2, 13).toISOString(),
  );
  assert.equal(
    normalizeInstagramTimestamp("Sat 11:59 PM", reference),
    new Date(2026, 8, 19, 23, 59).toISOString(),
  );
  assert.equal(
    normalizeInstagramTimestamp("Sep 18, 2026, 2:13 AM", reference),
    new Date(2026, 8, 18, 2, 13).toISOString(),
  );
  assert.equal(normalizeInstagramTimestamp(undefined, reference), undefined);
  assert.equal(normalizeInstagramTimestamp("not a timestamp", reference), undefined);
});
