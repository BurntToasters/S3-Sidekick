/**
 * SFTP transfers through the transfer queue, driven by the mock SFTP server in
 * tauri-layout.ts. The native pickers, held transfers and the create-only race
 * are all answered by the mock, so every assertion reads the IPC log.
 *
 * Failure-mode inventory, written before the implementation:
 * - An SFTP upload goes to an S3 command, or carries S3-only arguments
 *   (bucket, key, content type, part size, checksum flag).
 * - A folder upload writes into remote folders that do not exist yet, or
 *   creates them after the files that need them.
 * - A download sizes itself with head_object, or drops the checkpoint id and
 *   recovery session, so a paused download restarts from byte zero.
 * - Pausing a running download and resuming it mints a different checkpoint
 *   id, or the resumed attempt reports the expected cancel as a failure.
 * - A create-only upload refused with "already exists" fails the row instead
 *   of asking the user, or Replace retries without overwrite: true.
 * - A folder download queues a symlink, a name that is not UTF-8, or a
 *   subfolder it cannot create, and says nothing about the entries it skipped.
 * - A lost SFTP connection marks the row failed, retries it in place, or does
 *   not tell the user to reconnect.
 * - A recovered S3 row runs against an SFTP session, or an SFTP row runs
 *   against an S3 session, even when the connection identity happens to match.
 * - An SFTP row shows a checksum or verified state, or runs a size probe
 *   that the SFTP backend does not provide.
 */
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { commandCalls, countOf, saveArtifact } from "./helpers";
import {
  connectMockListing,
  createSftpPathAfterNextExists,
  installLayoutTauriMock,
  readMockCallLog,
  releaseMockSftpTransfers,
  type LayoutMockOptions,
  type MockCall,
  type MockSftpEntry,
  type MockSftpOptions,
  type MockSftpTransfers,
} from "./tauri-layout";

const SUITE = "ux-sftp-transfers";
const HOST = "files.example.test";
const HOME = "/home/demo";
const PASSWORD = "sftp-password";
/** U+FFFD, the replacement character the native side writes for a raw name. */
const LOSSY_NAME = "bad�name.txt";
const RECOVERY_SESSION = "a".repeat(64);

function seedFiles(): MockSftpEntry[] {
  return [
    { path: HOME, kind: "dir", owner: "demo", group: "demo" },
    {
      path: `${HOME}/notes.txt`,
      text: "Meeting notes\nFirst line of the seeded notes file.",
      mtime: 1_700_000_000,
      permissions: 0o644,
      owner: "demo",
      group: "demo",
    },
    { path: `${HOME}/bundle`, kind: "dir", owner: "demo", group: "demo" },
    {
      path: `${HOME}/bundle/a.txt`,
      text: "Alpha",
      owner: "demo",
      group: "demo",
    },
    {
      path: `${HOME}/bundle/link`,
      kind: "symlink",
      owner: "demo",
      group: "demo",
    },
    {
      path: `${HOME}/bundle/${LOSSY_NAME}`,
      text: "Stored under a name the server sent as raw bytes.",
      owner: "demo",
      group: "demo",
    },
    { path: `${HOME}/bundle/sub`, kind: "dir", owner: "demo", group: "demo" },
    {
      path: `${HOME}/bundle/sub/inner.txt`,
      text: "Nested",
      owner: "demo",
      group: "demo",
    },
  ];
}

/** Server with create-only support, the common case the transfer engine assumes. */
function sftpOptions(transfers?: MockSftpTransfers): MockSftpOptions {
  return {
    hostKey: "unknown",
    homePath: HOME,
    files: seedFiles(),
    createOnlySupported: true,
    transfers,
  };
}

async function openSftp(
  page: Page,
  sftp: MockSftpOptions,
  layout: LayoutMockOptions = {},
): Promise<void> {
  await installLayoutTauriMock(page, { ...layout, sftp });
  await page.goto("/");
  await expect(page.locator("#connection-screen")).toBeVisible();
}

