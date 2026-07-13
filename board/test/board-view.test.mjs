import { test } from "node:test";
import assert from "node:assert/strict";

import { buildBoardModel } from "../public/board-view.js";

test("buildBoardModel keeps needs-you, blocked, running, and recent meanings distinct", () => {
  const items = [
    { id: "done", state: "done", updated_at: "2026-07-11T00:00:00Z" },
    { id: "blocked", state: "blocked", updated_at: "2026-07-11T01:00:00Z" },
    { id: "running", state: "running", updated_at: "2026-07-11T02:00:00Z" },
    { id: "queued", state: "queued", updated_at: "2026-07-11T03:00:00Z" },
    { id: "needs", state: "needs_you", needs_you: 1, updated_at: "2026-07-11T04:00:00Z" },
  ];

  const model = buildBoardModel(items);

  assert.deepEqual(model.needsYou.map((item) => item.id), ["needs"]);
  assert.deepEqual(model.blocked.map((item) => item.id), ["blocked"]);
  assert.deepEqual(model.running.map((item) => item.id), ["queued", "running"]);
  assert.deepEqual(model.recent.map((item) => item.id), ["needs", "queued", "running", "blocked", "done"]);
});

test("buildBoardModel treats a needs_you flag as needs-you regardless of state", () => {
  const model = buildBoardModel([{ id: "flagged", state: "running", needs_you: 1, updated_at: "2026-07-11T00:00:00Z" }]);
  assert.deepEqual(model.needsYou.map((item) => item.id), ["flagged"]);
  assert.deepEqual(model.running, []);
});
