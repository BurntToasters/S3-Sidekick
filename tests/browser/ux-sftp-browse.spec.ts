import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { commandCalls, countOf, saveArtifact } from "./helpers";
import {
  installLayoutTauriMock,
  readMockCallLog,
  type MockCall,
  type MockSftpEntry,
  type MockSftpOptions,
} from "./tauri-layout";

/**
 * SFTP browsing, object actions, inspector, preview and move, driven through
 * the mock SFTP server in tauri-layout.ts. Actions that the registry offers for
 * SFTP are checked on the surfaces it renders: the selection bar More menu, the
 * selection bar, and the command palette.
 *
 * Failure-mode inventory, written before the implementation:
 * - An S3-only action (copy URL, share link, S3 URI, ARN, copy/duplicate,
 *   presigned URL, ACL, metadata, versions) is offered for SFTP, or stays
 *   hidden after reconnecting to S3.
 * - New folder accepts "/", "", ".", or "..", or reaches the S3 create command.
 * - Rename overwrites an existing file without asking, replaces a folder, or
 *   leaves the listing stale after success.
 * - Move queues transfer rows or deletes a source after a rename, a per-entry
 *   failure hides the others, or a lost connection keeps going.
 * - Delete sends a folder to the file delete (which the server refuses), or to
 *   the S3 delete; the folder confirmation omits the permanence wording; a
 *   partial failure is reported as success.
 * - The inspector calls head_object, shows S3 sections (ETag, storage class,
 *   ACL, metadata), or omits the permissions, owner, size and modified rows.
 * - Preview calls preview_object, or swallows the backend refusal for a link.
 * - Symlink rows are unmarked, or a link opens as a broken view; a non-UTF-8
 *   name keeps its mutating actions enabled.
 * - Breadcrumbs start at the host instead of "/".
 * - A connection-lost error from a mutation shows the generic error instead of
 *   disconnecting with the reconnect message.
 * - The saved-connection editor shows S3 endpoint and key fields for an SFTP
 *   entry, or Reset host key clears the pin without confirmation.
 *
 * Failure-mode inventory for the location path and SFTP wording (written
 * before the fix):
 * - The location editor shows the S3 "host/path/" form, or an empty value.
 * - Typing an absolute path, a path without a leading slash, "host/path", or
 *   "sftp://host/path" fails, or opens a different folder.
 * - A path on another host is accepted, or fails without naming the host.
 * - A missing path reports "Unknown bucket" instead of a not-found message.
 * - A "." or ".." segment reaches the server as a listing request.
 * - The sidebar title, filter, empty-folder text or path hint says "bucket"
 *   while an SFTP session is open.
 * - The command palette lacks "Go to home folder", or it navigates elsewhere.
 * - The Link and Non-UTF-8 badges are transparent, or sit against the name.
 * - After an SFTP session ends, the sidebar keeps the SFTP words.
 * - The palette "Go to path" entry is missing on SFTP, keeps the S3 key/prefix
 *   label and prompt, or does not navigate to a typed absolute path.
 *
 * Failure-mode inventory for restoring the remembered SFTP folder (written
 * before the fix):
 * - A missing or refused remembered folder leaves the user on an error row
 *   with no way to reach a folder, instead of opening the home folder.
 * - The fallback is silent, or it names the wrong folder.
 * - A lost connection during restore opens home anyway, instead of the
 *   reconnect message.
 * - A home folder that also fails loops, or loses the Retry banner.
 * - The saved-connection editor's SFTP block has no grid, so its labels and
 *   values stack without columns.
 */

const SUITE = "ux-sftp-browse";
const HOST = "files.example.test";
const HOME = "/home/demo";
const PASSWORD = "sftp-password";
/** U+FFFD, the replacement character the native side puts in a lossy name. */
const LOSSY_NAME = "bad�name.txt";

interface SftpMockHook {
  __S3_SFTP_MOCK__: {
    failNext(command: string, message: string): void;
  };
}

const pinnedBookmark = {
  name: "Files",
  endpoint: `sftp://${HOST}:22`,
  region: "",
  access_key: "demo",
  secret_key: PASSWORD,
  protocol: "sftp",
  sftp: {
    auth: "password",
    host_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPlaywrightSftpServerKey",
  },
};

/** The home folder: files, a folder with a child, a link, and a lossy name. */
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
    {
      path: `${HOME}/report.txt`,
      text: "Quarterly report",
      mtime: 1_700_000_100,
      permissions: 0o640,
      owner: "demo",
      group: "demo",
    },
    {
      path: `${HOME}/archive`,
      kind: "dir",
      mtime: 1_700_000_200,
      owner: "demo",
      group: "demo",
    },
    {
      path: `${HOME}/archive/2019.txt`,
      text: "Archived in 2019",
      permissions: 0o600,
      owner: "demo",
      group: "demo",
    },
    { path: `${HOME}/photos`, kind: "dir", owner: "demo", group: "demo" },
    {
      path: `${HOME}/latest.txt`,
      kind: "symlink",
      owner: "demo",
      group: "demo",
    },
    {
      path: `${HOME}/${LOSSY_NAME}`,
      text: "Stored under a name the server sent as raw bytes.",
      owner: "demo",
      group: "demo",
    },
  ];
}