async function signInSftp(page: Page): Promise<void> {
  await page.getByRole("radio", { name: "SFTP", exact: true }).check();
  await page.locator("#conn-sftp-host").fill(HOST);
  await page.locator("#conn-sftp-username").fill("demo");
  await page.locator("#conn-sftp-password").fill(PASSWORD);
  await page.locator("#connect-btn").click();
  await page.getByRole("button", { name: "Trust and connect" }).click();
  await expect(page.locator("#main-layout")).toBeVisible();
  await expect(fileRow(page, "notes.txt")).toBeVisible();
}

async function connectSftp(
  page: Page,
  transfers?: MockSftpTransfers,
): Promise<void> {
  await openSftp(page, sftpOptions(transfers));
  await signInSftp(page);
}

function rowFor(page: Page, kind: "file" | "folder", name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.locator(`.object-row--${kind}`).filter({
    has: page.locator(".object-name__text", {
      hasText: new RegExp(`(^|/)${escaped}/?$`),
    }),
  });
}

function fileRow(page: Page, name: string) {
  return rowFor(page, "file", name);
}

function folderRow(page: Page, name: string) {
  return rowFor(page, "folder", name);
}

async function selectOnly(page: Page, row: ReturnType<typeof fileRow>) {
  if (await page.locator("#batch-deselect").isVisible()) {
    await page.locator("#batch-deselect").click();
  }
  await row.locator(".row-check").check();
}

async function chooseUploadMenu(page: Page, label: string): Promise<void> {
  await page.locator("#btn-upload").click();
  await page
    .locator('.context-menu [role="menuitem"]', { hasText: label })
    .click();
}

async function showTransferList(page: Page): Promise<void> {
  const list = page.locator("#transfer-list");
  if (!(await list.isVisible())) {
    await page.locator("#transfer-toggle").click();
  }
  await expect(list).toBeVisible();
}

function dialog(page: Page) {
  return page.locator("#dialog-overlay");
}

/** Remove secret material from the IPC log before it is written as an artifact. */
function redactCalls(calls: MockCall[]): MockCall[] {
  return calls.map((call) => ({
    command: call.command,
    args: JSON.parse(
      JSON.stringify(call.args, (key, value: unknown) =>
        /password|passphrase|key_text|private|secret|token|bytes/i.test(key)
          ? "<redacted>"
          : value,
      ),
    ) as unknown,
  }));
}

async function saveSftpArtifact(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await saveArtifact(
    page,
    testInfo,
    SUITE,
    name,
    redactCalls(await readMockCallLog(page)),
  );
}

const S3_RECOVERED_DOWNLOAD = JSON.stringify({
  version: 6,
  items: [
    {
      operation: "download",
      bucket: "layout-test-bucket",
      fileName: "s3-report.csv",
      filePath: "",
      key: "reports/s3-report.csv",
      destination: "/tmp/s3-report.csv",
      size: 0,
      totalBytes: 0,
      attempt: 1,
      maxAttempts: 1,
      conflictResolution: "ask",
      resumable: false,
      completedParts: 0,
      totalParts: 0,
      // The identity matches the first SFTP session on purpose: only the
      // protocol gate can keep this S3 row off the SFTP server.
      connectionId: "mock-sftp-connection-1",
      connectionIdentity: "mock-sftp-identity-1",
    },
  ],
});

const SFTP_RECOVERED_DOWNLOAD = JSON.stringify({
  version: 6,
  items: [
    {
      operation: "download",
      bucket: HOST,
      fileName: "notes.txt",
      filePath: "",
      key: "home/demo/notes.txt",
      destination: "/Users/demo/Downloads/notes.txt",
      size: 0,
      totalBytes: 0,
      attempt: 1,
      maxAttempts: 1,
      conflictResolution: "ask",
      resumable: true,
      checkpointId: "sftp-checkpoint-notes",
      completedParts: 0,
      totalParts: 0,
      protocol: "sftp",
      // The S3 session identity, so only the protocol gate can refuse it.
      connectionId: "browser-layout-connection-1",
      connectionIdentity: "browser-layout-identity",
    },
  ],
});

