import { buildBoardModel } from "./board-view.js";

const POLL_MS = 10_000;
const board = document.querySelector("#board");
const status = document.querySelector("#status");
const refreshed = document.querySelector("#refreshed");
let pollTimer;

const laneDefinitions = [
  ["needsYou", "NEEDS YOU", "Waiting for Ken", "attention"],
  ["blocked", "BLOCKED", "Stopped by a concrete dependency", "blocked"],
  ["running", "RUNNING", "Queued, running, or being verified", "active"],
  ["recent", "RECENT CHANGES", "Latest ledger updates", "recent"],
];

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

function relativeTime(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "Unknown update time";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function cardFor(item, tone) {
  const card = document.createElement("article");
  card.className = `card card--${tone}`;
  const top = document.createElement("div");
  top.className = "card__top";
  top.append(text("span", item.project || "Unassigned project", "eyebrow"));
  top.append(text("span", relativeTime(item.updated_at), "timestamp"));
  card.append(top, text("h3", item.title || "Untitled work"));

  const facts = document.createElement("div");
  facts.className = "facts";
  facts.append(text("span", item.state || "unknown", "pill"));
  if (item.assignee) facts.append(text("span", `@${item.assignee}`, "pill pill--quiet"));
  if (item.gate_status && item.gate_status !== "none") facts.append(text("span", `gate: ${item.gate_status}`, "pill pill--quiet"));
  card.append(facts);

  if (item.blocked_reason) card.append(text("p", item.blocked_reason, "detail detail--blocked"));
  if (item.next_action) card.append(text("p", item.next_action, "detail"));
  const href = safeExternalUrl(item.external_url);
  if (href) {
    const link = text("a", "Open related work ↗", "external-link");
    link.href = href;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    card.append(link);
  }
  return card;
}

function laneFor(key, title, subtitle, tone, items) {
  const section = document.createElement("section");
  section.className = `lane lane--${tone}`;
  const heading = document.createElement("header");
  heading.className = "lane__heading";
  const titleRow = document.createElement("div");
  titleRow.className = "lane__title-row";
  if (key === "needsYou") {
    const badge = document.createElement("img");
    badge.src = "/icons/needs-attention-badge.svg";
    badge.alt = "";
    titleRow.append(badge);
  }
  titleRow.append(text("h2", title));
  titleRow.append(text("span", String(items.length), "count"));
  heading.append(titleRow, text("p", subtitle));
  section.append(heading);

  const cards = document.createElement("div");
  cards.className = "cards";
  if (items.length === 0) cards.append(text("p", "Nothing here right now.", "empty"));
  else cards.append(...items.map((item) => cardFor(item, tone)));
  section.append(cards);
  return section;
}

async function refresh() {
  status.textContent = "Refreshing";
  try {
    const response = await fetch("/api/board", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const snapshot = await response.json();
    const model = buildBoardModel(snapshot.items || []);
    board.replaceChildren(...laneDefinitions.map(([key, title, subtitle, tone]) => laneFor(key, title, subtitle, tone, model[key])));
    refreshed.textContent = `Updated ${new Date(snapshot.fetched_at).toLocaleTimeString()}`;
    status.textContent = "Live";
    status.dataset.state = "live";
  } catch {
    status.textContent = "Warden unavailable";
    status.dataset.state = "error";
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, POLL_MS);
}

function onVisibilityChange() {
  if (document.hidden) clearInterval(pollTimer);
  else {
    refresh();
    startPolling();
  }
}

function cleanup() {
  clearInterval(pollTimer);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  window.removeEventListener("pagehide", cleanup);
}

document.addEventListener("visibilitychange", onVisibilityChange);
window.addEventListener("pagehide", cleanup);
refresh();
startPolling();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
