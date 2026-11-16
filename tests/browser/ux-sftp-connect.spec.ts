import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { commandCalls, countOf, saveArtifact } from "./helpers";
import {
  installLayoutTauriMock,
  MOCK_SFTP_CHANGED_FINGERPRINT,
  MOCK_SFTP_CHANGED_KEY,
  MOCK_SFTP_SERVER_FINGERPRINT,
  MOCK_SFTP_SERVER_KEY,
  readMockCallLog,
  type MockCall,
  type MockSftpOptions,
} from "./tauri-layout";

/**
 * SFTP connection experience on the connect screen, driven through the mock
 * SFTP server in tauri-layout.ts.
 *
 * Failure modes, written before the implementation:
 * - S3-only fields stay visible for SFTP, or SFTP fields stay hidden for S3.
 * - A picked key's text reaches the DOM, or survives a protocol switch.
 * - An unknown host key connects without the user's trust decision.
 * - Cancelling the trust dialog leaves the app connected, or leaves the
 *   backend attempt open (no sftp_connect_cancel).
 * - Keyboard-interactive server text is rendered as HTML, or an echo-off
 *   answer is shown in clear text.
 * - An encrypted key's passphrase field stays disabled, or an unencrypted key
 *   enables it.
 * - A pinned key that no longer matches is offered for trust instead of refused.
 * - A saved host key is not passed as pinnedHostKey, so a pinned server is
 *   asked to be trusted again.
 * - An SFTP record reaches the S3 connect command.
 * - Saving drops `protocol: "sftp"` or the host key.
 * - Reset host key clears the pin without confirmation, or does not clear it.
 * - Test connection leaves a session open.
 * - Cancel before the server answers leaves the backend attempt running, or
 *   a late step still opens the trust dialog.
 * - S3 connect stops working.
 * - Test connection shows "Trust and connect", or Copy fingerprint copies
 *   nothing, or a passphrase or Show toggle does not flip the field.
 * - An unlabeled keyboard-interactive prompt has no accessible name.
 * - A refused password leaves focus on Connect, not the password field.
 * - A disabled protocol switch looks the same as an enabled one.
 */

const SUITE = "ux-sftp-connect";
const HOST = "files.example.test";
const ENDPOINT = `sftp://${HOST}:22`;
const PASSWORD = "sftp-password";

async function openConnectScreen(
  page: Page,
  sftp: MockSftpOptions,
  extra: Parameters<typeof installLayoutTauriMock>[1] = {},
): Promise<void> {
  await installLayoutTauriMock(page, { ...extra, sftp });
  await page.goto("/");
  await expect(page.locator("#connection-screen")).toBeVisible();
}

async function chooseProtocol(page: Page, name: "S3" | "SFTP"): Promise<void> {
  await page.getByRole("radio", { name, exact: true }).check();
}

async function fillSftpPassword(page: Page): Promise<void> {
  await chooseProtocol(page, "SFTP");
  await page.locator("#conn-sftp-host").fill(HOST);
  await page.locator("#conn-sftp-username").fill("demo");
  await page.locator("#conn-sftp-password").fill(PASSWORD);
}

function trustDialog(page: Page) {
  return page.locator("#sftp-trust-overlay");
}

function promptDialog(page: Page) {
  return page.locator("#sftp-prompt-overlay");
}

/** Remote paths of every `sftp_list_dir` call, in the order they were made. */
function listedPaths(calls: MockCall[]): string[] {
  return commandCalls(calls, "sftp_list_dir").map((call) =>
    String((call.args as Record<string, unknown>).path),
  );
}

async function expectConnectedToHome(page: Page): Promise<void> {
  await expect(page.locator("#main-layout")).toBeVisible();
  await expect(page.locator("#object-tbody")).toContainText("notes.txt");
  // The root listing also has `etc`; the home folder must be the one shown.
  await expect(page.locator("#object-tbody")).not.toContainText("etc");
}

/** Remove secret material from the IPC log before it is written as an artifact. */
function redactSftpSecrets(calls: MockCall[]): MockCall[] {
  const secretKey = /private|passphrase|key_text|password|secret|token|bytes/i;
  const redact = (value: unknown, key = ""): unknown => {
    if (secretKey.test(key)) return "<redacted>";
    if (key === "json" && typeof value === "string") {
      try {
        return JSON.stringify(redact(JSON.parse(value)));
      } catch {
        return "<redacted>";
      }
    }
    if (Array.isArray(value)) return value.map((entry) => redact(entry));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([child, childValue]) => [
          child,
          redact(childValue, child),
        ]),
      );
    }
    return value;
  };
  return calls.map((call) => ({
    command: call.command,
    args: redact(call.args),
  }));
}