test.describe("SFTP transfers", () => {
  test("uploading a file sends sftp_upload with the remote path and no S3-only arguments", async ({
    page,
  }, testInfo) => {
    await connectSftp(page, {
      uploadFiles: [{ name: "upload.txt", size: 2048 }],
    });
    await chooseUploadMenu(page, "Files");

    await expect
      .poll(async () => countOf(await readMockCallLog(page), "sftp_upload"))
      .toBe(1);
    await showTransferList(page);
    await expect(
      page.locator("#transfer-list .transfer-item").first(),
    ).toContainText("Completed");
    const calls = await readMockCallLog(page);
    const upload = commandCalls(calls, "sftp_upload")[0];
    expect(upload.args).toMatchObject({
      path: `${HOME}/upload.txt`,
      overwrite: false,
    });
    for (const key of [
      "bucket",
      "key",
      "contentType",
      "partSizeMb",
      "partConcurrency",
      "checksumVerification",
    ]) {
      expect(upload.args).not.toHaveProperty(key);
    }
    expect(countOf(calls, "upload_object")).toBe(0);
    expect(countOf(calls, "upload_object_bytes")).toBe(0);
    expect(countOf(calls, "head_object")).toBe(0);
    await saveSftpArtifact(page, testInfo, "upload-file");
  });

  test("uploading a folder creates each missing remote folder before its files", async ({
    page,
  }, testInfo) => {
    await connectSftp(page, {
      uploadFolder: {
        name: "project",
        files: [{ relativePath: "src/deep/a.ts", size: 10 }],
      },
    });
    await chooseUploadMenu(page, "Folder");

    await expect
      .poll(async () => countOf(await readMockCallLog(page), "sftp_upload"))
      .toBe(1);
    const calls = await readMockCallLog(page);
    const remote = calls
      .filter((call) => call.command.startsWith("sftp_"))
      .map((call) => call.command);
    const creates = commandCalls(calls, "sftp_create_dir").map(
      (call) => (call.args as { path: string }).path,
    );
    expect(creates).toEqual(
      expect.arrayContaining([`${HOME}/src`, `${HOME}/src/deep`]),
    );
    expect(creates.indexOf(`${HOME}/src/deep`)).toBeLessThan(
      remote.indexOf("sftp_upload"),
    );
    expect(commandCalls(calls, "sftp_upload")[0].args).toMatchObject({
      path: `${HOME}/src/deep/a.ts`,
    });
    await saveSftpArtifact(page, testInfo, "upload-folder");
  });

  test("downloading a file sends sftp_download with a checkpoint id and recovery session", async ({
    page,
  }, testInfo) => {
    // An empty transfers option turns on the local pickers.
    await connectSftp(page, {});
    await selectOnly(page, fileRow(page, "notes.txt"));
    await page.locator("#batch-download").click();

    await expect
      .poll(async () => countOf(await readMockCallLog(page), "sftp_download"))
      .toBe(1);
    const calls = await readMockCallLog(page);
    const download = commandCalls(calls, "sftp_download")[0];
    // The save dialog already confirmed any replacement, so the write is an
    // explicit overwrite, as it is for S3 single-file downloads.
    expect(download.args).toMatchObject({
      path: `${HOME}/notes.txt`,
      overwrite: true,
      enableResume: true,
      recoverySession: RECOVERY_SESSION,
    });
    expect(
      String((download.args as { checkpointId?: string }).checkpointId),
    ).not.toBe("");
    expect(countOf(calls, "head_object")).toBe(0);
    expect(countOf(calls, "download_object")).toBe(0);
    await saveSftpArtifact(page, testInfo, "download-file");
  });

  test("pausing a running download and resuming it reuses the same checkpoint id", async ({
    page,
  }, testInfo) => {
    await connectSftp(page, { holdTransfers: true });
    await selectOnly(page, fileRow(page, "notes.txt"));
    await page.locator("#batch-download").click();
    await expect
      .poll(async () => countOf(await readMockCallLog(page), "sftp_download"))
      .toBe(1);

    await showTransferList(page);
    const row = page.locator("#transfer-list .transfer-item").first();
    await row.locator(".transfer-pause").click();
    await expect
      .poll(async () => countOf(await readMockCallLog(page), "cancel_transfer"))
      .toBe(1);
    await expect(row.locator(".transfer-pause")).toHaveAttribute(
      "title",
      /^Resume /,
    );
    await row.locator(".transfer-pause").click();

    await expect
      .poll(async () => countOf(await readMockCallLog(page), "sftp_download"))
      .toBe(2);
    const calls = await readMockCallLog(page);
    const [first, second] = commandCalls(calls, "sftp_download");
    expect((second.args as { checkpointId: string }).checkpointId).toBe(
      (first.args as { checkpointId: string }).checkpointId,
    );
    await releaseMockSftpTransfers(page);
    await expect(row).toContainText("Completed");
    await expect(row).not.toContainText("Failed");
    await saveSftpArtifact(page, testInfo, "pause-resume-download");
  });

  test("a create-only refusal on upload asks the user, and Replace retries with overwrite", async ({
    page,
  }, testInfo) => {
    await connectSftp(page, {
      uploadFiles: [{ name: "race.txt", size: 2048 }],
    });
    // Another client creates the file after the existence check passes.
    await createSftpPathAfterNextExists(page, `${HOME}/race.txt`);
    await chooseUploadMenu(page, "Files");

    await expect(dialog(page)).toHaveClass(/active/);
    await expect(page.locator("#dialog-title")).toHaveText("Transfer conflict");
    await expect(page.locator("#dialog-message")).toContainText(
      `${HOME}/race.txt already exists`,
    );
    await expect
      .poll(async () => countOf(await readMockCallLog(page), "sftp_upload"))
      .toBe(1);
    await dialog(page)
      .getByRole("button", { name: "Replace", exact: true })
      .click();

    await expect
      .poll(async () => countOf(await readMockCallLog(page), "sftp_upload"))
      .toBe(2);
    const uploads = commandCalls(await readMockCallLog(page), "sftp_upload");
    expect(
      uploads.map((call) => (call.args as { overwrite: boolean }).overwrite),
    ).toEqual([false, true]);
    await showTransferList(page);
    await expect(
      page.locator("#transfer-list .transfer-item").first(),
    ).toContainText("Completed");
    await saveSftpArtifact(page, testInfo, "create-only-conflict");
  });

  test("a folder download skips symlinks and names that are not UTF-8, and says so", async ({
    page,
  }, testInfo) => {
    // An empty transfers option turns on the local pickers.
    await connectSftp(page, {});
    await selectOnly(page, fileRow(page, "notes.txt"));
    await folderRow(page, "bundle").locator(".row-check").check();
    await page.locator("#batch-download").click();

    await expect
      .poll(async () => countOf(await readMockCallLog(page), "sftp_download"))
      .toBe(2);
    const calls = await readMockCallLog(page);
    const downloaded = commandCalls(calls, "sftp_download").map(
      (call) => (call.args as { path: string }).path,
    );
    expect(downloaded.sort()).toEqual([
      `${HOME}/bundle/a.txt`,
      `${HOME}/notes.txt`,
    ]);
    expect(
      commandCalls(calls, "sftp_list_dir").map(
        (call) => (call.args as { path: string }).path,
      ),
    ).toContain(`${HOME}/bundle`);
    const status = page.locator("#status");
    await expect(status).toContainText(/symbolic link/);
    await expect(status).toContainText(/not valid UTF-8/);
    await saveSftpArtifact(page, testInfo, "folder-download-skips");
  });

  test("a lost connection during an upload parks the row and asks for a reconnect", async ({
    page,
  }, testInfo) => {
    await connectSftp(page, {
      uploadFiles: [{ name: "lost.txt", size: 2048 }],
    });
    await page.evaluate(() => {
      (
        window as unknown as {
          __S3_SFTP_MOCK__: {
            failNext(command: string, message: string): void;
          };
        }
      ).__S3_SFTP_MOCK__.failNext(
        "sftp_upload",
        "SFTP connection lost: the server closed the session.",
      );
    });
    await chooseUploadMenu(page, "Files");

    await expect(page.locator("#toast-region")).toContainText(
      "The SFTP connection was lost. Reconnect to continue.",
    );
    const calls = await readMockCallLog(page);
    expect(countOf(calls, "sftp_upload")).toBe(1);
    expect(countOf(calls, "upload_object")).toBe(0);
    await saveSftpArtifact(page, testInfo, "connection-lost-upload");
  });

  test("an upload that leaves a file on the server says where it is", async ({
    page,
  }, testInfo) => {
    await connectSftp(page, {
      uploadFiles: [{ name: "kept.txt", size: 2048 }],
    });
    const warning = `${HOME}/kept.txt was replaced, but the previous version could not be removed and is still on the server at ${HOME}/.kept.txt.s3sk-bak-0011223344556677. Delete it once it is no longer needed.`;
    await page.evaluate((message) => {
      (
        window as unknown as {
          __S3_SFTP_MOCK__: {
            warnNext(command: string, message: string): void;
          };
        }
      ).__S3_SFTP_MOCK__.warnNext("sftp_upload", message);
    }, warning);
    await chooseUploadMenu(page, "Files");

    await expect(page.locator("#toast-region")).toContainText(
      "could not be removed and is still on the server",
    );
    await expect(page.locator("#toast-region")).toContainText(
      ".kept.txt.s3sk-bak-0011223344556677",
    );
    expect(countOf(await readMockCallLog(page), "sftp_upload")).toBe(1);
    await saveSftpArtifact(page, testInfo, "upload-cleanup-warning");
  });

  test("a recovered S3 row is not run on an SFTP session, even when the identity matches", async ({
    page,
  }, testInfo) => {
    await openSftp(page, sftpOptions(), {
      transferManifestJson: S3_RECOVERED_DOWNLOAD,
    });
    await expect(dialog(page)).toHaveClass(/active/);
    await dialog(page)
      .getByRole("button", { name: "Resume", exact: true })
      .click();
    await expect(dialog(page)).not.toHaveClass(/active/);

    await signInSftp(page);
    await expect(page.locator("#toast-region")).toContainText(
      "belong to a different account and were kept paused",
    );
    const calls = await readMockCallLog(page);
    expect(countOf(calls, "download_object")).toBe(0);
    expect(countOf(calls, "head_object")).toBe(0);
    expect(countOf(calls, "sftp_download")).toBe(0);
    await saveSftpArtifact(page, testInfo, "s3-row-on-sftp-session");
  });

  test("a recovered SFTP row is not run on an S3 session", async ({
    page,
  }, testInfo) => {
    await installLayoutTauriMock(page, {
      transferManifestJson: SFTP_RECOVERED_DOWNLOAD,
      sftp: sftpOptions(),
    });
    await page.goto("/");
    await expect(dialog(page)).toHaveClass(/active/);
    await dialog(page)
      .getByRole("button", { name: "Resume", exact: true })
      .click();
    await expect(dialog(page)).not.toHaveClass(/active/);

    await connectMockListing(page);
    await expect(page.locator("#toast-region")).toContainText(
      "belong to a different account and were kept paused",
    );
    const calls = await readMockCallLog(page);
    expect(countOf(calls, "sftp_download")).toBe(0);
    expect(countOf(calls, "download_object")).toBe(0);
    expect(countOf(calls, "head_object")).toBe(0);
    await saveSftpArtifact(page, testInfo, "sftp-row-on-s3-session");
  });

  test("SFTP rows never show a checksum or verified state; the drawer artifact", async ({
    page,
  }, testInfo) => {
    await connectSftp(page, {
      uploadFiles: [{ name: "final.txt", size: 2048 }],
    });
    await selectOnly(page, fileRow(page, "notes.txt"));
    await page.locator("#batch-download").click();
    await expect
      .poll(async () => countOf(await readMockCallLog(page), "sftp_download"))
      .toBe(1);
    await chooseUploadMenu(page, "Files");
    await expect
      .poll(async () => countOf(await readMockCallLog(page), "sftp_upload"))
      .toBe(1);

    await showTransferList(page);
    const rows = page.locator("#transfer-list .transfer-item");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Completed");
    await expect(rows.nth(1)).toContainText("Completed");
    await expect(page.locator("#transfer-list")).not.toContainText(
      /verified|checksum/i,
    );

    const calls = await readMockCallLog(page);
    expect(countOf(calls, "object_exists")).toBe(0);
    expect(countOf(calls, "head_object")).toBe(0);
    await saveSftpArtifact(page, testInfo, "transfer-drawer-sftp");
  });
});
