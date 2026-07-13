export const POLL_MS = 5_000;

export function createPollingController({
  refresh,
  documentRef = document,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) {
  let timer;

  function schedule() {
    clearIntervalImpl(timer);
    timer = setIntervalImpl(refresh, POLL_MS);
  }

  function onVisibilityChange() {
    if (documentRef.hidden) clearIntervalImpl(timer);
    else {
      refresh();
      schedule();
    }
  }

  function start() {
    documentRef.addEventListener("visibilitychange", onVisibilityChange);
    schedule();
  }

  function cleanup() {
    clearIntervalImpl(timer);
    documentRef.removeEventListener("visibilitychange", onVisibilityChange);
  }

  return { start, cleanup };
}