async function connectSftp(
  page: Page,
  sftp: Partial<MockSftpOptions> = {},
): Promise<void> {
  await installLayoutTauriMock(page, {
    sftp: { hostKey: "unknown", homePath: HOME, files: seedFiles(), ...sftp },
  });
  await page.goto("/");
  await expect(page.locator("#connection-screen")).toBeVisible();
  await page.getByRole("radio", { name: "SFTP", exact: true }).check();
  await page.locator("#conn-sftp-host").fill(HOST);
  await page.locator("#conn-sftp-username").fill("demo");
  await page.locator("#conn-sftp-password").fill(PASSWORD);
  await page.locator("#connect-btn").click();
  await page.getByRole("button", { name: "Trust and connect" }).click();
  await expect(page.locator("#main-layout")).toBeVisible();
  await expect(fileRow(page, "notes.txt")).toBeVisible();
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

/** Make `row` the only selected item, clearing any earlier selection first. */
async function selectOnly(page: Page, row: ReturnType<typeof fileRow>) {
  if (await page.locator("#batch-deselect").isVisible()) {
    await page.locator("#batch-deselect").click();
  }
  await row.locator(".row-check").check();
}

function dialogMessage(page: Page) {
  return page.locator("#dialog-message");
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

async function armFailure(
  page: Page,
  command: string,
  message: string,
): Promise<void> {
  await page.evaluate(
    ([cmd, text]) => {
      (window as unknown as SftpMockHook).__S3_SFTP_MOCK__.failNext(cmd, text);
    },
    [command, message] as const,
  );
}

/** Menu labels that only exist for S3: copy URL, share link, S3 URI, ARN, copy. */
const S3_ONLY_MENU_LABELS = [
  /^Copy URL/,
  /^Share link/,
  /^Copy S3 URI/,
  /ARN/,
  /^Copy \//,
  /^Copy to/,
];

/** The open context menu offers no S3-only item. */
async function expectNoS3OnlyMenuItems(page: Page): Promise<void> {
  const menu = page.locator(".context-menu");
  for (const label of S3_ONLY_MENU_LABELS) {
    await expect(menu.getByRole("menuitem", { name: label })).toHaveCount(0);
  }
}

/** Calls to `command` as the mock recorded them, in order. */
function callsTo(calls: MockCall[], command: string): unknown[] {
  return commandCalls(calls, command).map((call) => call.args);
}

test.describe("SFTP object actions", () => {
  test("S3-only actions are absent for SFTP and return after reconnecting to S3", async ({
    page,
  }, testInfo) => {
    await connectSftp(page);
    await selectOnly(page, fileRow(page, "notes.txt"));

    await expect(page.locator("#batch-copy-urls")).toBeHidden();
    await expect(
      page.locator("#batch-copy-move .batch-toolbar__label"),
    ).toHaveText("Move to…");
    await page.locator("#batch-more").click();
    const menu = page.locator(".context-menu");
    await expect(
      menu.getByRole("menuitem", { name: "Copy path" }),
    ).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: /^Share link/ }),
    ).toHaveCount(0);
    await expect(
      menu.getByRole("menuitem", { name: "Copy S3 URI" }),
    ).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: /ARN/ })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // The row context menu follows the same registry rules.
    await fileRow(page, "notes.txt").click({ button: "right" });
    await expectNoS3OnlyMenuItems(page);
    await expect(
      menu.getByRole("menuitem", { name: "Copy path" }),
    ).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "Move to\u2026" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await fileRow(page, "report.txt").locator(".row-check").check();
    await fileRow(page, "notes.txt").click({ button: "right" });
    await expectNoS3OnlyMenuItems(page);
    await page.keyboard.press("Escape");
    await folderRow(page, "archive").locator(".row-check").check();
    await fileRow(page, "notes.txt").click({ button: "right" });
    await expectNoS3OnlyMenuItems(page);
    await page.keyboard.press("Escape");

    await page.locator("#conn-switcher-btn").click();
    await page.locator("#conn-switcher-disconnect").click();
    await expect(page.locator("#connection-screen")).toBeVisible();

    await page.getByRole("radio", { name: "S3", exact: true }).check();
    await page.locator("#conn-endpoint").fill("https://layout-test.invalid");
    await page.locator("#conn-access-key").fill("layout-access-key");
    await page.locator("#conn-secret-key").fill("layout-secret-key");
    await page.locator("#connect-btn").click();
    await expect(page.locator("#main-layout")).toBeVisible();
    await page.locator("#bucket-list").getByText("layout-test-bucket").click();

    await page
      .locator(".object-row--file")
      .first()
      .locator(".row-check")
      .check();
    await page.locator("#batch-more").click();
    await expect(
      page
        .locator(".context-menu")
        .getByRole("menuitem", { name: /^Share link/ }),
    ).toBeVisible();
    await expect(
      page
        .locator(".context-menu")
        .getByRole("menuitem", { name: "Copy S3 URI" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.locator(".object-row--file").first().click({ button: "right" });
    await expect(
      page
        .locator(".context-menu")
        .getByRole("menuitem", { name: "Copy URL", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .locator(".context-menu")
        .getByRole("menuitem", { name: /^Share link/ }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await saveSftpArtifact(page, testInfo, "s3-after-sftp");
  });

  test("a listing marks links and read-only names from its own metadata, with no stat request", async ({
    page,
  }) => {
    await connectSftp(page);
    const link = fileRow(page, "latest.txt");
    await expect(link).toHaveAttribute("data-sftp-kind", "symlink");
    await expect(link.locator(".object-badge")).toHaveText("Link");
    const lossy = page.locator(".object-row--file", { hasText: "\uFFFD" });
    await expect(lossy.locator(".object-badge")).toHaveText("Non-UTF-8");

    await folderRow(page, "photos").dblclick();
    await expect(folderRow(page, "photos")).toHaveCount(0);

    const calls = await readMockCallLog(page);
    expect(countOf(calls, "sftp_list_dir")).toBeGreaterThanOrEqual(2);
    expect(countOf(calls, "sftp_stat")).toBe(0);
  });

  test("New folder creates the folder on the server and refuses reserved names", async ({
    page,
  }, testInfo) => {
    await connectSftp(page);
    await page.locator("#btn-new-folder").click();
    await page.locator("#dialog-input").fill("projects");
    await page.locator("#dialog-ok").click();
    await expect(folderRow(page, "projects")).toBeVisible();

    await page.locator("#btn-new-folder").click();
    await page.locator("#dialog-input").fill("..");
    await page.locator("#dialog-ok").click();
    await expect(page.locator("#status")).toContainText("Folder name");

    const calls = await readMockCallLog(page);
    expect(callsTo(calls, "sftp_create_dir")).toEqual([
      expect.objectContaining({ path: `${HOME}/projects` }),
    ]);
    expect(countOf(calls, "create_folder")).toBe(0);
    await saveSftpArtifact(page, testInfo, "new-folder");
  });

  test("renames a file and a folder on the server", async ({ page }) => {
    await connectSftp(page);
    await selectOnly(page, fileRow(page, "report.txt"));
    await page.locator("#batch-rename").click();
    await page.locator("#dialog-input").fill("summary.txt");
    await page.locator("#dialog-ok").click();
    await expect(fileRow(page, "summary.txt")).toBeVisible();
    await expect(fileRow(page, "report.txt")).toHaveCount(0);

    await selectOnly(page, folderRow(page, "archive"));
    await page.locator("#batch-rename").click();
    await page.locator("#dialog-input").fill("old-archive");
    await page.locator("#dialog-ok").click();
    await expect(folderRow(page, "old-archive")).toBeVisible();
    await expect(folderRow(page, "archive")).toHaveCount(0);

    const renames = callsTo(await readMockCallLog(page), "sftp_rename");
    expect(renames).toEqual([
      expect.objectContaining({
        fromPath: `${HOME}/report.txt`,
        toPath: `${HOME}/summary.txt`,
        overwrite: false,
      }),
      expect.objectContaining({
        fromPath: `${HOME}/archive`,
        toPath: `${HOME}/old-archive`,
        overwrite: false,
      }),
    ]);
  });

  test("renaming onto an existing file asks first, then replaces it", async ({
    page,
  }, testInfo) => {
    await connectSftp(page);
    await selectOnly(page, fileRow(page, "notes.txt"));
    await page.locator("#batch-rename").click();
    await page.locator("#dialog-input").fill("report.txt");
    await page.locator("#dialog-ok").click();

    await expect(page.locator("#dialog-title")).toHaveText("Replace file?");
    await saveSftpArtifact(page, testInfo, "rename-conflict-prompt");
    await page.locator("#dialog-ok").click();

    await expect(fileRow(page, "report.txt")).toBeVisible();
    await expect(fileRow(page, "notes.txt")).toHaveCount(0);
    const renames = callsTo(await readMockCallLog(page), "sftp_rename");
    expect(renames).toEqual([
      expect.objectContaining({ overwrite: false }),
      expect.objectContaining({
        fromPath: `${HOME}/notes.txt`,
        toPath: `${HOME}/report.txt`,
        overwrite: true,
      }),
    ]);
  });

  test("moving two files into a folder renames each one and queues no transfers", async ({
    page,
  }) => {
    await connectSftp(page);
    await fileRow(page, "notes.txt").locator(".row-check").check();
    await fileRow(page, "report.txt").locator(".row-check").check();
    await page.locator("#batch-copy-move").click();

    await expect(page.locator("#copy-move-overlay")).toHaveClass(/active/);
    await expect(page.locator("#copy-move-copy-btn")).toBeHidden();
    await expect(page.locator("#copy-move-bucket")).toBeHidden();
    await expect(page.locator('label[for="copy-move-path"]')).toHaveText(
      "Destination folder on the server",
    );
    await page.locator("#copy-move-path").fill("home/demo/archive/");
    await page.locator("#copy-move-move-btn").click();

    await expect(page.locator("#copy-move-overlay")).not.toHaveClass(/active/);
    await expect(fileRow(page, "notes.txt")).toHaveCount(0);
    await expect(fileRow(page, "report.txt")).toHaveCount(0);
    await expect(page.locator("#status")).toContainText("Moved 2 items");

    const calls = await readMockCallLog(page);
    expect(callsTo(calls, "sftp_rename")).toEqual([
      expect.objectContaining({
        fromPath: `${HOME}/notes.txt`,
        toPath: `${HOME}/archive/notes.txt`,
        overwrite: false,
      }),
      expect.objectContaining({
        fromPath: `${HOME}/report.txt`,
        toPath: `${HOME}/archive/report.txt`,
        overwrite: false,
      }),
    ]);
    expect(countOf(calls, "enqueue_copy_move")).toBe(0);
    expect(countOf(calls, "copy_object")).toBe(0);
    expect(countOf(calls, "delete_objects")).toBe(0);
    expect(countOf(calls, "sftp_delete")).toBe(0);
  });

  test("deleting a file and a folder asks first, and the folder wording says it is permanent", async ({
    page,
  }, testInfo) => {
    await connectSftp(page);
    await selectOnly(page, fileRow(page, "report.txt"));
    await page.locator("#batch-delete").click();
    await expect(page.locator("#dialog-overlay")).toBeVisible();
    await expect(dialogMessage(page)).toContainText("Delete 1 file?");
    await page.locator("#dialog-ok").click();
    await expect(fileRow(page, "report.txt")).toHaveCount(0);

    await selectOnly(page, folderRow(page, "archive"));
    await page.locator("#batch-delete").click();
    await expect(dialogMessage(page)).toContainText("permanently");
    await expect(dialogMessage(page)).toContainText("on the server");
    await expect(dialogMessage(page)).toContainText("everything inside");
    await saveSftpArtifact(page, testInfo, "folder-delete-prompt");
    await page.locator("#dialog-ok").click();
    await expect(folderRow(page, "archive")).toHaveCount(0);

    const calls = await readMockCallLog(page);
    expect(callsTo(calls, "sftp_delete")).toEqual([
      expect.objectContaining({ paths: [`${HOME}/report.txt`] }),
    ]);
    expect(callsTo(calls, "sftp_delete_dir")).toEqual([
      expect.objectContaining({ path: `${HOME}/archive`, transferId: null }),
    ]);
    expect(countOf(calls, "delete_objects")).toBe(0);
    expect(countOf(calls, "delete_prefix")).toBe(0);
  });

  test("the inspector shows SFTP facts and no S3 sections", async ({
    page,
  }, testInfo) => {
    await connectSftp(page);
    await selectOnly(page, fileRow(page, "report.txt"));
    await page.locator("#batch-more").click();
    await page
      .locator(".context-menu")
      .getByRole("menuitem", { name: "Properties" })
      .click();

    const details = page.locator("[data-sftp-details]");
    await expect(details).toBeVisible();
    await expect(details).toContainText("rw-r-----");
    await expect(details).toContainText("0640");
    await expect(details).toContainText("demo");
    await expect(details).toContainText(`${HOME}/report.txt`);
    await expect(details).toContainText("Size");
    await expect(details).toContainText("Last modified");
    for (const s3Only of [
      "ETag",
      "Storage class",
      "Encryption",
      "Content type",
      "Version",
      "Object URL",
      "S3 URI",
      "ACL",
      "Tags",
    ]) {
      await expect(details).not.toContainText(s3Only);
    }
    await expect(
      page.locator('[data-inspector-tab="permissions"]'),
    ).toBeHidden();
    await expect(page.locator('[data-inspector-tab="metadata"]')).toBeHidden();
    const calls = await readMockCallLog(page);
    expect(callsTo(calls, "sftp_stat")).toContainEqual(
      expect.objectContaining({ path: `${HOME}/report.txt` }),
    );
    expect(countOf(calls, "head_object")).toBe(0);
    await saveSftpArtifact(page, testInfo, "inspector");
  });

  test("a text file previews through the SFTP preview command", async ({
    page,
  }) => {
    await connectSftp(page);
    await fileRow(page, "notes.txt").click({ button: "right" });
    await page
      .locator(".context-menu")
      .getByRole("menuitem", { name: "Preview" })
      .click();

    await expect(page.getByText("Meeting notes").first()).toBeVisible();
    const calls = await readMockCallLog(page);
    expect(callsTo(calls, "sftp_preview")).toContainEqual(
      expect.objectContaining({ path: `${HOME}/notes.txt` }),
    );
    expect(countOf(calls, "preview_object")).toBe(0);
  });

  test("a link previews as the backend's refusal, not a broken view", async ({
    page,
  }) => {
    await connectSftp(page);
    await fileRow(page, "latest.txt").click({ button: "right" });
    await page
      .locator(".context-menu")
      .getByRole("menuitem", { name: "Preview" })
      .click();

    await expect(
      page.getByText("Remote path is not a regular file"),
    ).toBeVisible();
  });

  test("symlink and non-UTF-8 rows are marked, and their mutations are disabled", async ({
    page,
  }, testInfo) => {
    await connectSftp(page);
    const link = fileRow(page, "latest.txt");
    await expect(link).toHaveAttribute("data-sftp-kind", "symlink");
    await expect(link.locator(".object-badge")).toHaveText("Link");

    const lossy = page.locator(".object-row--file", { hasText: "�" });
    await expect(lossy).toHaveCount(1);
    await expect(lossy.locator(".object-badge")).toHaveText("Non-UTF-8");
    await selectOnly(page, lossy);
    await expect(page.locator("#batch-rename")).toBeDisabled();
    await expect(page.locator("#batch-rename")).toHaveAttribute(
      "title",
      /read-only in this beta/,
    );
    await expect(page.locator("#batch-delete")).toBeDisabled();
    await expect(page.locator("#batch-copy-move")).toBeDisabled();
    await lossy.click({ button: "right" });
    const lossyMenu = page.locator(".context-menu");
    for (const label of ["Rename", "Delete", "Move to\u2026"]) {
      await expect(
        lossyMenu.getByRole("menuitem", { name: label, exact: true }),
      ).toHaveAttribute("aria-disabled", "true");
    }
    await page.keyboard.press("Escape");
    await saveSftpArtifact(page, testInfo, "lossy-row-disabled");
  });

  test("breadcrumbs start at / and the host stays the sidebar bucket", async ({
    page,
  }) => {
    await connectSftp(page);
    await folderRow(page, "photos").dblclick();
    await expect(folderRow(page, "photos")).toHaveCount(0);

    const crumbs = page.locator(
      "#location-omnibar-browse .breadcrumb__segment, #breadcrumb .breadcrumb__segment",
    );
    await expect(crumbs.first()).toHaveText("/");
    await expect(crumbs.last()).toHaveText("photos");
    await expect(page.locator("#bucket-list")).toContainText(HOST);
  });

  test("a connection-lost error from a delete disconnects and says to reconnect", async ({
    page,
  }) => {
    await connectSftp(page);
    await armFailure(
      page,
      "sftp_delete",
      `SFTP connection lost: delete ${HOME}/report.txt`,
    );
    await selectOnly(page, fileRow(page, "report.txt"));
    await page.locator("#batch-delete").click();
    await page.locator("#dialog-ok").click();

    await expect(page.locator("#connection-screen")).toBeVisible();
    await expect(page.locator("#status")).toHaveText(
      "The SFTP connection was lost. Reconnect to continue.",
    );
    await expect(
      page
        .locator("#toast-region")
        .getByText("The SFTP connection was lost. Reconnect to continue."),
    ).toBeVisible();
    expect(
      countOf(await readMockCallLog(page), "disconnect"),
    ).toBeGreaterThanOrEqual(1);
  });

  test("Copy path copies the absolute remote path, not an S3 URL", async ({
    page,
  }) => {
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
    await connectSftp(page);
    await selectOnly(page, fileRow(page, "notes.txt"));
    await page.locator("#batch-more").click();
    await page
      .locator(".context-menu")
      .getByRole("menuitem", { name: "Copy path" })
      .click();

    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __copied?: string }).__copied,
        ),
      )
      .toBe(`${HOME}/notes.txt`);
  });
});

