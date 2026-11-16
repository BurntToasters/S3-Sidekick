import { friendlyError } from "./utils.ts";
import { logActivity } from "./activity-log.ts";
import { setStatus } from "./app-status.ts";

/**
 * Surface an action that rejects after its click handler already returned.
 * Shared by the app event wiring and the connection switcher so both report
 * failures the same way. Imports only leaf modules to avoid an import cycle.
 */
export function reportAsyncActionFailure(label: string, err: unknown): void {
  const message = `${label} failed: ${friendlyError(err)}`;
  setStatus(message);
  logActivity(message, "error");
}