async function saveSftpArtifact(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const calls = await readMockCallLog(page);
  await saveArtifact(page, testInfo, SUITE, name, redactSftpSecrets(calls));
}

/** Parsed JSON payload of the last save call for `command`. */
async function lastSavedJson(
  page: Page,
  command: "save_connection" | "save_bookmarks",
): Promise<Record<string, unknown> | Array<Record<string, unknown>>> {
  const calls = commandCalls(await readMockCallLog(page), command);
  const last = calls[calls.length - 1];
  expect(last, `${command} was called`).toBeDefined();
  const args = last!.args as Record<string, unknown>;
  return JSON.parse(String(args.json ?? "null")) as
    Record<string, unknown> | Array<Record<string, unknown>>;
}

/** The last saved SFTP connection, as `load_connection` returns it at startup. */
const lastConnectionRecord = {
  endpoint: ENDPOINT,
  region: "",
  access_key: "demo",
  secret_key: PASSWORD,
  protocol: "sftp",
  sftp: { auth: "password", host_key: MOCK_SFTP_SERVER_KEY },
};

const pinnedBookmark = {
  name: "Files",
  endpoint: ENDPOINT,
  region: "",
  access_key: "demo",
  secret_key: PASSWORD,
  protocol: "sftp",
  sftp: { auth: "password", host_key: MOCK_SFTP_SERVER_KEY },
};

