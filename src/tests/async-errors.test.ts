// Failure modes covered (unhandled promise rejections in the webview):
// - An async action rejects with an Error and nothing reaches the status line
//   or the activity log.
// - A rejection carrying raw backend text ("AccessDenied: ...") reaches the UI
//   unmapped, so the user sees developer wording instead of friendly wording.
// - The raw stack or Error prefix leaks into the status line.
// - The reporter calls preventDefault, which hides the browser console report.
// - Installing the reporter twice reports each rejection twice.
// - A teardown leaves a listener behind that reports after the reporter stopped.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setStatus: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("../app-status.ts", () => ({ setStatus: mocks.setStatus }));
vi.mock("../activity-log.ts", () => ({ logActivity: mocks.logActivity }));

import { installAsyncErrorReporter } from "../async-errors.ts";

/** Dispatch the same event shape the browser fires for an unhandled rejection. */
function fireUnhandledRejection(reason: unknown): boolean {
  const event = new Event("unhandledrejection", { cancelable: true });
  Object.defineProperty(event, "reason", { value: reason });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

const FRIENDLY_ACCESS_DENIED =
  "Access denied. Check your credentials and permissions.";

describe("async error reporter", () => {
  let stop: (() => void) | undefined;

  beforeEach(() => {
    document.body.innerHTML = `<span id="status"></span>`;
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  it("shows a friendly status line and one activity entry for an Error", () => {
    stop = installAsyncErrorReporter();

    fireUnhandledRejection(new Error("AccessDenied: bucket policy"));

    expect(mocks.setStatus).toHaveBeenCalledTimes(1);
    expect(mocks.setStatus).toHaveBeenCalledWith(
      `Unexpected error: ${FRIENDLY_ACCESS_DENIED}`,
    );
    expect(mocks.logActivity).toHaveBeenCalledTimes(1);
    expect(mocks.logActivity).toHaveBeenCalledWith(
      `Unexpected error: ${FRIENDLY_ACCESS_DENIED}`,
      "error",
    );
  });

  it("maps a raw backend-style string rejection to friendly wording", () => {
    stop = installAsyncErrorReporter();

    fireUnhandledRejection("AccessDenied: no permission to list objects");

    expect(mocks.setStatus).toHaveBeenCalledWith(
      `Unexpected error: ${FRIENDLY_ACCESS_DENIED}`,
    );
    expect(mocks.logActivity).toHaveBeenCalledWith(
      `Unexpected error: ${FRIENDLY_ACCESS_DENIED}`,
      "error",
    );
  });

  it("does not put the raw error prefix or stack into the UI", () => {
    stop = installAsyncErrorReporter();
    const error = new Error("probe failure");
    error.stack = "Error: probe failure\n    at secretFunction (app.js:1:1)";

    fireUnhandledRejection(error);

    const [statusText] = mocks.setStatus.mock.calls[0] as [string];
    const [logText] = mocks.logActivity.mock.calls[0] as [string];
    for (const text of [statusText, logText]) {
      expect(text).toBe("Unexpected error: probe failure");
      expect(text).not.toContain("secretFunction");
      expect(text).not.toContain("app.js");
    }
  });

  it("keeps the browser console report by not calling preventDefault", () => {
    stop = installAsyncErrorReporter();

    const prevented = fireUnhandledRejection(new Error("probe failure"));

    expect(prevented).toBe(false);
  });

  it("reports once when installed twice", () => {
    stop = installAsyncErrorReporter();
    installAsyncErrorReporter();

    fireUnhandledRejection(new Error("probe failure"));

    expect(mocks.setStatus).toHaveBeenCalledTimes(1);
    expect(mocks.logActivity).toHaveBeenCalledTimes(1);
  });

  it("still logs without throwing when the status element is missing", () => {
    document.body.innerHTML = "";
    stop = installAsyncErrorReporter();

    expect(() =>
      fireUnhandledRejection(new Error("probe failure")),
    ).not.toThrow();

    expect(mocks.setStatus).not.toHaveBeenCalled();
    expect(mocks.logActivity).toHaveBeenCalledWith(
      "Unexpected error: probe failure",
      "error",
    );
  });

  it("reports an event that carries no reason without throwing", () => {
    stop = installAsyncErrorReporter();

    window.dispatchEvent(new Event("unhandledrejection"));

    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.stringMatching(/^Unexpected error: /),
      "error",
    );
  });

  it("treats a second teardown call as a no-op", () => {
    const teardown = installAsyncErrorReporter();
    teardown();

    expect(() => teardown()).not.toThrow();
  });

  it("stops reporting after the teardown runs", () => {
    stop = installAsyncErrorReporter();
    stop();
    stop = undefined;

    fireUnhandledRejection(new Error("probe failure"));

    expect(mocks.setStatus).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it("reports again after a teardown and a fresh install", () => {
    const first = installAsyncErrorReporter();
    first();

    stop = installAsyncErrorReporter();
    fireUnhandledRejection(new Error("probe failure"));

    expect(mocks.logActivity).toHaveBeenCalledTimes(1);
  });
});
