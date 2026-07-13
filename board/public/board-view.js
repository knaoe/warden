const ACTIVE_STATES = new Set(["queued", "running", "verifying"]);

function newestFirst(a, b) {
  return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
}

export function buildBoardModel(items) {
  const sorted = [...items].sort(newestFirst);
  const needsYou = sorted.filter((item) => item.needs_you === 1 || item.needs_you === true || item.state === "needs_you");
  const needsIds = new Set(needsYou.map((item) => item.id));
  return {
    needsYou,
    blocked: sorted.filter((item) => item.state === "blocked" && !needsIds.has(item.id)),
    running: sorted.filter((item) => ACTIVE_STATES.has(item.state) && !needsIds.has(item.id)),
    recent: sorted.slice(0, 8),
  };
}