test.describe("SFTP connection form", () => {
  test("the protocol switch shows SFTP fields and hides S3 fields", async ({
    page,
  }, testInfo) => {
    await openConnectScreen(page, { hostKey: "unknown" });

    // S3 is the default and keeps its fields.
    await expect(
      page.getByRole("radio", { name: "S3", exact: true }),
    ).toBeChecked();
    await expect(page.locator("#conn-endpoint")).toBeVisible();
    await expect(page.locator("#conn-access-key")).toBeVisible();
    await expect(page.locator("#conn-sftp-host")).toBeHidden();

    await chooseProtocol(page, "SFTP");
    await expect(
      page.getByRole("textbox", { name: "Host", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Username", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "Authentication", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#conn-endpoint")).toBeHidden();
    await expect(page.locator("#conn-access-key")).toBeHidden();
    await expect(page.locator("#conn-secret-key")).toBeHidden();
    await expect(page.locator("#conn-provider-preset")).toBeHidden();
    await expect(page.locator("#conn-sftp-host")).toBeVisible();
    await expect(page.locator("#conn-sftp-port")).toHaveValue("22");
    await expect(page.locator("#conn-sftp-username")).toBeVisible();

    // Password auth is the default method.
    await expect(page.locator("#conn-sftp-auth")).toHaveValue("password");
    await expect(page.locator("#conn-sftp-password")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Choose key file…" }),
    ).toBeHidden();

    await page.locator("#conn-sftp-auth").selectOption("key");
    await expect(page.locator("#conn-sftp-password")).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Choose key file…" }),
    ).toBeVisible();
    await expect(page.locator("#conn-sftp-passphrase")).toBeVisible();

    await page
      .getByLabel("Authentication", { exact: true })
      .selectOption("keyboard-interactive");
    await expect(page.locator("#conn-sftp-password")).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Choose key file…" }),
    ).toBeHidden();
    await expect(page.locator("#conn-sftp-passphrase")).toBeHidden();

    await page.locator("#conn-sftp-auth").selectOption("password");
    await page.locator("#conn-sftp-host").fill(HOST);
    await page.locator("#conn-sftp-username").fill("demo");
    await saveSftpArtifact(page, testInfo, "sftp-form");

    // Switching back restores the S3 fields and hides the SFTP ones.
    await chooseProtocol(page, "S3");
    await expect(page.locator("#conn-endpoint")).toBeVisible();
    await expect(page.locator("#conn-sftp-host")).toBeHidden();
  });

  test("an unknown host key asks to trust it, then the connection lands in the home folder", async ({
    page,
  }, testInfo) => {
    await openConnectScreen(page, {
      hostKey: "unknown",
      homePath: "/home/demo",
    });
    await fillSftpPassword(page);
    await page.locator("#connect-btn").click();

    await expect(trustDialog(page)).toHaveClass(/active/);
    await expect(trustDialog(page).getByRole("heading")).toHaveText(
      "Trust this server?",
    );
    await expect(page.locator("#sftp-trust-fingerprint")).toHaveText(
      MOCK_SFTP_SERVER_FINGERPRINT,
    );
    await expect(trustDialog(page)).toContainText("ssh-ed25519");
    await expect(trustDialog(page)).toContainText(ENDPOINT);
    await saveSftpArtifact(page, testInfo, "host-key-trust");

    await page.getByRole("button", { name: "Trust and connect" }).click();
    await expect(trustDialog(page)).not.toHaveClass(/active/);
    await expectConnectedToHome(page);

    const calls = await readMockCallLog(page);
    const connect = commandCalls(calls, "sftp_connect")[0]!;
    expect(connect.args).toMatchObject({
      host: HOST,
      port: 22,
      username: "demo",
      authMethod: "password",
    });
    expect((connect.args as Record<string, unknown>).pinnedHostKey).toBeNull();
    expect(countOf(calls, "sftp_connect_continue")).toBe(1);
    expect(countOf(calls, "connect")).toBe(0);
    // Connecting never lists "/" first: the only listing is the home folder.
    expect(listedPaths(calls)).toEqual(["/home/demo"]);
  });

  test("cancelling the trust dialog leaves the app disconnected and cancels the attempt", async ({
    page,
  }) => {
    await openConnectScreen(page, { hostKey: "unknown" });
    await fillSftpPassword(page);
    await page.locator("#connect-btn").click();

    await expect(trustDialog(page)).toHaveClass(/active/);
    await trustDialog(page).getByRole("button", { name: "Cancel" }).click();

    await expect(trustDialog(page)).not.toHaveClass(/active/);
    await expect(page.locator("#connection-screen")).toBeVisible();
    await expect(page.locator("#main-layout")).toBeHidden();
    await expect(page.locator("#connect-btn")).toHaveText("Connect");

    const calls = await readMockCallLog(page);
    expect(countOf(calls, "sftp_connect_cancel")).toBe(1);
    expect(countOf(calls, "sftp_connect_continue")).toBe(0);
  });

  test("Escape in the trust dialog is the same as Cancel", async ({ page }) => {
    await openConnectScreen(page, { hostKey: "unknown" });
    await fillSftpPassword(page);
    await page.locator("#connect-btn").click();

    await expect(trustDialog(page)).toHaveClass(/active/);
    await page.keyboard.press("Escape");
    await expect(trustDialog(page)).not.toHaveClass(/active/);
    await expect(page.locator("#main-layout")).toBeHidden();
    expect(countOf(await readMockCallLog(page), "sftp_connect_cancel")).toBe(1);
  });

  test("Cancel while the server has not answered reaches the backend and opens no dialog", async ({
    page,
  }, testInfo) => {
    await openConnectScreen(page, { hostKey: "unknown", holdConnect: true });
    await fillSftpPassword(page);
    await page.locator("#connect-btn").click();
    await expect(page.locator("#connect-btn")).toHaveText(/Cancel/);
    await expect
      .poll(async () => countOf(await readMockCallLog(page), "sftp_connect"))
      .toBe(1);

    await page.locator("#connect-btn").click();

    await expect(page.locator("#connect-btn")).toHaveText("Connect");
    await expect(page.locator("#main-layout")).toBeHidden();
    await expect(trustDialog(page)).not.toHaveClass(/active/);
    await expect
      .poll(async () =>
        countOf(await readMockCallLog(page), "sftp_connect_cancel_pending"),
      )
      .toBe(1);
    const calls = await readMockCallLog(page);
    expect(countOf(calls, "sftp_connect_continue")).toBe(0);
    await saveSftpArtifact(page, testInfo, "cancel-before-first-step");
  });

  test("a keyboard-interactive prompt with a hidden input succeeds", async ({
    page,
  }, testInfo) => {
    await openConnectScreen(page, {
      hostKey: "unknown",
      auth: "keyboard-interactive",
      keyboardInteractive: {
        name: "<b>Bold</b> sign-in",
        instructions: "Enter the code from your authenticator app.",
        prompts: [{ text: "Verification code: ", echo: false }],
        answers: ["654321"],
      },
    });
    await chooseProtocol(page, "SFTP");
    await page.locator("#conn-sftp-host").fill(HOST);
    await page.locator("#conn-sftp-username").fill("demo");
    await page
      .getByLabel("Authentication", { exact: true })
      .selectOption("keyboard-interactive");
    await page.locator("#connect-btn").click();

    // The host key is trusted first; the server's challenge comes after that.
    await trustDialog(page)
      .getByRole("button", { name: "Trust and connect" })
      .click();
    await expect(promptDialog(page)).toHaveClass(/active/);
    await expect(page.locator("#sftp-prompt-name")).toHaveText(
      "<b>Bold</b> sign-in",
    );
    await expect(page.locator("#sftp-prompt-overlay b")).toHaveCount(0);
    await expect(page.locator("#sftp-prompt-instructions")).toHaveText(
      "Enter the code from your authenticator app.",
    );
    const answer = page.locator("#sftp-prompt-fields input");
    await expect(answer).toHaveCount(1);
    await expect(answer).toHaveAttribute("type", "password");
    await expect(page.locator("#sftp-prompt-fields label")).toHaveText(
      "Verification code:",
    );
    await saveSftpArtifact(page, testInfo, "keyboard-interactive-prompt");

    await answer.fill("654321");
    await promptDialog(page).getByRole("button", { name: "Continue" }).click();
    await expect(promptDialog(page)).not.toHaveClass(/active/);
    await expect(answer).toHaveCount(0);
    await expectConnectedToHome(page);

    const continueCall = commandCalls(
      await readMockCallLog(page),
      "sftp_connect_continue",
    ).at(-1)!;
    expect((continueCall.args as Record<string, unknown>).responses).toEqual([
      "654321",
    ]);
  });

  test("an encrypted key enables the passphrase field and the key text stays out of the DOM", async ({
    page,
  }) => {
    const keyText =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nPlaywrightOnlyFakeKeyMaterial\n-----END OPENSSH PRIVATE KEY-----";
    await openConnectScreen(page, {
      hostKey: "pinned-ok",
      privateKey: {
        file_name: "id_ed25519",
        algorithm: "ssh-ed25519",
        encrypted: true,
        key_text: keyText,
      },
    });
    await chooseProtocol(page, "SFTP");
    await page.locator("#conn-sftp-auth").selectOption("key");
    await expect(page.locator("#conn-sftp-passphrase")).toBeDisabled();

    await page.getByRole("button", { name: "Choose key file…" }).click();
    await expect(page.locator("#conn-sftp-key-status")).toContainText(
      "id_ed25519",
    );
    await expect(page.locator("#conn-sftp-key-status")).toContainText(
      "ssh-ed25519",
    );
    await expect(page.locator("#conn-sftp-passphrase")).toBeEnabled();
    expect(await page.content()).not.toContain("PlaywrightOnlyFakeKeyMaterial");

    // Switching protocol drops the picked key: the next SFTP view has none.
    await chooseProtocol(page, "S3");
    await chooseProtocol(page, "SFTP");
    await page.locator("#conn-sftp-auth").selectOption("key");
    await expect(page.locator("#conn-sftp-key-status")).not.toContainText(
      "id_ed25519",
    );
    await expect(page.locator("#conn-sftp-passphrase")).toBeDisabled();

    await page.getByRole("button", { name: "Choose key file…" }).click();
    await page.locator("#conn-sftp-passphrase").fill("key-passphrase");
    await page.locator("#conn-sftp-host").fill(HOST);
    await page.locator("#conn-sftp-username").fill("demo");
    await page.locator("#connect-btn").click();
    await trustDialog(page)
      .getByRole("button", { name: "Trust and connect" })
      .click();

    await expectConnectedToHome(page);
    const connect = commandCalls(
      await readMockCallLog(page),
      "sftp_connect",
    )[0]!;
    expect(connect.args).toMatchObject({
      authMethod: "key",
      passphrase: "key-passphrase",
    });
  });

  test("an unencrypted key keeps the passphrase field disabled", async ({
    page,
  }) => {
    await openConnectScreen(page, {
      hostKey: "pinned-ok",
      privateKey: {
        file_name: "deploy_key",
        algorithm: "ssh-ed25519",
        encrypted: false,
        key_text:
          "-----BEGIN OPENSSH PRIVATE KEY-----\nplain\n-----END OPENSSH PRIVATE KEY-----",
      },
    });
    await chooseProtocol(page, "SFTP");
    await page.locator("#conn-sftp-auth").selectOption("key");
    await page.getByRole("button", { name: "Choose key file…" }).click();
    await expect(page.locator("#conn-sftp-key-status")).toContainText(
      "deploy_key",
    );
    await expect(page.locator("#conn-sftp-passphrase")).toBeDisabled();
  });

  test("a changed pinned key is refused and does not offer to trust it", async ({
    page,
  }) => {
    await openConnectScreen(
      page,
      { hostKey: "changed" },
      { bookmarks: [pinnedBookmark] },
    );
    await page
      .locator("#conn-saved-list .bookmark-item__connect")
      .first()
      .click();

    await expect(page.locator("#conn-form-error")).toContainText("changed");
    await expect(page.locator("#conn-form-error")).toContainText(
      "Reset the saved host key only if the change is expected.",
    );
    await expect(trustDialog(page)).not.toHaveClass(/active/);
    await expect(page.locator("#main-layout")).toBeHidden();

    const calls = await readMockCallLog(page);
    const connect = commandCalls(calls, "sftp_connect")[0]!;
    expect((connect.args as Record<string, unknown>).pinnedHostKey).toBe(
      MOCK_SFTP_SERVER_KEY,
    );
    expect(countOf(calls, "sftp_connect_continue")).toBe(0);
    await expect(page.locator("#conn-sftp-reset-hostkey")).toBeVisible();
  });

  test("an SFTP bookmark connects with its pinned key and no trust dialog", async ({
    page,
  }) => {
    await openConnectScreen(
      page,
      { hostKey: "pinned-ok" },
      { bookmarks: [pinnedBookmark] },
    );
    const row = page.locator("#conn-saved-list .bookmark-item--connection");
    await expect(row).toContainText("SFTP");
    await expect(row).toContainText("demo@files.example.test:22");
    await row.locator(".bookmark-item__connect").click();

    await expectConnectedToHome(page);
    await expect(page.locator("#conn-switcher-host")).toHaveText(
      "demo@files.example.test:22",
    );
    await expect(trustDialog(page)).not.toHaveClass(/active/);
    const calls = await readMockCallLog(page);
    const connect = commandCalls(calls, "sftp_connect")[0]!;
    expect((connect.args as Record<string, unknown>).pinnedHostKey).toBe(
      MOCK_SFTP_SERVER_KEY,
    );
    // An SFTP record must never reach the S3 connect command.
    expect(countOf(calls, "connect")).toBe(0);
  });

  test("a saved password entry with no password asks for it, then offers to store it", async ({
    page,
  }) => {
    await openConnectScreen(
      page,
      { hostKey: "pinned-ok" },
      { bookmarks: [{ ...pinnedBookmark, secret_key: "" }] },
    );
    await page
      .locator("#conn-saved-list .bookmark-item__connect")
      .first()
      .click();

    await expect(page.locator("#dialog-overlay")).toHaveClass(/active/);
    await expect(page.locator("#dialog-title")).toHaveText("Password needed");
    await page.locator("#dialog-input").fill(PASSWORD);
    await page.locator("#dialog-ok").click();

    await expectConnectedToHome(page);
    // The entered password is offered for storage with the saved entry.
    await expect(page.locator("#dialog-title")).toHaveText("Store secret key?");
    await page.locator("#dialog-ok").click();
    const saved = (await lastSavedJson(page, "save_bookmarks")) as Array<
      Record<string, unknown>
    >;
    expect(saved[0]).toMatchObject({ protocol: "sftp", secret_key: PASSWORD });
  });

  test("an encrypted saved key asks for its passphrase when the server refuses it", async ({
    page,
  }) => {
    const keyText =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nPlaywrightOnlyFakeKeyMaterial\n-----END OPENSSH PRIVATE KEY-----";
    await openConnectScreen(
      page,
      {
        hostKey: "pinned-ok",
        privateKey: {
          file_name: "id_ed25519",
          algorithm: "ssh-ed25519",
          encrypted: true,
          key_text: keyText,
        },
      },
      {
        bookmarks: [
          {
            name: "Keyed",
            endpoint: ENDPOINT,
            region: "",
            access_key: "demo",
            secret_key: "",
            protocol: "sftp",
            sftp: {
              auth: "key",
              private_key: keyText,
              host_key: MOCK_SFTP_SERVER_KEY,
            },
          },
        ],
      },
    );
    await page
      .locator("#conn-saved-list .bookmark-item__connect")
      .first()
      .click();

    // The first attempt sends no passphrase and the server says the key is encrypted.
    await expect(page.locator("#dialog-title")).toHaveText("Passphrase needed");
    await page.locator("#dialog-input").fill("key-passphrase");
    await page.locator("#dialog-ok").click();

    await expectConnectedToHome(page);
    const attempts = commandCalls(await readMockCallLog(page), "sftp_connect");
    expect(attempts).toHaveLength(2);
    expect(
      (attempts[0]!.args as Record<string, unknown>).passphrase,
    ).toBeNull();
    expect((attempts[1]!.args as Record<string, unknown>).passphrase).toBe(
      "key-passphrase",
    );
    await page.locator("#dialog-ok").click();
    const saved = (await lastSavedJson(page, "save_bookmarks")) as Array<
      Record<string, unknown>
    >;
    expect(saved[0]).toMatchObject({
      name: "Keyed",
      secret_key: "key-passphrase",
    });
  });

  test("saving an SFTP connection stores protocol sftp and the trusted host key", async ({
    page,
  }, testInfo) => {
    await openConnectScreen(page, { hostKey: "unknown" });
    await fillSftpPassword(page);
    await page.locator("#conn-name").fill("Files");
    await page.locator("#connect-btn").click();
    await page.getByRole("button", { name: "Trust and connect" }).click();
    await expectConnectedToHome(page);

    // The last connection is saved as an SFTP record with the host key.
    const lastConnection = (await lastSavedJson(
      page,
      "save_connection",
    )) as Record<string, unknown>;
    expect(lastConnection).toMatchObject({
      protocol: "sftp",
      endpoint: ENDPOINT,
      access_key: "demo",
      sftp: { auth: "password", host_key: MOCK_SFTP_SERVER_KEY },
    });

    // Then save it to the saved connections list from the form.
    await page.locator("#conn-switcher-btn").click();
    await page.locator("#conn-switcher-disconnect").click();
    await expect(page.locator("#connection-screen")).toBeVisible();
    await page.locator("#bookmark-save-btn").click();
    await expect(page.getByText('Saved connection "Files".')).toBeVisible();

    const saved = (await lastSavedJson(page, "save_bookmarks")) as Array<
      Record<string, unknown>
    >;
    expect(saved[0]).toMatchObject({
      name: "Files",
      protocol: "sftp",
      endpoint: ENDPOINT,
      access_key: "demo",
      sftp: { auth: "password", host_key: MOCK_SFTP_SERVER_KEY },
    });
    await saveSftpArtifact(page, testInfo, "saved-sftp-connection");
  });

  test("Reset host key asks first and clears the pin only after confirmation", async ({
    page,
  }) => {
    await openConnectScreen(
      page,
      { hostKey: "pinned-ok" },
      { bookmarks: [pinnedBookmark] },
    );
    await page
      .locator(
        '#conn-saved-list .bookmark__menu[aria-label="More actions for Files"]',
      )
      .click();
    await page.getByRole("menuitem", { name: "Edit Files" }).click();

    await expect(
      page.getByRole("radio", { name: "SFTP", exact: true }),
    ).toBeDisabled();
    await page.locator("#conn-sftp-reset-hostkey").click();
    await expect(page.locator("#dialog-overlay")).toHaveClass(/active/);
    await expect(page.locator("#dialog-title")).toHaveText("Reset host key?");
    await expect(page.locator("#dialog-message")).toContainText(
      "man-in-the-middle",
    );
    await page.locator("#dialog-cancel").click();
    expect(countOf(await readMockCallLog(page), "save_bookmarks")).toBe(0);

    await page.locator("#conn-sftp-reset-hostkey").click();
    await page.locator("#dialog-ok").click();
    await expect(page.locator("#conn-sftp-reset-hostkey")).toBeHidden();
    const saved = (await lastSavedJson(page, "save_bookmarks")) as Array<
      Record<string, unknown>
    >;
    const sftp = saved[0]!.sftp as Record<string, unknown>;
    expect(sftp.host_key).toBeUndefined();
    expect(sftp.auth).toBe("password");
  });

  test("resetting the saved last connection's host key makes the next connect ask to trust it", async ({
    page,
  }, testInfo) => {
    await openConnectScreen(
      page,
      { hostKey: "changed" },
      { savedConnection: lastConnectionRecord },
    );
    await expect(page.locator("#conn-sftp-host")).toHaveValue(HOST);
    await page.locator("#connect-btn").click();

    // The saved pin is sent, so the changed key is refused without a trust dialog.
    await expect(page.locator("#conn-form-error")).toContainText("changed");
    await expect(trustDialog(page)).not.toHaveClass(/active/);
    await expect(page.locator("#conn-sftp-reset-hostkey")).toBeVisible();

    await page.locator("#conn-sftp-reset-hostkey").click();
    await page.locator("#dialog-ok").click();
    await expect(page.locator("#conn-sftp-reset-hostkey")).toBeHidden();

    // The next connect from this form sends no pin and asks about the new key.
    await page.locator("#connect-btn").click();
    await expect(trustDialog(page)).toHaveClass(/active/);
    await expect(page.locator("#sftp-trust-fingerprint")).toHaveText(
      MOCK_SFTP_CHANGED_FINGERPRINT,
    );
    await trustDialog(page)
      .getByRole("button", { name: "Trust and connect" })
      .click();
    await expectConnectedToHome(page);
    await saveSftpArtifact(page, testInfo, "reset-last-connection");

    const attempts = commandCalls(await readMockCallLog(page), "sftp_connect");
    expect(attempts).toHaveLength(2);
    expect((attempts[0]!.args as Record<string, unknown>).pinnedHostKey).toBe(
      MOCK_SFTP_SERVER_KEY,
    );
    expect(
      (attempts[1]!.args as Record<string, unknown>).pinnedHostKey,
    ).toBeNull();
    // The newly trusted key is what the saved connection now carries.
    expect(await lastSavedJson(page, "save_connection")).toMatchObject({
      protocol: "sftp",
      sftp: { host_key: MOCK_SFTP_CHANGED_KEY },
    });
  });

  test("resetting a saved SFTP entry's host key writes the newly trusted key back to that entry", async ({
    page,
  }) => {
    await openConnectScreen(
      page,
      { hostKey: "changed" },
      { bookmarks: [pinnedBookmark] },
    );
    await page
      .locator("#conn-saved-list .bookmark-item__connect")
      .first()
      .click();
    await expect(page.locator("#conn-form-error")).toContainText("changed");

    await page.locator("#conn-sftp-reset-hostkey").click();
    await page.locator("#dialog-ok").click();
    await page.locator("#connect-btn").click();
    await trustDialog(page)
      .getByRole("button", { name: "Trust and connect" })
      .click();
    await expectConnectedToHome(page);

    const saved = (await lastSavedJson(page, "save_bookmarks")) as Array<
      Record<string, unknown>
    >;
    expect(saved[0]).toMatchObject({
      name: "Files",
      sftp: { host_key: MOCK_SFTP_CHANGED_KEY },
    });
  });

  test("Test connection connects, disconnects, and keeps no session", async ({
    page,
  }) => {
    await openConnectScreen(page, { hostKey: "unknown" });
    await fillSftpPassword(page);
    await page.locator("#conn-test-btn").click();
    await page.getByRole("button", { name: "Trust and test" }).click();

    await expect(page.getByText("Connection test succeeded.")).toBeVisible();
    await expect(page.locator("#connection-screen")).toBeVisible();
    await expect(page.locator("#main-layout")).toBeHidden();
    const calls = await readMockCallLog(page);
    expect(countOf(calls, "disconnect")).toBeGreaterThanOrEqual(1);
  });

  test("S3 connect still works with the protocol on S3", async ({
    page,
  }, testInfo) => {
    await installLayoutTauriMock(page);
    await page.goto("/");
    await expect(
      page.getByRole("radio", { name: "S3", exact: true }),
    ).toBeChecked();
    await page.locator("#conn-endpoint").fill("https://layout-test.invalid");
    await page.locator("#conn-access-key").fill("layout-access-key");
    await page.locator("#conn-secret-key").fill("layout-secret-key");
    await page.locator("#connect-btn").click();

    await expect(page.locator("#main-layout")).toBeVisible();
    const calls = await readMockCallLog(page);
    expect(commandCalls(calls, "connect")[0]?.args).toMatchObject({
      endpoint: "https://layout-test.invalid",
    });
    expect(countOf(calls, "sftp_connect")).toBe(0);
    await saveArtifact(
      page,
      testInfo,
      SUITE,
      "s3-smoke",
      redactSftpSecrets(calls),
    );
  });
});

