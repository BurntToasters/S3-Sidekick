import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Failure modes, written before the implementation:
 * - A form draft with a missing host, port, username, password, key, or
 *   passphrase is accepted and sent to the backend.
 * - A saved host key is applied to another host or another user, so the pin
 *   for one server silently covers a different server.
 * - A bookmark without a pin falls back to a stale last-connection pin, so a
 *   reset does not stick.
 * - A connection-lost error from an S3 session, or a non-lost error from an
 *   SFTP session, is handled as a lost SFTP connection.
 * - An SFTP saved record is loaded through the S3 input setter.
 * - An SFTP endpoint is passed to the S3 connect path from the switcher.
 */

const showToastMock = vi.fn();
const showConfirmMock = vi.fn<(...args: unknown[]) => Promise<boolean>>();
const requestCloseInspectorMock = vi.fn<() => Promise<boolean>>(
  async () => true,
);
const disconnectMock = vi.fn<(id?: string) => Promise<boolean>>(
  async () => true,
);
const connectMock = vi.fn(async () => "");
const connectSftpMock = vi.fn();
const saveSftpConnectionMock = vi.fn(async () => undefined);
const setStatusMock = vi.fn();

vi.mock("../toast.ts", () => ({ showToast: showToastMock }));

vi.mock("../dialogs.ts", () => ({
  showConfirm: showConfirmMock,
  showPrompt: vi.fn(async () => null),
}));

vi.mock("../inspector.ts", () => ({
  refreshInspectorEmptySummary: vi.fn(),
  requestCloseInspector: requestCloseInspectorMock,
  setInspectorOpen: vi.fn(),
}));

vi.mock("../activity-log.ts", () => ({ logActivity: vi.fn() }));

vi.mock("../app-status.ts", () => ({ setStatus: setStatusMock }));

vi.mock("../app-layout.ts", () => ({
  clearFilterInputDebounce: vi.fn(),
  setSidebarOpen: vi.fn(),
}));

vi.mock("../settings.ts", () => ({ openSettingsModal: vi.fn() }));

vi.mock("../security.ts", () => ({ handleLockNow: vi.fn() }));

vi.mock("../transfers.ts", () => ({
  recoverPendingTransfers: vi.fn(async () => undefined),
  resumeRecoveredTransfersAfterConnect: vi.fn(async () => undefined),
}));

vi.mock("../browser.ts", () => ({
  renderBucketList: vi.fn(),
  renderBucketListSkeleton: vi.fn(),
  selectBucket: vi.fn(async () => undefined),
  reportNavFailure: vi.fn(),
  showEmptyState: vi.fn(),
  clearSelection: vi.fn(),
  clearNavHistory: vi.fn(),
  readLastBucket: vi.fn(() => null),
  navigateToFolder: vi.fn(async () => undefined),
}));

vi.mock("../connection.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../connection.ts")>();
  return {
    ...actual,
    connect: connectMock,
    connectSftp: connectSftpMock,
    disconnect: disconnectMock,
    refreshBuckets: vi.fn(async () => undefined),
    saveConnection: vi.fn(async () => undefined),
    saveSftpConnection: saveSftpConnectionMock,
    currentConnectionGeneration: () => 1,
    finishConnecting: vi.fn(),
  };
});

function renderFixture(): void {
  document.body.innerHTML = `
    <span id="connection-status"></span>
    <button id="connect-btn">Connect</button>
    <div id="main-layout" style="display:none"></div>
    <div id="connection-screen" style="display:flex"></div>
    <ul id="conn-saved-list"></ul>
    <input type="radio" name="conn-protocol" id="conn-protocol-s3" value="s3" checked />
    <input type="radio" name="conn-protocol" id="conn-protocol-sftp" value="sftp" />
    <input id="conn-endpoint" />
    <input id="conn-region" />
    <input id="conn-access-key" />
    <input id="conn-secret-key" />
    <input id="conn-sftp-host" />
    <input id="conn-sftp-port" value="22" />
    <input id="conn-sftp-username" />
    <select id="conn-sftp-auth"><option value="password">Password</option><option value="key">Private key</option><option value="keyboard-interactive">Keyboard-interactive</option></select>
    <input id="conn-sftp-password" type="password" />
    <input id="conn-sftp-passphrase" type="password" />
    <span id="conn-sftp-key-status"></span>
    <button type="button" id="conn-sftp-reset-hostkey" hidden>Reset host key</button>
    <button id="bookmark-save-btn"></button>
    <p id="conn-form-error" hidden></p>
    <span id="status"></span>
  `;
}

