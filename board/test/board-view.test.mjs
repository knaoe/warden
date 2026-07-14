import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildActivityModel,
  buildBoardModel,
  CONFLICT_MESSAGE,
  createActionRequest,
  isDecisionSnoozed,
  snoozeDecision,
} from "../public/board-view.js";

test("buildBoardModel groups project rows into five status columns and excludes done", () => {
  const items = [
    { id: "done", project: "Beta", state: "done", updated_at: "2026-07-11T00:00:00Z" },
    { id: "blocked", project: "Alpha", state: "blocked", updated_at: "2026-07-11T01:00:00Z" },
    { id: "running", project: "Alpha", state: "running", updated_at: "2026-07-11T02:00:00Z" },
    { id: "queued", project: "Beta", state: "queued", updated_at: "2026-07-11T03:00:00Z" },
    { id: "verify", project: "Alpha", state: "verifying", updated_at: "2026-07-11T04:00:00Z" },
    { id: "needs", project: "Beta", state: "running", needs_you: 1, updated_at: "2026-07-11T05:00:00Z" },
  ];

  const model = buildBoardModel(items);

  assert.deepEqual(model.projects.map((project) => project.name), ["Alpha", "Beta"]);
  assert.deepEqual(model.projects[0].columns.executing.map((item) => item.id), ["running"]);
  assert.deepEqual(model.projects[0].columns.reviewVerify.map((item) => item.id), ["verify"]);
  assert.deepEqual(model.projects[0].columns.waitingExternal.map((item) => item.id), ["blocked"]);
  assert.deepEqual(model.projects[1].columns.queued.map((item) => item.id), ["queued"]);
  assert.deepEqual(model.projects[1].columns.needsUser.map((item) => item.id), ["needs"]);
  assert.equal(model.projects.flatMap((project) => Object.values(project.columns).flat()).some((item) => item.id === "done"), false);
  assert.deepEqual(model.counts, { queued: 1, executing: 1, reviewVerify: 1, needsUser: 1, waitingExternal: 1 });
});

test("decision requests use the latest owner epoch and never include gate_status", () => {
  const item = { id: "w1", owner_epoch: 42 };

  assert.deepEqual(createActionRequest(item, "approve"), { action: "approve", epoch: 42 });
  assert.deepEqual(createActionRequest(item, "reject"), { action: "reject", epoch: 42 });
  assert.deepEqual(
    createActionRequest(item, "instruction", " Check the release gate. "),
    { action: "instruction", epoch: 42, instruction: "Check the release gate." },
  );
  assert.equal("gate_status" in createActionRequest(item, "approve"), false);
  assert.equal(CONFLICT_MESSAGE, "Someone/something else updated this - refresh and retry.");
});

test("Snooze 1h persists by work id and item timestamp without changing source data", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const item = { id: "w1", updated_at: "2026-07-12T01:02:03Z", needs_you: 1 };
  const before = structuredClone(item);

  snoozeDecision(storage, item, 1_000);

  assert.equal(values.has("fleet:snooze:w1:2026-07-12T01:02:03Z"), true);
  assert.equal(isDecisionSnoozed(storage, item, 1_000 + 3_599_999), true);
  assert.equal(isDecisionSnoozed(storage, item, 1_000 + 3_600_001), false);
  assert.deepEqual(item, before);
});

test("activity model renders raw kind, raw detail, and relative time including done events", () => {
  const model = buildActivityModel([
    { id: 2, kind: "state", detail: "state=done", at: "2026-07-12T12:59:30Z" },
    { id: 1, kind: "claimed", detail: "worker epoch=4", at: "2026-07-12T12:58:00Z" },
  ], Date.parse("2026-07-12T13:00:00Z"));

  assert.deepEqual(model, [
    { id: 2, kind: "state", detail: "state=done", relativeTime: "30s ago", workItemId: null },
    { id: 1, kind: "claimed", detail: "worker epoch=4", relativeTime: "2m ago", workItemId: null },
  ]);
});
