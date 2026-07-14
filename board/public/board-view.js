export const STATUS_COLUMNS = [
  { key: "queued", label: "QUEUED" },
  { key: "executing", label: "EXECUTING" },
  { key: "reviewVerify", label: "REVIEW / VERIFY" },
  { key: "needsUser", label: "NEEDS USER" },
  { key: "waitingExternal", label: "WAITING EXTERNAL" },
];
export const CONFLICT_MESSAGE = "Someone/something else updated this - refresh and retry.";

function newestFirst(a, b) {
  return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
}

function columnFor(item) {
  if (item.needs_you === 1 || item.needs_you === true || item.state === "needs_you") return "needsUser";
  if (item.state === "queued") return "queued";
  if (item.state === "running") return "executing";
  if (item.state === "verifying") return "reviewVerify";
  if (item.state === "blocked") return "waitingExternal";
  return null;
}

function emptyColumns() {
  return Object.fromEntries(STATUS_COLUMNS.map(({ key }) => [key, []]));
}

export function buildBoardModel(items) {
  const projects = new Map();
  const counts = Object.fromEntries(STATUS_COLUMNS.map(({ key }) => [key, 0]));
  for (const item of [...items].sort(newestFirst)) {
    const column = columnFor(item);
    if (!column) continue;
    const name = item.project || "Unassigned project";
    if (!projects.has(name)) projects.set(name, { name, columns: emptyColumns() });
    projects.get(name).columns[column].push(item);
    counts[column] += 1;
  }
  return {
    projects: [...projects.values()].sort((a, b) => a.name.localeCompare(b.name)),
    counts,
  };
}

export function createActionRequest(item, action, instruction = "") {
  const request = { action, epoch: item.owner_epoch };
  if (action === "instruction") request.instruction = instruction.trim();
  return request;
}

function snoozeKey(item) {
  return `fleet:snooze:${item.id}:${item.updated_at || "unknown"}`;
}

export function snoozeDecision(storage, item, now = Date.now()) {
  storage.setItem(snoozeKey(item), String(now + 60 * 60 * 1000));
}

export function isDecisionSnoozed(storage, item, now = Date.now()) {
  const key = snoozeKey(item);
  const until = Number(storage.getItem(key));
  if (Number.isFinite(until) && until > now) return true;
  if (storage.getItem(key) !== null) storage.removeItem(key);
  return false;
}

export function relativeTime(value, now = Date.now()) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "unknown";
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function buildActivityModel(events, now = Date.now()) {
  return events.map((event) => ({
    id: event.id,
    kind: event.kind,
    detail: event.detail ?? "",
    relativeTime: relativeTime(event.at, now),
    workItemId: event.work_item_id ?? null,
  }));
}
