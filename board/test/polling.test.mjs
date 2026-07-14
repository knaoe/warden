import { test } from "node:test";
import assert from "node:assert/strict";

import { createPollingController, POLL_MS } from "../public/polling.js";

test("polling runs every 5s and cleanup removes timer and visibility listener", () => {
  const intervals = [];
  const cleared = [];
  const listeners = new Map();
  const documentRef = {
    hidden: false,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name, listener) => {
      if (listeners.get(name) === listener) listeners.delete(name);
    },
  };
  let refreshes = 0;
  const controller = createPollingController({
    refresh: () => { refreshes += 1; },
    documentRef,
    setIntervalImpl: (callback, ms) => {
      intervals.push({ callback, ms });
      return intervals.length;
    },
    clearIntervalImpl: (id) => cleared.push(id),
  });

  controller.start();
  assert.equal(POLL_MS, 5_000);
  assert.equal(intervals[0].ms, 5_000);
  assert.equal(listeners.has("visibilitychange"), true);

  documentRef.hidden = true;
  listeners.get("visibilitychange")();
  documentRef.hidden = false;
  listeners.get("visibilitychange")();
  assert.equal(refreshes, 1);
  assert.equal(intervals.length, 2);

  controller.cleanup();
  assert.equal(listeners.has("visibilitychange"), false);
  assert.ok(cleared.length >= 2);
});
