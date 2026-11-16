import { setStatus } from "./app-status.ts";
import { logActivity } from "./activity-log.ts";
import { friendlyError } from "./utils.ts";

let activeListener: ((event: Event) => void) | null = null;

/**
 * Safety net for async actions started as `void action()` without a catch.
 * A rejection there otherwise shows nothing. Shows the friendly message in the
 * status line and the activity log. The browser console still gets the raw
 * error, because the event is not cancelled.
 *
 * Idempotent: a second call adds no listener. Returns a teardown that removes it.
 */
export function installAsyncErrorReporter(): () => void {
  if (activeListener === null) {
    const listener = (event: Event): void => {
      const reason = "reason" in event ? event.reason : undefined;
      const message = `Unexpected error: ${friendlyError(reason)}`;
      // setStatus throws when #status is missing. Skip it so the listener
      // stays quiet, and still record the entry in the activity log.
      if (document.getElementById("status")) setStatus(message);
      logActivity(message, "error");
    };
    activeListener = listener;
    window.addEventListener("unhandledrejection", listener);
  }
  return removeAsyncErrorReporter;
}

function removeAsyncErrorReporter(): void {
  if (activeListener === null) return;
  window.removeEventListener("unhandledrejection", activeListener);
  activeListener = null;
}
