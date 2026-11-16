import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SftpHostKeyUnknownStep, SftpPromptStep } from "../sftp.ts";

/**
 * Failure modes, written before the implementation:
 * - A trust dialog dismissed by Escape, the close button, or a click outside
 *   resolves true, so the host key is trusted without the user choosing to.
 * - The endpoint, key type, or fingerprint is inserted as HTML.
 * - A keyboard-interactive name or instruction from the server is rendered as
 *   HTML instead of text.
 * - An answer to an echo-off prompt is shown in clear text.
 * - Answers stay in the inputs after the dialog resolves.
 * - A pending dialog outlives the attempt that opened it, so the connect never
 *   reaches its cancel path.
 * - Test connection reads "Trust and connect", or Connect reads "Trust and test".
 * - Copy fingerprint copies a different string, confirms before the copy
 *   finishes, or reports success when the clipboard refuses.
 * - A keyboard-interactive prompt with no text has no accessible name.
 */

const trustStep: SftpHostKeyUnknownStep = {
  step: "host_key_unknown",
  attempt_id: "attempt-1",
  key_type: "ssh-ed25519",
  fingerprint_sha256: "SHA256:fingerprint-under-test",
  host_key: "ssh-ed25519 AAAATestKey",
};

function promptStep(overrides: Partial<SftpPromptStep> = {}): SftpPromptStep {
  return {
    step: "prompt",
    attempt_id: "attempt-2",
    name: "Server sign-in",
    instructions: "Enter the code.",
    prompts: [{ text: "Code: ", echo: false }],
    ...overrides,
  };
}

/** The same ids and structure as the overlays in src/index.html. */
function mountDialogs(): void {
  document.body.innerHTML = `
    <div id="sftp-trust-overlay" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="sftp-trust-title">
      <div class="modal">
        <h2 id="sftp-trust-title">Trust this server?</h2>
        <button type="button" id="sftp-trust-close" aria-label="Close">x</button>
        <p id="sftp-trust-endpoint"></p>
        <dd id="sftp-trust-key-type"></dd>
        <code id="sftp-trust-fingerprint"></code>
        <button type="button" id="sftp-trust-copy">Copy fingerprint</button>
        <span id="sftp-trust-copy-status" role="status"></span>
        <button type="button" id="sftp-trust-cancel">Cancel</button>
        <button type="button" id="sftp-trust-confirm">Trust and connect</button>
      </div>
    </div>
    <div id="sftp-prompt-overlay" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="sftp-prompt-title">
      <div class="modal">
        <h2 id="sftp-prompt-title">Server sign-in</h2>
        <button type="button" id="sftp-prompt-close" aria-label="Close">x</button>
        <p id="sftp-prompt-name"></p>
        <p id="sftp-prompt-instructions"></p>
        <form id="sftp-prompt-form">
          <div id="sftp-prompt-fields"></div>
          <button type="button" id="sftp-prompt-cancel">Cancel</button>
          <button type="submit" id="sftp-prompt-continue">Continue</button>
        </form>
      </div>
    </div>
  `;
}

function overlayActive(id: string): boolean {
  return document.getElementById(id)?.classList.contains("active") ?? false;
}

function press(key: string): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

function click(id: string): void {
  document.getElementById(id)?.click();
}

describe("SFTP host key trust dialog", () => {
  beforeEach(() => {
    mountDialogs();
  });

  afterEach(async () => {
    const dialogs = await import("../sftp-connect-dialogs.ts");
    dialogs.closeSftpConnectDialogs();
    document.body.innerHTML = "";
  });

  it("shows the endpoint, key type, and fingerprint, and resolves true on Trust", async () => {
    const dialogs = await import("../sftp-connect-dialogs.ts");
    const pending = dialogs.promptSftpHostKeyTrust(
      "sftp://files.example.test:22",
      trustStep,
    );

    expect(overlayActive("sftp-trust-overlay")).toBe(true);
    expect(
      document.getElementById("sftp-trust-endpoint")?.textContent,
    ).toContain("sftp://files.example.test:22");
    expect(document.getElementById("sftp-trust-key-type")?.textContent).toBe(
      "ssh-ed25519",
    );
    expect(document.getElementById("sftp-trust-fingerprint")?.textContent).toBe(
      "SHA256:fingerprint-under-test",
    );

    click("sftp-trust-confirm");
    await expect(pending).resolves.toBe(true);
    expect(overlayActive("sftp-trust-overlay")).toBe(false);
  });

  it("treats Cancel, the close button, and Escape as a refusal", async () => {
    const dialogs = await import("../sftp-connect-dialogs.ts");

    const cancelled = dialogs.promptSftpHostKeyTrust(
      "sftp://a.test:22",
      trustStep,
    );
    click("sftp-trust-cancel");
    await expect(cancelled).resolves.toBe(false);

    const closed = dialogs.promptSftpHostKeyTrust(
      "sftp://a.test:22",
      trustStep,
    );
    click("sftp-trust-close");
    await expect(closed).resolves.toBe(false);

    const escaped = dialogs.promptSftpHostKeyTrust(
      "sftp://a.test:22",
      trustStep,
    );
    press("Escape");
    await expect(escaped).resolves.toBe(false);
    expect(overlayActive("sftp-trust-overlay")).toBe(false);
  });

  it("renders server-supplied text as text, never as HTML", async () => {
    const dialogs = await import("../sftp-connect-dialogs.ts");
    const pending = dialogs.promptSftpHostKeyTrust("<img src=x>", {
      ...trustStep,
      key_type: "<b>key</b>",
      fingerprint_sha256: "<i>SHA256:x</i>",
    });

    expect(document.querySelectorAll("#sftp-trust-overlay img")).toHaveLength(
      0,
    );
    expect(document.querySelectorAll("#sftp-trust-overlay b")).toHaveLength(0);
    expect(document.getElementById("sftp-trust-fingerprint")?.textContent).toBe(
      "<i>SHA256:x</i>",
    );
    click("sftp-trust-cancel");
    await pending;
  });
});