const sftpEndpoint = "sftp://files.example.test:22";

describe("sftpRowLabel", () => {
  it("shows user@host:port for a canonical SFTP endpoint", async () => {
    const app = await import("../app-connection.ts");
    expect(app.sftpRowLabel(sftpEndpoint, "demo")).toBe(
      "demo@files.example.test:22",
    );
    expect(app.sftpRowLabel("sftp://[::1]:2222", "ops")).toBe("ops@[::1]:2222");
  });

  it("falls back to the raw endpoint when it does not parse", async () => {
    const app = await import("../app-connection.ts");
    expect(app.sftpRowLabel("sftp://no-port", "demo")).toBe(
      "demo@sftp://no-port",
    );
  });
});

describe("validateSftpDraft", () => {
  const valid = {
    host: "files.example.test",
    port: "22",
    username: "demo",
    auth: "password" as const,
    password: "secret",
    keyChosen: false,
    keyEncrypted: null,
    passphrase: "",
  };

  it("accepts a complete password draft", async () => {
    const app = await import("../app-connection.ts");
    expect(app.validateSftpDraft(valid)).toBeNull();
  });

  it("names the field for each missing or invalid value", async () => {
    const app = await import("../app-connection.ts");
    expect(app.validateSftpDraft({ ...valid, host: "" })?.fieldId).toBe(
      "conn-sftp-host",
    );
    expect(app.validateSftpDraft({ ...valid, host: "bad host" })?.fieldId).toBe(
      "conn-sftp-host",
    );
    expect(app.validateSftpDraft({ ...valid, port: "" })?.fieldId).toBe(
      "conn-sftp-port",
    );
    expect(app.validateSftpDraft({ ...valid, port: "022" })?.fieldId).toBe(
      "conn-sftp-port",
    );
    expect(app.validateSftpDraft({ ...valid, port: "70000" })?.fieldId).toBe(
      "conn-sftp-port",
    );
    expect(app.validateSftpDraft({ ...valid, username: " " })?.fieldId).toBe(
      "conn-sftp-username",
    );
    expect(app.validateSftpDraft({ ...valid, password: "" })?.fieldId).toBe(
      "conn-sftp-password",
    );
  });

  it("requires a key for key auth and a passphrase only for an encrypted key", async () => {
    const app = await import("../app-connection.ts");
    const key = { ...valid, auth: "key" as const, password: "" };
    expect(app.validateSftpDraft(key)?.fieldId).toBe("conn-sftp-key-choose");
    expect(
      app.validateSftpDraft({ ...key, keyChosen: true, keyEncrypted: false }),
    ).toBeNull();
    expect(
      app.validateSftpDraft({ ...key, keyChosen: true, keyEncrypted: true })
        ?.fieldId,
    ).toBe("conn-sftp-passphrase");
    expect(
      app.validateSftpDraft({
        ...key,
        keyChosen: true,
        keyEncrypted: true,
        passphrase: "pw",
      }),
    ).toBeNull();
    // A saved key of unknown encryption is left to the backend to report.
    expect(
      app.validateSftpDraft({ ...key, keyChosen: true, keyEncrypted: null }),
    ).toBeNull();
  });

  it("needs no secret for keyboard-interactive auth", async () => {
    const app = await import("../app-connection.ts");
    expect(
      app.validateSftpDraft({
        ...valid,
        auth: "keyboard-interactive",
        password: "",
      }),
    ).toBeNull();
  });
});

