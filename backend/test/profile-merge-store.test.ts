import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ProfileMergeStore } from "../src/profile-merge-store.js";

test("persists profile merges and sending overrides", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "providence-profile-merges-"));
  const storagePath = path.join(directory, "profile-merges.json");
  try {
    const store = new ProfileMergeStore(storagePath);
    const created = store.create({ conversationIds: ["discord:1", "instagram:2"] });
    store.update(created.id, { sendConversationId: "instagram:2" });

    const restored = new ProfileMergeStore(storagePath).get(created.id);
    assert.deepEqual(restored, {
      ...created,
      sendConversationId: "instagram:2",
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("prevents a direct message from belonging to multiple profiles", () => {
  const store = new ProfileMergeStore();
  store.create({ conversationIds: ["discord:1", "instagram:2"] });
  assert.throws(
    () => store.create({ conversationIds: ["discord:1", "instagram:3"] }),
    /already belongs to a merged profile/,
  );
});