describe("SFTP keyboard-interactive dialog", () => {
  beforeEach(() => {
    mountDialogs();
  });

  afterEach(async () => {
    const dialogs = await import("../sftp-connect-dialogs.ts");
    dialogs.closeSftpConnectDialogs();
    document.body.innerHTML = "";
  });

  it("shows name and instructions as text and masks echo-off answers", async () => {
    const dialogs = await import("../sftp-connect-dialogs.ts");
    const pending = dialogs.promptSftpKeyboardInteractive(
      promptStep({
        name: "<b>Bold</b> name",
        instructions: "<i>Instructions</i>",
        prompts: [
          { text: "Code: ", echo: false },
          { text: "Username hint: ", echo: true },
        ],
      }),
    );

    expect(overlayActive("sftp-prompt-overlay")).toBe(true);
    expect(document.getElementById("sftp-prompt-name")?.textContent).toBe(
      "<b>Bold</b> name",
    );
    expect(
      document.getElementById("sftp-prompt-instructions")?.textContent,
    ).toBe("<i>Instructions</i>");
    expect(document.querySelectorAll("#sftp-prompt-overlay b")).toHaveLength(0);
    const inputs = document.querySelectorAll<HTMLInputElement>(
      "#sftp-prompt-fields input",
    );
    expect(inputs).toHaveLength(2);
    expect(inputs[0].type).toBe("password");
    expect(inputs[1].type).toBe("text");
    expect(
      document.querySelector("#sftp-prompt-fields label")?.textContent,
    ).toBe("Code:");
    click("sftp-prompt-cancel");
    await pending;
  });

  it("resolves the answers in prompt order and clears the inputs", async () => {
    const dialogs = await import("../sftp-connect-dialogs.ts");
    const pending = dialogs.promptSftpKeyboardInteractive(
      promptStep({
        prompts: [
          { text: "Code: ", echo: false },
          { text: "Name: ", echo: true },
        ],
      }),
    );
    const inputs = document.querySelectorAll<HTMLInputElement>(
      "#sftp-prompt-fields input",
    );
    inputs[0].value = "123456";
    inputs[1].value = "ops";

    click("sftp-prompt-continue");
    await expect(pending).resolves.toEqual(["123456", "ops"]);
    expect(overlayActive("sftp-prompt-overlay")).toBe(false);
    expect(document.querySelectorAll("#sftp-prompt-fields input")).toHaveLength(
      0,
    );
  });

  it("resolves null for Cancel, the close button, and Escape", async () => {
    const dialogs = await import("../sftp-connect-dialogs.ts");

    const cancelled = dialogs.promptSftpKeyboardInteractive(promptStep());
    click("sftp-prompt-cancel");
    await expect(cancelled).resolves.toBeNull();

    const closed = dialogs.promptSftpKeyboardInteractive(promptStep());
    click("sftp-prompt-close");
    await expect(closed).resolves.toBeNull();

    const escaped = dialogs.promptSftpKeyboardInteractive(promptStep());
    press("Escape");
    await expect(escaped).resolves.toBeNull();
  });

  it("submits on Enter and resolves an empty list when there are no prompts", async () => {
    const dialogs = await import("../sftp-connect-dialogs.ts");
    const pending = dialogs.promptSftpKeyboardInteractive(
      promptStep({ prompts: [] }),
    );
    const form = document.getElementById("sftp-prompt-form") as HTMLFormElement;
    form.dispatchEvent(
      new Event("submit", { cancelable: true, bubbles: true }),
    );
    await expect(pending).resolves.toEqual([]);
  });
});