describe("pinnedHostKeyFor", () => {
  const pinned = {
    name: "Files",
    endpoint: sftpEndpoint,
    region: "",
    access_key: "demo",
    secret_key: "",
    protocol: "sftp" as const,
    sftp: { auth: "password" as const, host_key: "ssh-ed25519 PINNED" },
  };

  it("uses the matching bookmark pin", async () => {
    const app = await import("../app-connection.ts");
    expect(app.pinnedHostKeyFor([pinned], null, sftpEndpoint, "demo")).toBe(
      "ssh-ed25519 PINNED",
    );
  });

  it("treats a bookmark without a pin as authoritative over the last-connection pin", async () => {
    const app = await import("../app-connection.ts");
    const unpinned = { ...pinned, sftp: { auth: "password" as const } };
    expect(
      app.pinnedHostKeyFor(
        [unpinned],
        {
          endpoint: sftpEndpoint,
          username: "demo",
          hostKey: "ssh-ed25519 OLD",
        },
        sftpEndpoint,
        "demo",
      ),
    ).toBeUndefined();
  });

  it("falls back to the last-connection pin only for the same host and user", async () => {
    const app = await import("../app-connection.ts");
    const last = {
      endpoint: sftpEndpoint,
      username: "demo",
      hostKey: "ssh-ed25519 LAST",
    };
    expect(app.pinnedHostKeyFor([], last, sftpEndpoint, "demo")).toBe(
      "ssh-ed25519 LAST",
    );
    expect(
      app.pinnedHostKeyFor([], last, sftpEndpoint, "other"),
    ).toBeUndefined();
    expect(
      app.pinnedHostKeyFor([], last, "sftp://other.test:22", "demo"),
    ).toBeUndefined();
  });

  it("never applies an S3 bookmark's endpoint and key as a pin", async () => {
    const app = await import("../app-connection.ts");
    const s3 = {
      name: "S3",
      endpoint: sftpEndpoint,
      region: "us-east-1",
      access_key: "demo",
      secret_key: "k",
    };
    expect(
      app.pinnedHostKeyFor([s3], null, sftpEndpoint, "demo"),
    ).toBeUndefined();
  });
});

describe("host key and encrypted-key error recognition", () => {
  it("recognizes the backend's encrypted key refusal", async () => {
    const app = await import("../app-connection.ts");
    expect(
      app.isEncryptedKeyError(
        "The private key is encrypted. Enter its passphrase.",
      ),
    ).toBe(true);
    expect(app.isEncryptedKeyError("Authentication failed.")).toBe(false);
  });
});

describe("handleSftpConnectionLost", () => {
  beforeEach(async () => {
    vi.resetModules();
    showToastMock.mockReset();
    showConfirmMock.mockReset().mockResolvedValue(true);
    requestCloseInspectorMock.mockReset().mockResolvedValue(true);
    disconnectMock.mockReset().mockImplementation(async () => {
      const { state } = await import("../state.ts");
      state.connected = false;
      state.connectionId = "";
      return true;
    });
    setStatusMock.mockReset();
    renderFixture();
    const { state } = await import("../state.ts");
    state.connected = true;
    state.connecting = false;
    state.connectionId = "sftp-session-1";
    state.endpoint = sftpEndpoint;
    state.protocol = "sftp";
  });

  it("disconnects an SFTP session that the server dropped and says so", async () => {
    const app = await import("../app-connection.ts");
    const handled = await app.handleSftpConnectionLost(
      new Error("SFTP connection lost: keepalive timed out"),
    );

    expect(handled).toBe(true);
    expect(disconnectMock).toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledWith(
      "The SFTP connection was lost. Reconnect to continue.",
      expect.objectContaining({ type: "warning" }),
    );
  });

  it("ignores an error that is not a lost connection", async () => {
    const app = await import("../app-connection.ts");
    expect(
      await app.handleSftpConnectionLost(new Error("Permission denied")),
    ).toBe(false);
    expect(disconnectMock).not.toHaveBeenCalled();
  });

  it("ignores a lost-connection message while an S3 session is live", async () => {
    const { state } = await import("../state.ts");
    state.protocol = "s3";
    const app = await import("../app-connection.ts");
    expect(await app.handleSftpConnectionLost("SFTP connection lost")).toBe(
      false,
    );
    expect(disconnectMock).not.toHaveBeenCalled();
  });
});