test.describe("SFTP saved connection editor", () => {
  test("the saved-connection editor shows SFTP fields and resets the host key after confirming", async ({
    page,
  }, testInfo) => {
    await installLayoutTauriMock(page, {
      bookmarks: [pinnedBookmark],
      sftp: { hostKey: "pinned-ok", homePath: HOME, files: seedFiles() },
    });
    await page.goto("/");
    await expect(page.locator("#connection-screen")).toBeVisible();
    await page.locator("#settings-btn").click();
    await page.locator("#settings-tab-bookmarks").click();
    await page
      .locator("#bookmark-list")
      .getByRole("button", { name: /^Edit/ })
      .click();

    await expect(page.locator("#bookmark-edit")).toBeVisible();
    await expect(page.locator("#bookmark-edit-endpoint")).toBeHidden();
    await expect(page.locator("#bookmark-edit-access-key")).toBeHidden();
    await expect(page.locator("#bookmark-edit-secret-key")).toBeHidden();
    const sftpFields = page.locator("#bookmark-edit-sftp");
    await expect(sftpFields).toContainText(HOST);
    await expect(sftpFields).toContainText("22");
    await expect(sftpFields).toContainText("demo");
    await expect(sftpFields).toContainText("Password");
    await expect(sftpFields).toContainText("re-save");
    await saveSftpArtifact(page, testInfo, "saved-connection-editor");

    await page.locator("#bookmark-edit-reset-hostkey").click();
    await expect(page.locator("#dialog-title")).toHaveText("Reset host key?");
    await expect(page.locator("#dialog-message")).toContainText(
      "man-in-the-middle",
    );
    await page.locator("#dialog-cancel").click();
    expect(countOf(await readMockCallLog(page), "save_bookmarks")).toBe(0);

    await page.locator("#bookmark-edit-reset-hostkey").click();
    await page.locator("#dialog-ok").click();
    await expect
      .poll(async () => countOf(await readMockCallLog(page), "save_bookmarks"))
      .toBe(1);
    const calls = await readMockCallLog(page);
    const saved = JSON.parse(
      String(
        (
          commandCalls(calls, "save_bookmarks").at(-1)?.args as Record<
            string,
            unknown
          >
        ).json,
      ),
    ) as Array<{ sftp?: Record<string, unknown> }>;
    expect(saved[0]?.sftp?.host_key).toBeUndefined();
    expect(saved[0]?.sftp?.auth).toBe("password");
  });
});