describe("closeSftpConnectDialogs", () => {
  beforeEach(() => {
    mountDialogs();
  });

  it("resolves an open trust dialog as refused and hides it", async () => {
    const dialogs = await import("../sftp-connect-dialogs.ts");
    const pending = dialogs.promptSftpHostKeyTrust(
      "sftp://a.test:22",
      trustStep,
    );
    dialogs.closeSftpConnectDialogs();
    await expect(pending).resolves.toBe(false);
    expect(overlayActive("sftp-trust-overlay")).toBe(false);
  });

  it("resolves an open prompt as cancelled and clears its answers", async () => {
    const dialogs = await import("../sftp-connect-dialogs.ts");
    const pending = dialogs.promptSftpKeyboardInteractive(promptStep());
    const input = document.querySelector<HTMLInputElement>(
      "#sftp-prompt-fields input",
    );
    if (input) input.value = "typed";
    dialogs.closeSftpConnectDialogs();
    await expect(pending).resolves.toBeNull();
    expect(overlayActive("sftp-prompt-overlay")).toBe(false);
    expect(document.querySelectorAll("#sftp-prompt-fields input")).toHaveLength(
      0,
    );
  });

  it("is a no-op when nothing is open", async () => {
    const dialogs = await import("../sftp-connect-dialogs.ts");
    expect(() => dialogs.closeSftpConnectDialogs()).not.toThrow();
  });
});

describe("SFTP connect dialog labels", () => {
  it("names the trust button for the action that opened it", async () => {
    const dialogs = await import("../sftp-connect-dialogs.ts");
    expect(dialogs.sftpTrustConfirmLabel("connect")).toBe("Trust and connect");
    expect(dialogs.sftpTrustConfirmLabel("test")).toBe("Trust and test");
  });

  it("gives an unlabeled keyboard-interactive prompt the name Response", async () => {
    const dialogs = await import("../sftp-connect-dialogs.ts");
    expect(dialogs.sftpPromptLabel("")).toBe("Response");
    expect(dialogs.sftpPromptLabel("   ")).toBe("Response");
    expect(dialogs.sftpPromptLabel("  Code: ")).toBe("Code:");
  });
});

describe("SFTP trust dialog actions", () => {
  beforeEach(() => {
    mountDialogs();
  });

  afterEach(async () => {
    const dialogs = await import("../sftp-connect-dialogs.ts");
    dialogs.closeSftpConnectDialogs();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("reads Trust and test when the dialog was opened from Test connection", async () => {
    const dialogs = await import("../sftp-connect-dialogs.ts");
    const pending = dialogs.promptSftpHostKeyTrust(
      "sftp://a.test:22",
      trustStep,
      "test",
    );
    expect(document.getElementById("sftp-trust-confirm")?.textContent).toBe(
      "Trust and test",
    );
    click("sftp-trust-cancel");
    await pending;
  });

  it("reads Trust and connect for a connect by default", async () => {
    const dialogs = await import("../sftp-connect-dialogs.ts");
    const pending = dialogs.promptSftpHostKeyTrust(
      "sftp://a.test:22",
      trustStep,
    );
    expect(document.getElementById("sftp-trust-confirm")?.textContent).toBe(
      "Trust and connect",
    );
    click("sftp-trust-cancel");
    await pending;
  });

  it("copies the shown fingerprint and confirms the copy", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const dialogs = await import("../sftp-connect-dialogs.ts");
    const pending = dialogs.promptSftpHostKeyTrust(
      "sftp://a.test:22",
      trustStep,
    );
    click("sftp-trust-copy");
    await vi.waitFor(() =>
      expect(
        document.getElementById("sftp-trust-copy-status")?.textContent,
      ).toBe("Fingerprint copied."),
    );
    expect(writeText).toHaveBeenCalledWith("SHA256:fingerprint-under-test");
    expect(overlayActive("sftp-trust-overlay")).toBe(true);
    click("sftp-trust-cancel");
    await pending;
  });

  it("says the copy failed when the clipboard refuses, and does not confirm", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: vi.fn(async () => {
          throw new Error("denied");
        }),
      },
      configurable: true,
    });
    const dialogs = await import("../sftp-connect-dialogs.ts");
    const pending = dialogs.promptSftpHostKeyTrust(
      "sftp://a.test:22",
      trustStep,
    );
    click("sftp-trust-copy");
    await vi.waitFor(() =>
      expect(
        document.getElementById("sftp-trust-copy-status")?.textContent,
      ).toBe("Could not copy the fingerprint."),
    );
    expect(overlayActive("sftp-trust-overlay")).toBe(true);
    click("sftp-trust-cancel");
    await pending;
  });
});

describe("SFTP keyboard-interactive prompt labels", () => {
  beforeEach(() => {
    mountDialogs();
  });

  afterEach(async () => {
    const dialogs = await import("../sftp-connect-dialogs.ts");
    dialogs.closeSftpConnectDialogs();
    document.body.innerHTML = "";
  });

  it("labels an empty prompt Response, so the input has an accessible name", async () => {
    const dialogs = await import("../sftp-connect-dialogs.ts");
    const pending = dialogs.promptSftpKeyboardInteractive(
      promptStep({ prompts: [{ text: "", echo: true }] }),
    );
    const input = document.querySelector<HTMLInputElement>(
      "#sftp-prompt-fields input",
    );
    expect(input?.labels?.[0]?.textContent).toBe("Response");
    dialogs.closeSftpConnectDialogs();
    await pending;
  });
});