test.describe("SFTP connect dialog and form polish", () => {
  test("Test connection asks to trust the host with Trust and test", async ({
    page,
  }) => {
    await openConnectScreen(page, { hostKey: "unknown" });
    await fillSftpPassword(page);
    await page.locator("#conn-test-btn").click();

    await expect(trustDialog(page)).toHaveClass(/active/);
    await expect(
      trustDialog(page).getByRole("button", { name: "Trust and test" }),
    ).toBeVisible();
    await expect(
      trustDialog(page).getByRole("button", { name: "Trust and connect" }),
    ).toHaveCount(0);
    await trustDialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Connection test cancelled.")).toBeVisible();
  });

  test("Copy fingerprint copies the fingerprint shown in the trust dialog", async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (text: string) => {
            (window as unknown as { __copied?: string }).__copied = text;
            return Promise.resolve();
          },
        },
      });
    });
    await openConnectScreen(page, { hostKey: "unknown" });
    await fillSftpPassword(page);
    await page.locator("#connect-btn").click();
    await expect(trustDialog(page)).toHaveClass(/active/);

    await trustDialog(page)
      .getByRole("button", { name: "Copy fingerprint" })
      .click();
    await expect(page.locator("#sftp-trust-copy-status")).toHaveText(
      "Fingerprint copied.",
    );
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __copied?: string }).__copied,
        ),
      )
      .toBe(MOCK_SFTP_SERVER_FINGERPRINT);
    await expect(trustDialog(page)).toHaveClass(/active/);
    await saveSftpArtifact(page, testInfo, "trust-copy-fingerprint");
    await trustDialog(page).getByRole("button", { name: "Cancel" }).click();
  });

  test("the passphrase Show toggle flips the field between masked and plain", async ({
    page,
  }) => {
    await openConnectScreen(page, {
      hostKey: "pinned-ok",
      privateKey: {
        file_name: "id_ed25519",
        algorithm: "ssh-ed25519",
        encrypted: true,
        key_text:
          "-----BEGIN OPENSSH PRIVATE KEY-----\nPlaywrightOnlyFakeKeyMaterial\n-----END OPENSSH PRIVATE KEY-----",
      },
    });
    await chooseProtocol(page, "SFTP");
    await page.locator("#conn-sftp-auth").selectOption("key");
    await page.getByRole("button", { name: "Choose key file…" }).click();
    await expect(page.locator("#conn-sftp-passphrase")).toBeEnabled();

    const toggle = page.locator("#sftp-passphrase-toggle");
    const passphrase = page.locator("#conn-sftp-passphrase");
    await expect(passphrase).toHaveAttribute("type", "password");
    await toggle.click();
    await expect(passphrase).toHaveAttribute("type", "text");
    await expect(toggle).toHaveText("Hide");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect(passphrase).toHaveAttribute("type", "password");
    await expect(toggle).toHaveText("Show");
  });

  test("an unlabeled keyboard-interactive prompt is named Response", async ({
    page,
  }) => {
    await openConnectScreen(page, {
      hostKey: "unknown",
      auth: "keyboard-interactive",
      keyboardInteractive: {
        instructions: "Answer the question.",
        prompts: [{ text: "   ", echo: true }],
        answers: ["blue"],
      },
    });
    await chooseProtocol(page, "SFTP");
    await page.locator("#conn-sftp-host").fill(HOST);
    await page.locator("#conn-sftp-username").fill("demo");
    await page
      .getByLabel("Authentication", { exact: true })
      .selectOption("keyboard-interactive");
    await page.locator("#connect-btn").click();
    await trustDialog(page)
      .getByRole("button", { name: "Trust and connect" })
      .click();

    await expect(promptDialog(page)).toHaveClass(/active/);
    const answer = promptDialog(page).getByRole("textbox", {
      name: "Response",
    });
    await expect(answer).toBeVisible();
    await answer.fill("blue");
    await promptDialog(page).getByRole("button", { name: "Continue" }).click();
    await expect(page.locator("#main-layout")).toBeVisible();
  });

  test("a refused password moves focus to the password field", async ({
    page,
  }) => {
    await openConnectScreen(page, {
      hostKey: "unknown",
      auth: "wrong-password",
    });
    await fillSftpPassword(page);
    await page.locator("#conn-sftp-password").fill("wrong-password");
    await page.locator("#connect-btn").click();
    await trustDialog(page)
      .getByRole("button", { name: "Trust and connect" })
      .click();
    await expect(page.locator("#conn-form-error")).toContainText(
      "Authentication failed.",
    );
    await expect(page.locator("#conn-sftp-password")).toBeFocused();
  });

  test("the disabled protocol switch reads as disabled while a connect runs", async ({
    page,
  }) => {
    await openConnectScreen(page, { hostKey: "unknown", holdConnect: true });
    await fillSftpPassword(page);
    await page.locator("#connect-btn").click();

    const s3Option = page.locator(".conn-protocol__option", {
      hasText: "S3",
    });
    await expect(
      page.getByRole("radio", { name: "S3", exact: true }),
    ).toBeDisabled();
    await expect(s3Option).toHaveCSS("cursor", "not-allowed");
    // The unchecked option uses the muted text token (#66666f in light mode).
    await expect(s3Option.locator("span")).toHaveCSS(
      "color",
      "rgb(102, 102, 111)",
    );
    await page.locator("#connect-btn").click();
    await expect(page.locator("#connect-btn")).toBeEnabled();
  });
});
