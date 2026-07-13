import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { cacheBustedUrl, createUpdateGate } = require("../update-gate.js");

test("matching commits continue the existing lab flow without prompting", async () => {
  let prompts = 0;
  const gate = createUpdateGate({
    loadedCommit: "ABC123",
    getDeployedCommit: async () => "abc123",
    promptForRefresh: async () => { prompts += 1; return "cancel"; },
    refresh: () => assert.fail("matching commits must not refresh")
  });

  assert.equal(await gate.check(), true);
  assert.equal(prompts, 0);
});

test("a newer deployed commit blocks the lab when the user cancels", async () => {
  let labStarts = 0;
  const gate = createUpdateGate({
    loadedCommit: "old-commit",
    getDeployedCommit: async () => "new-commit",
    promptForRefresh: async () => "cancel",
    refresh: () => assert.fail("cancel must not refresh")
  });

  if (await gate.check()) labStarts += 1;
  assert.equal(labStarts, 0);
});

test("refreshing blocks the selected lab and requests one cache-busted reload", async () => {
  let labStarts = 0;
  let reloads = 0;
  const gate = createUpdateGate({
    loadedCommit: "old-commit",
    getDeployedCommit: async () => "new-commit",
    promptForRefresh: async () => "refresh",
    refresh: () => { reloads += 1; }
  });

  if (await gate.check()) labStarts += 1;
  assert.equal(labStarts, 0);
  assert.equal(reloads, 1);
  assert.equal(await gate.check(), false);
  assert.equal(reloads, 1);
  assert.equal(cacheBustedUrl("https://example.test/labs?tenant=one", 1234), "https://example.test/labs?tenant=one&refresh=1234");
});

test("no prerequisite or lab work starts before the refresh decision", async () => {
  let finishPrompt;
  let prerequisiteStarts = 0;
  let prompts = 0;
  const gate = createUpdateGate({
    loadedCommit: "old-commit",
    getDeployedCommit: async () => "new-commit",
    promptForRefresh: () => {
      prompts += 1;
      return new Promise(resolve => { finishPrompt = resolve; });
    },
    refresh: () => assert.fail("cancel must not refresh")
  });
  const begin = async () => {
    if (!(await gate.check())) return;
    prerequisiteStarts += 1;
  };

  const first = begin();
  const second = begin();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prerequisiteStarts, 0);
  assert.equal(prompts, 1);
  finishPrompt("cancel");
  await Promise.all([first, second]);
  assert.equal(prerequisiteStarts, 0);
});
