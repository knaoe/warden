import {
  buildActivityModel,
  buildBoardModel,
  CONFLICT_MESSAGE,
  createActionRequest,
  isDecisionSnoozed,
  relativeTime,
  snoozeDecision,
  STATUS_COLUMNS,
} from "./board-view.js";
import { createPollingController } from "./polling.js";

const board = document.querySelector("#board");
const activity = document.querySelector("#activity");
const status = document.querySelector("#status");
const refreshed = document.querySelector("#refreshed");
const toast = document.querySelector("#toast");
let toastTimer;
let currentItems = [];

function text(tag, value, className) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value;
  return element;
}

function safeExternalUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function showToast(message, tone = "success") {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4_500);
}

async function postAction(item, action, instruction, card) {
  const response = await fetch(`/api/work/${encodeURIComponent(item.id)}/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(createActionRequest(item, action, instruction)),
  });
  if (response.status === 409) {
    showToast(CONFLICT_MESSAGE, "error");
    return false;
  }
  if (!response.ok) {
    showToast("Action was not recorded. Try again.", "error");
    return false;
  }
  if (action === "instruction") {
    showToast("Recorded - visible next time the agent checks in.");
    return true;
  }
  card.classList.add("card--resolving");
  showToast(action === "approve" ? "Decision approved and queued." : "Decision rejected and blocked.");
  setTimeout(refresh, 420);
  return true;
}

function factsFor(item) {
  const facts = document.createElement("div");
  facts.className = "facts";
  if (item.assignee) facts.append(text("span", `@${item.assignee}`, "pill"));
  else if (item.owner) facts.append(text("span", item.owner, "pill"));
  if (item.gate_status && item.gate_status !== "none") facts.append(text("span", `gate ${item.gate_status}`, "pill pill--violet"));
  facts.append(text("span", `P${item.priority ?? 100}`, "pill pill--quiet"));
  return facts;
}

function decisionControls(item, card) {
  const wrap = document.createElement("div");
  wrap.className = "decision-controls";
  const actions = document.createElement("div");
  actions.className = "decision-actions";
  const approve = text("button", "Approve", "button button--approve");
  const reject = text("button", "Reject", "button button--reject");
  const snooze = text("button", "Snooze 1h", "button button--snooze");
  approve.type = reject.type = snooze.type = "button";
  approve.addEventListener("click", () => postAction(item, "approve", "", card));
  reject.addEventListener("click", () => postAction(item, "reject", "", card));
  snooze.addEventListener("click", () => {
    snoozeDecision(localStorage, item);
    renderBoard(currentItems);
    showToast("Urgency snoozed for 1 hour. Source data is unchanged.");
  });
  actions.append(approve, reject, snooze);

  const instruction = document.createElement("form");
  instruction.className = "instruction";
  const input = document.createElement("input");
  input.name = "instruction";
  input.maxLength = 500;
  input.required = true;
  input.placeholder = "Record instruction in ledger…";
  input.setAttribute("aria-label", `Instruction for ${item.title || item.id}`);
  const send = text("button", "Record", "button button--record");
  send.type = "submit";
  instruction.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    input.disabled = send.disabled = true;
    const ok = await postAction(item, "instruction", value, card);
    if (ok) input.value = "";
    input.disabled = send.disabled = false;
  });
  instruction.append(input, send);
  wrap.append(actions, instruction);
  return wrap;
}

function cardFor(item, column) {
  const card = document.createElement("article");
  const snoozed = column === "needsUser" && isDecisionSnoozed(localStorage, item);
  card.className = `card card--${column}${snoozed ? " card--snoozed" : ""}`;
  card.dataset.workId = item.id;
  const top = document.createElement("div");
  top.className = "card__top";
  top.append(text("span", item.id || "NO-ID", "work-id"));
  if (column === "needsUser") top.append(text("span", snoozed ? "SNOOZED" : "DECISION", `decision-badge${snoozed ? " decision-badge--snoozed" : ""}`));
  top.append(text("span", relativeTime(item.updated_at), "timestamp"));
  card.append(top, text("h3", item.title || "Untitled work"));
  card.append(factsFor(item));
  if (item.blocked_reason) card.append(text("p", item.blocked_reason, "detail detail--blocked"));
  if (item.next_action) card.append(text("p", item.next_action, "detail"));
  const href = safeExternalUrl(item.external_url);
  if (href) {
    const link = text("a", "Open related work", "external-link");
    link.href = href;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    card.append(link);
  }
  if (column === "needsUser") card.append(decisionControls(item, card));
  return card;
}

function columnCell(column, items) {
  const cell = document.createElement("div");
  cell.className = `matrix-cell matrix-cell--${column}${items.length ? "" : " matrix-cell--empty"}`;
  cell.dataset.columnLabel = STATUS_COLUMNS.find(({ key }) => key === column).label;
  if (items.length) cell.append(...items.map((item) => cardFor(item, column)));
  else cell.append(text("span", "—", "empty-cell"));
  return cell;
}

function projectRow(project) {
  const row = document.createElement("section");
  row.className = "project-row";
  const meta = document.createElement("header");
  meta.className = "project-meta";
  const total = Object.values(project.columns).reduce((sum, items) => sum + items.length, 0);
  meta.append(text("h2", project.name), text("p", `${total} active ${total === 1 ? "item" : "items"}`));
  row.append(meta, ...STATUS_COLUMNS.map(({ key }) => columnCell(key, project.columns[key])));
  return row;
}

function renderBoard(items) {
  currentItems = items;
  const model = buildBoardModel(items);
  const header = document.createElement("header");
  header.className = "matrix-header";
  header.append(text("span", `PROJECTS · ${model.projects.length}`));
  for (const { key, label } of STATUS_COLUMNS) {
    const heading = document.createElement("div");
    heading.className = `column-heading column-heading--${key}`;
    heading.append(text("span", label), text("strong", String(model.counts[key])));
    header.append(heading);
  }
  const rows = model.projects.length ? model.projects.map(projectRow) : [text("p", "No active work right now.", "board-empty")];
  board.replaceChildren(header, ...rows);
}

function renderActivity(events) {
  const rows = buildActivityModel(events);
  if (!rows.length) {
    activity.replaceChildren(text("p", "No ledger activity yet.", "activity-empty"));
    return;
  }
  activity.replaceChildren(...rows.map((event) => {
    const row = document.createElement("article");
    row.className = "activity-item";
    row.append(text("p", event.kind, "activity-kind"), text("p", event.detail || "—", "activity-detail"));
    const meta = document.createElement("p");
    meta.className = "activity-time";
    meta.textContent = event.workItemId ? `${event.workItemId} · ${event.relativeTime}` : event.relativeTime;
    row.append(meta);
    return row;
  }));
}

async function refresh() {
  status.textContent = "Refreshing";
  status.dataset.state = "loading";
  try {
    const [boardResponse, eventsResponse] = await Promise.all([
      fetch("/api/board", { cache: "no-store" }),
      fetch("/api/events?limit=30", { cache: "no-store" }),
    ]);
    if (!boardResponse.ok || !eventsResponse.ok) throw new Error("upstream response failed");
    const [snapshot, eventSnapshot] = await Promise.all([boardResponse.json(), eventsResponse.json()]);
    renderBoard(snapshot.items || []);
    renderActivity(eventSnapshot.events || []);
    refreshed.textContent = `Updated ${new Date(snapshot.fetched_at).toLocaleTimeString()}`;
    status.textContent = "Connected";
    status.dataset.state = "live";
  } catch {
    status.textContent = "Warden unavailable";
    status.dataset.state = "error";
  }
}

const polling = createPollingController({ refresh });
function cleanup() {
  polling.cleanup();
  clearTimeout(toastTimer);
  window.removeEventListener("pagehide", cleanup);
}
window.addEventListener("pagehide", cleanup);
refresh();
polling.start();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