/** Type a location into the omnibar editor and submit it. */
async function typeLocation(page: Page, value: string): Promise<void> {
  await page.keyboard.press("Control+l");
  await expect(page.locator("#location-omnibar-edit")).toBeFocused();
  await page.locator("#location-omnibar-edit").fill(value);
  await page.keyboard.press("Enter");
}

/** Every status line the page shows, including the navigation error row. */
async function visibleMessages(page: Page): Promise<string> {
  return page.evaluate(() =>
    [
      document.getElementById("status")?.textContent ?? "",
      document.getElementById("object-tbody")?.textContent ?? "",
    ].join("\n"),
  );
}

test.describe("SFTP location path and wording", () => {
  test("editing the location shows the absolute remote folder with a trailing slash", async ({
    page,
  }) => {
    await connectSftp(page);
    await page.keyboard.press("Control+l");
    await expect(page.locator("#location-omnibar-edit")).toBeFocused();
    await expect(page.locator("#location-omnibar-edit")).toHaveValue(
      `${HOME}/`,
    );
    await expect(page.locator("#location-omnibar-edit")).toHaveAttribute(
      "placeholder",
      "/path/to/folder",
    );
    await page.keyboard.press("Escape");
    await expect(page.locator("#location-omnibar-edit")).toBeHidden();
  });

  test("typing an absolute folder path opens that folder, with no unknown-bucket error", async ({
    page,
  }) => {
    await connectSftp(page);
    await typeLocation(page, `${HOME}/archive`);

    await expect(fileRow(page, "2019.txt")).toBeVisible();
    await expect(page.locator("#location-omnibar-browse")).toContainText(
      "archive",
    );
    const calls = await readMockCallLog(page);
    expect(callsTo(calls, "sftp_list_dir")).toContainEqual(
      expect.objectContaining({ path: `${HOME}/archive` }),
    );
    await expect(page.locator("#status")).not.toContainText("Unknown bucket");
  });

  test("a path without a leading slash, host/path, and sftp:// URL reach the same folder", async ({
    page,
  }) => {
    await connectSftp(page);

    await typeLocation(page, "home/demo/archive/");
    await expect(fileRow(page, "2019.txt")).toBeVisible();

    await typeLocation(page, `${HOST}/home/demo/`);
    await expect(fileRow(page, "notes.txt")).toBeVisible();

    await typeLocation(page, `sftp://${HOST}/home/demo/archive/`);
    await expect(fileRow(page, "2019.txt")).toBeVisible();

    await typeLocation(page, "/");
    await expect(folderRow(page, "home")).toBeVisible();
    await expect(page.locator("#status")).not.toContainText("Unknown bucket");
  });

  test("a path on another host is refused and the message names the connected host", async ({
    page,
  }) => {
    await connectSftp(page);
    await typeLocation(page, "sftp://elsewhere.example.test/home/demo/");

    await expect(page.locator("#status")).toContainText(HOST);
    await expect(page.locator("#status")).not.toContainText("Unknown bucket");
    const calls = await readMockCallLog(page);
    expect(
      callsTo(calls, "sftp_list_dir").filter((args) =>
        String((args as { path?: unknown }).path).includes("elsewhere"),
      ),
    ).toHaveLength(0);
  });

  test("a missing folder reports not-found, never Unknown bucket", async ({
    page,
  }, testInfo) => {
    await connectSftp(page);
    await typeLocation(page, "/var/log/");

    await expect(page.locator("#object-tbody")).toContainText(
      "No such file or directory",
    );
    const messages = await visibleMessages(page);
    expect(messages).not.toContain("Unknown bucket");
    await saveSftpArtifact(page, testInfo, "location-not-found");
  });

  test("dot segments are refused with a clear message and never reach the server", async ({
    page,
  }) => {
    await connectSftp(page);
    await typeLocation(page, `${HOME}/../etc/`);

    await expect(page.locator("#status")).toContainText('"."');
    await expect(page.locator("#status")).not.toContainText("Unknown bucket");
    const calls = await readMockCallLog(page);
    for (const args of callsTo(calls, "sftp_list_dir")) {
      expect(String((args as { path?: unknown }).path)).not.toMatch(/\.\./);
    }
    await expect(fileRow(page, "notes.txt")).toBeVisible();
  });

  test("the sidebar and an empty folder use server and folder words, never bucket", async ({
    page,
  }, testInfo) => {
    await connectSftp(page);
    const panel = page.locator("#bucket-panel");
    await expect(panel.locator(".sidebar__header > span").first()).toHaveText(
      "Servers",
    );
    await expect(page.locator("#bucket-filter-input")).toHaveAttribute(
      "placeholder",
      "Filter…",
    );
    await expect(panel).not.toContainText(/bucket/i);
    await expect(page.locator("#bucket-list")).toHaveAttribute(
      "aria-label",
      "Servers",
    );

    await typeLocation(page, `${HOME}/photos/`);
    await expect(page.locator("#object-tbody .browse-empty__title")).toHaveText(
      "Empty folder",
    );
    await expect(page.locator("#object-tbody .browse-empty__text")).toHaveText(
      "This folder is empty",
    );
    await expect(page.locator("#object-tbody")).not.toContainText(/bucket/i);
    await saveSftpArtifact(page, testInfo, "empty-folder-wording");
  });

  test("the command palette offers Go to home folder and runs it", async ({
    page,
  }, testInfo) => {
    await connectSftp(page);
    await folderRow(page, "archive").dblclick();
    await expect(fileRow(page, "2019.txt")).toBeVisible();

    await page.locator("#palette-hint").click();
    await expect(page.locator("#palette-overlay")).toBeVisible();
    await page.locator("#palette-input").fill("Go to home");
    const item = page.locator("#palette-results .palette__item", {
      hasText: "Go to home folder",
    });
    await expect(item).toBeVisible();
    await saveSftpArtifact(page, testInfo, "palette-home-folder");
    await page.keyboard.press("Enter");

    await expect(fileRow(page, "notes.txt")).toBeVisible();
    await expect(fileRow(page, "2019.txt")).toHaveCount(0);
  });

  test("the Link and Non-UTF-8 badges have a background and a gap from the file name", async ({
    page,
  }) => {
    await connectSftp(page);
    const rows = [
      fileRow(page, "latest.txt"),
      page.locator(".object-row--file", { hasText: "�" }),
    ];
    for (const row of rows) {
      const badge = row.locator(".object-badge");
      const name = row.locator(".object-name__text");
      await expect(badge).toBeVisible();

      const background = await badge.evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      );
      expect(background).not.toBe("rgba(0, 0, 0, 0)");
      expect(background).not.toBe("transparent");

      const badgeBox = await badge.boundingBox();
      const nameBox = await name.boundingBox();
      expect(badgeBox).not.toBeNull();
      expect(nameBox).not.toBeNull();
      expect(
        (badgeBox?.x ?? 0) - ((nameBox?.x ?? 0) + (nameBox?.width ?? 0)),
      ).toBeGreaterThanOrEqual(4);
    }
  });

  test("the sidebar and location words return to bucket words after the SFTP session ends", async ({
    page,
  }) => {
    await connectSftp(page);
    await expect(page.locator("#bucket-panel")).toContainText("Servers");

    await page.locator("#conn-switcher-btn").click();
    await page.locator("#conn-switcher-disconnect").click();
    await expect(page.locator("#connection-screen")).toBeVisible();

    await expect(page.locator("#bucket-panel")).toHaveAttribute(
      "aria-label",
      "Buckets",
    );
    await expect(page.locator("#bucket-list")).toHaveAttribute(
      "aria-label",
      "Buckets",
    );
    await expect(page.locator("#bucket-filter-input")).toHaveAttribute(
      "placeholder",
      "Filter buckets…",
    );
    await expect(page.locator("#location-omnibar-edit")).toHaveAttribute(
      "placeholder",
      "bucket/prefix/",
    );
  });

  test("the palette Go to path entry on SFTP prompts for a path and navigates to it", async ({
    page,
  }) => {
    await connectSftp(page);
    await page.locator("#palette-hint").click();
    await expect(page.locator("#palette-overlay")).toBeVisible();
    await page.locator("#palette-input").fill("Go to path");
    const item = page.locator("#palette-results .palette__item", {
      hasText: "Go to path",
    });
    await expect(item).toBeVisible();
    await expect(
      page.locator("#palette-results .palette__item", {
        hasText: "Go to key/prefix",
      }),
    ).toHaveCount(0);
    await page.keyboard.press("Enter");

    await expect(page.locator("#dialog-message")).toContainText(
      "/path/to/folder",
    );
    await expect(page.locator("#dialog-message")).not.toContainText(
      "key or prefix",
    );
    await page.locator("#dialog-input").fill(`${HOME}/archive`);
    await page.locator("#dialog-ok").click();
    await expect(fileRow(page, "2019.txt")).toBeVisible();
    await expect(page.locator("#status")).not.toContainText("Unknown bucket");

    await page.keyboard.press("Control+k");
    await expect(page.locator("#palette-overlay")).toBeVisible();
    await page.locator("#palette-input").fill("Go to path");
    await page.keyboard.press("Enter");
    await page.locator("#dialog-input").fill(`${HOME}/../etc`);
    await page.locator("#dialog-ok").click();
    await expect(page.locator("#status")).toContainText('"."');
    await expect(fileRow(page, "2019.txt")).toBeVisible();
    const calls = await readMockCallLog(page);
    for (const args of callsTo(calls, "sftp_list_dir")) {
      expect(String((args as { path?: unknown }).path)).not.toMatch(/\.\./);
    }
  });
});

