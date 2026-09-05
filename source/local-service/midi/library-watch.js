import { watch } from "node:fs";

export function watchPerformanceLibrary({
  root,
  onChange,
  debounceMs = 750,
  watchImpl = watch,
  onError = error => console.error(`[midi-library-watch] ${error.message}`),
}) {
  if (!root) throw new TypeError("watchPerformanceLibrary requires a root");
  if (typeof onChange !== "function") throw new TypeError("watchPerformanceLibrary requires onChange");

  let closed = false;
  let timer = null;
  const schedule = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!closed) Promise.resolve(onChange()).catch(onError);
    }, Math.max(10, Number(debounceMs) || 750));
    timer.unref?.();
  };

  let watcher;
  try {
    watcher = watchImpl(root, { recursive: true, persistent: false }, schedule);
  } catch (recursiveError) {
    try {
      watcher = watchImpl(root, { recursive: false, persistent: false }, schedule);
    } catch (fallbackError) {
      onError(fallbackError, recursiveError);
      return { close() { closed = true; } };
    }
  }
  watcher.on?.("error", onError);

  return {
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      watcher.close();
    },
  };
}
