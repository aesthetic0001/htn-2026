import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyInstagramLoginState,
  instagramThreadRowProviderId,
  normalizeInstagramConversationTitle,
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