/** Connect the pinned saved SFTP bookmark, with a remembered folder seeded. */
async function openSavedSftp(
  page: Page,
  rememberedPrefix: string,
  sftp: Partial<MockSftpOptions> = {},
): Promise<void> {
  await installLayoutTauriMock(page, {
    bookmarks: [pinnedBookmark],
    sftp: {
      hostKey: "pinned-ok",
      homePath: HOME,
      files: seedFiles(),
      ...sftp,
    },
  });
  await page.addInitScript(
    ({ key, bucket, prefix }) => {
      window.localStorage.setItem(
        "s3-sidekick.connection-memory",
        JSON.stringify({
          [key]: { bucket, prefix, lastUsedAt: 1_700_000_000_000 },
        }),
      );
    },
    {
      key: `${pinnedBookmark.name}\n${pinnedBookmark.endpoint}`,
      bucket: HOST,
      prefix: rememberedPrefix,
    },
  );
  await page.goto("/");
  await expect(page.locator("#connection-screen")).toBeVisible();
}

/** Paths of every `sftp_list_dir` call, in the order they were made. */
async function listedDirs(page: Page): Promise<string[]> {
  return callsTo(await readMockCallLog(page), "sftp_list_dir").map((args) =>
    String((args as { path?: unknown }).path),
  );
}