describe("loading a saved SFTP record into the form", () => {
  beforeEach(async () => {
    vi.resetModules();
    renderFixture();
    const { state } = await import("../state.ts");
    state.connected = false;
  });

  it("switches to SFTP, fills host, port, user, and password, and never touches the S3 fields", async () => {
    const app = await import("../app-connection.ts");
    app.loadSftpSavedConnectionIntoForm({
      endpoint: sftpEndpoint,
      region: "",
      access_key: "demo",
      secret_key: "stored-password",
      protocol: "sftp",
      sftp: { auth: "password", host_key: "ssh-ed25519 PINNED" },
    });

    expect(
      (document.getElementById("conn-protocol-sftp") as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (document.getElementById("conn-sftp-host") as HTMLInputElement).value,
    ).toBe("files.example.test");
    expect(
      (document.getElementById("conn-sftp-port") as HTMLInputElement).value,
    ).toBe("22");
    expect(
      (document.getElementById("conn-sftp-username") as HTMLInputElement).value,
    ).toBe("demo");
    expect(
      (document.getElementById("conn-sftp-password") as HTMLInputElement).value,
    ).toBe("stored-password");
    expect(
      (document.getElementById("conn-endpoint") as HTMLInputElement).value,
    ).toBe("");
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("refuses to switch an SFTP endpoint into the S3 connect path", async () => {
    const app = await import("../app-connection.ts");
    await app.switchToBookmark(
      "Files",
      sftpEndpoint,
      "",
      "demo",
      "stored-password",
    );
    expect(connectMock).not.toHaveBeenCalled();
    expect(connectSftpMock).not.toHaveBeenCalled();
    expect(setStatusMock).toHaveBeenCalledWith(
      expect.stringContaining("SFTP"),
      expect.anything(),
    );
  });
});

/** Fill the SFTP part of the form the way a user would. */
function fillSftpFixture(
  auth: "password" | "key" | "keyboard-interactive" = "password",
): void {
  (document.getElementById("conn-protocol-sftp") as HTMLInputElement).checked =
    true;
  (document.getElementById("conn-sftp-host") as HTMLInputElement).value =
    "files.example.test";
  (document.getElementById("conn-sftp-port") as HTMLInputElement).value = "22";
  (document.getElementById("conn-sftp-username") as HTMLInputElement).value =
    "demo";
  (document.getElementById("conn-sftp-auth") as HTMLSelectElement).value = auth;
  (document.getElementById("conn-sftp-password") as HTMLInputElement).value =
    "sftp-password";
}

/** Make the mocked connectSftp publish a session the way the real one does. */
function publishSftpSession(hostKey: string): void {
  connectSftpMock.mockImplementation(async () => {
    const { state } = await import("../state.ts");
    state.connected = true;
    state.connecting = false;
    state.protocol = "sftp";
    state.connectionId = "sftp-session-1";
    state.endpoint = sftpEndpoint;
    state.sftpHomePath = "/home/demo";
    return {
      endpoint: sftpEndpoint,
      hostKey,
      hostKeyFingerprint: "SHA256:fp",
      homePath: "/home/demo",
    };
  });
}

describe("SFTP connect from the form", () => {
  beforeEach(async () => {
    vi.resetModules();
    showToastMock.mockReset();
    setStatusMock.mockReset();
    connectSftpMock.mockReset();
    saveSftpConnectionMock.mockReset().mockResolvedValue(undefined);
    renderFixture();
    const { state } = await import("../state.ts");
    state.connected = false;
    state.connecting = false;
    state.connectionId = "";
    state.protocol = "s3";
    state.sftpHomePath = "";
  });

  it("connects, saves the SFTP record with the trusted host key, and pins it for the next connect", async () => {
    const hostKey = "ssh-ed25519 TRUSTED";
    publishSftpSession(hostKey);
    fillSftpFixture();
    const app = await import("../app-connection.ts");

    await app.handleConnect();

    expect(connectSftpMock).toHaveBeenCalledTimes(1);
    expect(connectSftpMock.mock.calls[0]?.[0]).toMatchObject({
      host: "files.example.test",
      port: 22,
      username: "demo",
      authMethod: "password",
      password: "sftp-password",
    });
    expect(saveSftpConnectionMock).toHaveBeenCalledWith(
      "sftp-session-1",
      expect.objectContaining({
        endpoint: sftpEndpoint,
        username: "demo",
        secret: "sftp-password",
        auth: "password",
        hostKey,
      }),
    );

    // The next connect to the same host and user presents the pin.
    app.setConnectionInputs("", "", "", "");
    fillSftpFixture();
    await app.handleConnect();
    expect(connectSftpMock.mock.calls[1]?.[0]).toMatchObject({
      pinnedHostKey: hostKey,
    });
  });

  it("refuses an invalid SFTP form before any connect", async () => {
    fillSftpFixture();
    (document.getElementById("conn-sftp-host") as HTMLInputElement).value = "";
    const app = await import("../app-connection.ts");

    await app.handleConnect();

    expect(connectSftpMock).not.toHaveBeenCalled();
    const error = document.getElementById("conn-form-error") as HTMLElement;
    expect(error.textContent).toBe("Host is required.");
    expect(
      document.getElementById("conn-sftp-host")?.getAttribute("aria-invalid"),
    ).toBe("true");
  });

  it("reports a declined host key as a cancellation, not a failure", async () => {
    connectSftpMock.mockRejectedValue(new Error("Connection cancelled"));
    fillSftpFixture();
    const app = await import("../app-connection.ts");

    await app.handleConnect();

    expect(setStatusMock).toHaveBeenCalledWith("Connection cancelled.", 5000);
    expect(
      (document.getElementById("conn-form-error") as HTMLElement).hidden,
    ).toBe(true);
    expect(saveSftpConnectionMock).not.toHaveBeenCalled();
  });

  it("shows the backend's refusal in the form error", async () => {
    connectSftpMock.mockRejectedValue(
      new Error(
        "The SSH host key for sftp://files.example.test:22 changed. The server presented SHA256:x, which does not match the saved host key. Reset the saved host key only if the change is expected.",
      ),
    );
    fillSftpFixture();
    const app = await import("../app-connection.ts");

    await app.handleConnect();

    const error = document.getElementById("conn-form-error") as HTMLElement;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("changed");
  });

  it("tests an SFTP connection and disconnects the session it made", async () => {
    publishSftpSession("ssh-ed25519 TRUSTED");
    fillSftpFixture();
    const app = await import("../app-connection.ts");

    await app.handleTestConnection();

    expect(connectSftpMock).toHaveBeenCalledTimes(1);
    expect(disconnectMock).toHaveBeenCalledWith("sftp-session-1");
    expect(saveSftpConnectionMock).not.toHaveBeenCalled();
    expect(setStatusMock).toHaveBeenCalledWith(
      "Connection test succeeded.",
      5000,
    );
  });

  it("drops the picked key and passphrase when the protocol switches", async () => {
    fillSftpFixture("key");
    const app = await import("../app-connection.ts");
    app.wireConnectionScreenExtras();
    const radioS3 = document.getElementById(
      "conn-protocol-s3",
    ) as HTMLInputElement;
    const radioSftp = document.getElementById(
      "conn-protocol-sftp",
    ) as HTMLInputElement;
    radioS3.checked = true;
    radioS3.dispatchEvent(new Event("change"));
    radioSftp.checked = true;
    radioSftp.dispatchEvent(new Event("change"));
    expect(
      (document.getElementById("conn-sftp-key-status") as HTMLElement)
        .textContent,
    ).toBe("No key chosen.");
    expect(app.currentFormProtocol()).toBe("sftp");
  });

  it("resets the saved host key only after the user confirms", async () => {
    const { getBookmarks } = await import("../bookmarks.ts");
    const { state } = await import("../state.ts");
    expect(getBookmarks()).toEqual([]);
    showConfirmMock.mockResolvedValue(false);
    fillSftpFixture();
    const app = await import("../app-connection.ts");
    app.wireConnectionScreenExtras();
    const reset = document.getElementById(
      "conn-sftp-reset-hostkey",
    ) as HTMLButtonElement;
    reset.hidden = false;

    reset.click();
    await vi.waitFor(() => expect(showConfirmMock).toHaveBeenCalled());
    expect(showConfirmMock.mock.calls[0]?.[0]).toBe("Reset host key?");
    expect(state.connected).toBe(false);
  });
});