test.describe("SFTP remembered folder restore", () => {
  test("a remembered folder that is missing on connect opens the home folder with a notice", async ({
    page,
  }, testInfo) => {
    await openSavedSftp(page, "var/gone/");
    await page.locator("#conn-saved-list .bookmark-item__connect").click();

    await expect(fileRow(page, "notes.txt")).toBeVisible();
    await expect(page.locator("#status")).toHaveText(
      "/var/gone is no longer available. Opened your home folder.",
    );
    expect(await listedDirs(page)).toEqual(["/var/gone", HOME]);
    await expect(page.locator("#object-tbody")).not.toContainText("etc");
    await saveSftpArtifact(page, testInfo, "remembered-folder-missing");
  });

  test("a remembered folder that is refused on connect also opens home", async ({
    page,
  }) => {
    await openSavedSftp(page, "archive/");
    await armFailure(page, "sftp_list_dir", "Permission denied");
    await page.locator("#conn-saved-list .bookmark-item__connect").click();

    await expect(fileRow(page, "notes.txt")).toBeVisible();
    await expect(page.locator("#status")).toHaveText(
      "/archive is no longer available. Opened your home folder.",
    );
    expect(await listedDirs(page)).toEqual(["/archive", HOME]);
  });

  test("a home folder that also fails keeps the retry banner", async ({
    page,
  }) => {
    await openSavedSftp(page, "var/gone/", { homePath: "/home/nobody" });
    await page.locator("#conn-saved-list .bookmark-item__connect").click();

    const banner = page.locator("#object-tbody [data-nav-error]");
    await expect(banner).toContainText(
      "Connected, but failed to open the folder",
    );
    await expect(banner.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(await listedDirs(page)).toEqual(["/var/gone", "/home/nobody"]);
  });

  test("a lost connection while restoring uses the reconnect message, not home", async ({
    page,
  }) => {
    await openSavedSftp(page, "archive/");
    await armFailure(
      page,
      "sftp_list_dir",
      "SFTP connection lost: keepalive timed out",
    );
    await page.locator("#conn-saved-list .bookmark-item__connect").click();

    await expect(page.locator("#connection-screen")).toBeVisible();
    await expect(page.locator("#status")).toHaveText(
      "The SFTP connection was lost. Reconnect to continue.",
    );
    expect(await listedDirs(page)).toEqual(["/archive"]);
  });
});

test.describe("SFTP saved connection editor layout", () => {
  test("the SFTP details lay out as a label and value grid", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, {
      bookmarks: [pinnedBookmark],
      sftp: { hostKey: "pinned-ok", homePath: HOME, files: seedFiles() },
    });
    await page.goto("/");
    await expect(page.locator("#connection-screen")).toBeVisible();
    await page.locator("#settings-btn").click();
    await page.locator("#settings-tab-bookmarks").click();
    await page
      .locator("#bookmark-list")
      .getByRole("button", { name: /^Edit/ })
      .click();

    const block = page.locator("#bookmark-edit-sftp");
    await expect(block).toBeVisible();
    await expect(block).toHaveCSS("display", "grid");
    const hostLabel = await page
      .locator(".bookmark-edit__label", { hasText: /^Host$/ })
      .boundingBox();
    const portLabel = await page
      .locator(".bookmark-edit__label", { hasText: "Port" })
      .boundingBox();
    const hostValue = await page
      .locator("#bookmark-edit-sftp-host")
      .boundingBox();
    expect(hostLabel && portLabel && hostValue).toBeTruthy();
    // Every label shares a column, and each value sits to the right of it.
    expect(Math.round(hostLabel!.x)).toBe(Math.round(portLabel!.x));
    expect(hostValue!.x).toBeGreaterThan(hostLabel!.x + hostLabel!.width);
    await expect(page.locator(".bookmark-edit__label").first()).toHaveCSS(
      "color",
      "rgb(102, 102, 111)",
    );
    const hostKey = page.locator("#bookmark-edit-sftp-hostkey");
    const fits = await hostKey.evaluate(
      (el) => el.scrollWidth <= el.clientWidth + 1,
    );
    expect(fits).toBe(true);
    await expect(page.locator("#bookmark-edit-reset-hostkey")).toBeVisible();
  });
});
