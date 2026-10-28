// Failure modes covered before implementation:
// - A selected folder is serialized as a file key, losing its prefix.
// - A file copied into `folder/` is written to the folder marker instead of
//   receiving its basename.
// - A move deletes the source before a destination copy is committed, or a
//   copy deletes the source at all.
// - Provider status text leaks opaque 403/AccessDenied details instead of the
//   friendly permission guidance users need.
// - A failed unlock closes the prompt or changes the vault state; a successful
//   retry must unlock and update Settings.
// - Corrupt/locked bookmark storage is treated as an empty list and then
//   overwritten by an import or delete.
// - A queued bookmark mutation uses a stale array index and deletes whichever
//   row shifted into that position.
// - Offline detection blocks localhost MinIO even though it remains reachable.
// - Bracketed IPv6 loopback is misread as remote and gets an insecure-HTTP
//   confirmation intended only for non-local endpoints.
// - Cancel during async unlock validation lets the backend unlock later, then
//   reloads secrets while the UI claims the vault stayed locked.

import { expect, test, type Page } from "@playwright/test";
import {
  FULL_CREATE_ONLY,
  commandCalls,
  openCopyMoveFromRow,
  saveArtifact as saveSuiteArtifact,
} from "./helpers";
import {
  connectMockListing,
  installLayoutTauriMock,
  openMockListing,
  readMockCallLog,
  releaseMockUnlock,
} from "./tauri-layout";

/**
 * Move is offered only when connect reports a provider that verifies
 * conditional DELETE. The shared layout mock predates that field, so Move
 * tests opt in here, before the app reads the connect result.
 */
async function openMoveReadyListing(
  page: Page,
  options: Parameters<typeof openMockListing>[1] = {},
): Promise<void> {
  await installLayoutTauriMock(page, options);
  await page.addInitScript(() => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (
            cmd: string,
            args?: unknown,
            opts?: unknown,
          ) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    const inner = internals.invoke;
    internals.invoke = async (cmd, args, opts) => {
      if (cmd !== "connect") return inner(cmd, args, opts);
      const result = (await inner(cmd, args, opts)) as Record<string, unknown>;
      return { ...result, conditional_delete_supported: true };
    };
  });
  await page.goto("/");
  await expect(page.locator("#connection-screen")).toBeVisible();
  await connectMockListing(page, options.endpoint);
}

const BOOKMARK_A = {
  name: "Alpha",
  endpoint: "https://alpha.example.invalid",
  region: "us-east-1",
  access_key: "alpha-access",
  secret_key: "alpha-secret",
};

const BOOKMARK_B = {
  name: "Beta",
  endpoint: "https://beta.example.invalid",
  region: "us-west-2",
  access_key: "beta-access",
  secret_key: "beta-secret",
};

const LEGACY_COPIED_MOVE_WITHOUT_OWNERSHIP_PROOF = JSON.stringify({
  version: 6,
  items: [
    {
      operation: "move",
      bucket: "layout-test-bucket",
      fileName: "000-sample-object.txt",
      filePath: "",
      key: "reports/000-sample-object.txt",
      sourceBucket: "layout-test-bucket",
      sourceKey: "reports/000-sample-object.txt",
      destinationBucket: "layout-test-bucket",
      destinationKey: "destination/000-sample-object.txt",
      size: 512,
      totalBytes: 512,
      attempt: 1,
      maxAttempts: 1,
      conflictResolution: "ask",
      movePhase: "copied",
      receipts: [
        {
          source_key: "reports/000-sample-object.txt",
          source_etag: "mock-source-etag",
          source_fingerprint: "a".repeat(64),
          source_acl_fingerprint: "a".repeat(64),
          source_tag_fingerprint: "a".repeat(64),
          source_version_id: null,
          destination_key: "destination/000-sample-object.txt",
          destination_etag: "mock-destination-etag",
          destination_fingerprint: "a".repeat(64),
          destination_acl_fingerprint: "a".repeat(64),
          destination_tag_fingerprint: "a".repeat(64),
          destination_version_id: null,
        },
      ],
      connectionIdentity: "browser-layout-identity",
    },
  ],
});

async function showTransferList(page: Page): Promise<void> {
  const list = page.locator("#transfer-list");
  if (!(await list.isVisible())) await page.locator("#transfer-toggle").click();
  await expect(list).toBeVisible();
}

test.describe("frontend mutation and recovery safety", () => {
  test("copies a folder as a prefix and never deletes its source", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, {
      objectCount: 0,
      prefixes: ["archive/"],
      createOnlyCapabilities: FULL_CREATE_ONLY,
      listObjectsByPrefix: {
        "target/archive/": { objects: [], prefixes: [] },
      },
    });

    const folder = page.locator(".object-row--folder").first();
    await expect(folder).toContainText("archive");
    await openCopyMoveFromRow(page, folder);
    await expect(page.locator("#copy-move-desc")).toHaveText(
      "Folder: archive/",
    );
    await page.locator("#copy-move-path").fill("target/archive/");
    await page.locator("#copy-move-copy-btn").click();
    await expect(page.locator("#copy-move-overlay")).not.toHaveClass(/active/);

    await expect
      .poll(async () => {
        const calls = await readMockCallLog(page);
        return commandCalls(calls, "copy_prefix_to").length;
      })
      .toBe(1);

    const calls = await readMockCallLog(page);
    const copy = commandCalls(calls, "copy_prefix_to")[0];
    expect(copy.args).toMatchObject({
      srcBucket: "layout-test-bucket",
      srcPrefix: "archive/",
      dstBucket: "layout-test-bucket",
      dstPrefix: "target/archive/",
      overwrite: false,
      collectReceipts: false,
    });
    expect(commandCalls(calls, "delete_copied_objects")).toHaveLength(0);
    await saveSuiteArtifact(
      page,
      testInfo,
      "frontend-safety",
      "folder-copy",
      calls,
    );
  });

  test("moves a file into a folder by appending its basename, then deletes exact receipts", async ({
    page,
  }, testInfo) => {
    await openMoveReadyListing(page, {
      objectCount: 1,
      prefixes: [],
      createOnlyCapabilities: FULL_CREATE_ONLY,
      listObjectsByPrefix: {
        "destination/": { objects: [], prefixes: [] },
      },
    });

    const file = page.locator(".object-row--file").first();
    const sourceKey = await file.getAttribute("data-key");
    expect(sourceKey).toBeTruthy();
    const sourceName = sourceKey!.split("/").pop();
    expect(sourceName).toBeTruthy();

    await openCopyMoveFromRow(page, file);
    await page.locator("#copy-move-path").fill("destination/");
    await page.locator("#copy-move-move-btn").click();
    await expect(page.locator("#copy-move-overlay")).not.toHaveClass(/active/);

    await expect
      .poll(async () => {
        const calls = await readMockCallLog(page);
        return commandCalls(calls, "delete_copied_objects").length;
      })
      .toBe(1);

    const calls = await readMockCallLog(page);
    const copy = commandCalls(calls, "copy_object_to")[0];
    expect(copy.args).toMatchObject({
      srcBucket: "layout-test-bucket",
      srcKey: sourceKey,
      dstBucket: "layout-test-bucket",
      dstKey: `destination/${sourceName}`,
      overwrite: false,
      automaticMove: true,
    });
    const deletion = commandCalls(calls, "delete_copied_objects")[0];
    expect(deletion.args).toMatchObject({
      srcBucket: "layout-test-bucket",
      dstBucket: "layout-test-bucket",
    });
    expect(deletion.args).toHaveProperty("receipts");
    expect(
      (deletion.args as { receipts: Array<{ source_key: string }> }).receipts,
    ).toEqual([expect.objectContaining({ source_key: sourceKey })]);
    expect(
      (deletion.args as { receipts: Array<{ ownership_ambiguous: boolean }> })
        .receipts,
    ).toEqual([expect.objectContaining({ ownership_ambiguous: false })]);
    const durableMarker = commandCalls(calls, "save_transfer_manifest")
      .map((call) => call.args as { json?: string })
      .map((args) => (args.json ? JSON.parse(args.json) : null))
      .find((manifest) => manifest?.items?.[0]?.movePhase === "copied");
    expect(durableMarker?.items[0].receipts[0].ownership_ambiguous).toBe(false);
    await saveSuiteArtifact(
      page,
      testInfo,
      "frontend-safety",
      "file-move",
      calls,
    );
  });

  test("keeps ambiguous fresh receipts ambiguous through persistence and delete admission", async ({
    page,
  }, testInfo) => {
    await openMoveReadyListing(page, {
      objectCount: 1,
      prefixes: [],
      createOnlyCapabilities: FULL_CREATE_ONLY,
      listObjectsByPrefix: {
        "destination/": { objects: [], prefixes: [] },
      },
      copyReceiptOwnershipAmbiguous: true,
    });

    await openCopyMoveFromRow(page, page.locator(".object-row--file").first());
    await page.locator("#copy-move-path").fill("destination/");
    await page.locator("#copy-move-move-btn").click();
    await expect(page.locator("#copy-move-overlay")).not.toHaveClass(/active/);
    await expect
      .poll(async () => {
        const calls = await readMockCallLog(page);
        return commandCalls(calls, "save_transfer_manifest").length;
      })
      .toBeGreaterThan(0);
    await expect(page.locator("#transfer-queue-summary")).toContainText(
      "1 failed",
    );

    const calls = await readMockCallLog(page);
    expect(commandCalls(calls, "copy_object_to")).toHaveLength(1);
    expect(commandCalls(calls, "delete_copied_objects")).toHaveLength(0);
    const durableMarker = commandCalls(calls, "save_transfer_manifest")
      .map((call) => call.args as { json?: string })
      .map((args) => (args.json ? JSON.parse(args.json) : null))
      .find((manifest) => manifest?.items?.[0]?.movePhase === "copied");
    expect(durableMarker?.items[0].receipts[0].ownership_ambiguous).toBe(true);
    await showTransferList(page);
    await page.locator("#transfer-more").click();
    await page
      .locator('.context-menu [role="menuitem"]', { hasText: "Retry failed" })
      .click();
    await expect(page.locator("#transfer-queue-summary")).toContainText(
      "1 failed",
    );
    const afterRetry = await readMockCallLog(page);
    expect(commandCalls(afterRetry, "copy_object_to")).toHaveLength(1);
    expect(commandCalls(afterRetry, "delete_copied_objects")).toHaveLength(0);
    await saveSuiteArtifact(
      page,
      testInfo,
      "frontend-safety",
      "ambiguous-copy-receipt",
      afterRetry,
    );
  });

  test("hydrates legacy copied receipts as ambiguous before source deletion", async ({
    page,
  }, testInfo) => {
    await installLayoutTauriMock(page, {
      objectCount: 1,
      prefixes: [],
      transferManifestJson: LEGACY_COPIED_MOVE_WITHOUT_OWNERSHIP_PROOF,
    });
    await page.goto("/");
    // Intentional: the recovery prompt is a choice (Resume / Discard / Decide later).
    await expect(page.locator("#dialog-title")).toHaveText(
      "Resume transfers from last session?",
    );
    await page
      .locator("#dialog-overlay")
      .getByRole("button", { name: "Resume", exact: true })
      .click();
    await expect(page.locator("#connection-screen")).toBeVisible();
    await connectMockListing(page);
    await expect
      .poll(async () => {
        const calls = await readMockCallLog(page);
        return commandCalls(calls, "save_transfer_manifest").length;
      })
      .toBeGreaterThan(0);
    await expect(page.locator("#transfer-queue-summary")).toContainText(
      "1 failed",
    );

    const calls = await readMockCallLog(page);
    expect(commandCalls(calls, "copy_object_to")).toHaveLength(0);
    expect(commandCalls(calls, "delete_copied_objects")).toHaveLength(0);
    const serializedRecovery = commandCalls(calls, "save_transfer_manifest")
      .map((call) => call.args as { json?: string })
      .map((args) => (args.json ? JSON.parse(args.json) : null))
      .find((manifest) => manifest?.items?.[0]?.movePhase === "copied");
    expect(serializedRecovery?.items[0].receipts[0].ownership_ambiguous).toBe(
      true,
    );
    await showTransferList(page);
    await page.locator("#transfer-more").click();
    await page
      .locator('.context-menu [role="menuitem"]', { hasText: "Retry failed" })
      .click();
    await expect(page.locator("#transfer-queue-summary")).toContainText(
      "1 failed",
    );
    const afterRetry = await readMockCallLog(page);
    expect(commandCalls(afterRetry, "copy_object_to")).toHaveLength(0);
    expect(commandCalls(afterRetry, "delete_copied_objects")).toHaveLength(0);
    await saveSuiteArtifact(
      page,
      testInfo,
      "frontend-safety",
      "legacy-ambiguous-copy-receipt",
      afterRetry,
    );
  });

  test("turns provider permission failures into friendly actionable status", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, {
      objectCount: 0,
      prefixes: [],
      errors: { create_folder: "HTTP 403 AccessDenied" },
    });

    await page.locator("#btn-new-folder").click();
    await expect(page.locator("#dialog-title")).toHaveText("New Folder");
    await page.locator("#dialog-input").fill("error-500-logs");
    await page.locator("#dialog-ok").click();

    await expect(page.locator("#status")).toHaveText(
      "Failed to create folder: Access denied. Check your credentials and permissions.",
    );
    await expect(page.locator("#dialog-overlay")).not.toHaveClass(/active/);
    const calls = await readMockCallLog(page);
    expect(commandCalls(calls, "create_folder")).toHaveLength(1);
    await saveSuiteArtifact(
      page,
      testInfo,
      "frontend-safety",
      "friendly-error",
      calls,
    );
  });

  test("keeps the unlock prompt open after a wrong password and updates state after retry", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, {
      security: { encryption_enabled: true, unlocked: true },
      unlockPasswords: ["correct-password"],
    });

    await page.locator("#settings-btn").click();
    await page.locator("#settings-tab-security").click();
    await expect(page.locator("#security-status-text")).toHaveText(
      "Encrypted (AES-256) and unlocked",
    );
    await expect(page.locator("#security-lock-btn")).toBeVisible();
    await page.locator("#security-lock-btn").click();
    await expect(page.locator("#connection-screen")).toBeVisible();
    await expect(page.locator("#main-layout")).not.toBeVisible();

    await page.locator("#settings-btn").click();
    await page.locator("#settings-tab-security").click();
    await expect(page.locator("#security-unlock-btn")).toBeVisible();
    await page.locator("#security-unlock-btn").click();
    await expect(page.locator("#lock-view")).toBeVisible();
    await page.locator("#lock-view-password").fill("wrong-password");
    await page.locator("#lock-view-unlock").click();
    await expect(page.locator("#lock-view")).toBeVisible();
    await expect(page.locator("#lock-view-error")).toHaveText(
      "That password is incorrect. Check caps lock and try again.",
    );
    await page.locator("#lock-view-password").fill("correct-password");
    await page.locator("#lock-view-unlock").click();
    await expect(page.locator("#lock-view")).toBeHidden();
    await expect(page.locator("#security-status-text")).toHaveText(
      "Encrypted (AES-256) and unlocked",
    );
    const calls = await readMockCallLog(page);
    expect(commandCalls(calls, "lock_security")).toHaveLength(1);
    expect(commandCalls(calls, "unlock_security")).toHaveLength(2);
    await saveSuiteArtifact(
      page,
      testInfo,
      "frontend-safety",
      "unlock-state",
      calls,
    );
  });

  test("refuses bookmark import when stored bookmarks could not be loaded", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, {
      objectCount: 0,
      prefixes: [],
      errors: {
        load_bookmarks: "Encrypted storage is locked.",
        load_bookmarks_backup: "Backup unavailable",
      },
    });

    await page.locator("#settings-btn").click();
    await page.locator("#settings-tab-bookmarks").click();
    await expect(page.locator("#bookmark-list .bookmark-empty")).toHaveText(
      "No bookmarks saved",
    );
    await page.locator("#bookmarks-import-input").setInputFiles({
      name: "bookmark.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify([BOOKMARK_A])),
    });
    await expect(page.locator("#dialog-title")).toHaveText("Import Failed");
    await expect(page.locator("#dialog-message")).toContainText(
      "Saved bookmarks could not be loaded",
    );
    await page.locator("#dialog-ok").click();
    const calls = await readMockCallLog(page);
    expect(commandCalls(calls, "save_bookmarks")).toHaveLength(0);
    expect(commandCalls(calls, "save_bookmarks_backup")).toHaveLength(0);
    await saveSuiteArtifact(
      page,
      testInfo,
      "frontend-safety",
      "bookmark-load-failure",
      calls,
    );
  });

  test("mutates bookmarks by identity and preserves the shifted row", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, {
      objectCount: 0,
      prefixes: [],
      bookmarks: [BOOKMARK_A, BOOKMARK_B],
    });

    await page.locator("#settings-btn").click();
    await page.locator("#settings-tab-bookmarks").click();
    await expect(page.locator("#bookmark-list .bookmark-item")).toHaveCount(2);
    await expect(page.locator("#bookmark-list")).toContainText("Alpha");
    await expect(page.locator("#bookmark-list")).toContainText("Beta");

    await page.locator("#bookmark-list .bookmark__delete").first().click();
    await expect(page.locator("#dialog-title")).toHaveText(
      "Delete saved connection",
    );
    await page.locator("#dialog-ok").click();
    await expect(page.locator("#bookmark-list .bookmark-item")).toHaveCount(1);
    await expect(page.locator("#bookmark-list")).toContainText("Beta");
    await expect(page.locator("#bookmark-list")).not.toContainText("Alpha");

    await page.locator("#bookmark-list .bookmark__delete").click();
    await expect(page.locator("#dialog-title")).toHaveText(
      "Delete saved connection",
    );
    await page.locator("#dialog-ok").click();
    await expect(page.locator("#bookmark-list .bookmark-empty")).toHaveText(
      "No bookmarks saved",
    );

    const calls = await readMockCallLog(page);
    const saves = commandCalls(calls, "save_bookmarks");
    expect(saves.length).toBeGreaterThanOrEqual(2);
    const payload = (saves[saves.length - 1].args as { json: string }).json;
    expect(JSON.parse(payload)).toEqual([]);
    await saveSuiteArtifact(
      page,
      testInfo,
      "frontend-safety",
      "bookmark-mutation",
      calls,
    );
  });

  test("runs queued work for a local endpoint while the browser reports offline", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, {
      endpoint: "http://127.0.0.1:9000",
      objectCount: 0,
      prefixes: ["archive/"],
      createOnlyCapabilities: FULL_CREATE_ONLY,
      listObjectsByPrefix: {
        "target/archive/": { objects: [], prefixes: [] },
      },
    });
    await page.evaluate(() => {
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        value: false,
      });
      window.dispatchEvent(new Event("offline"));
    });

    await openCopyMoveFromRow(
      page,
      page.locator(".object-row--folder").first(),
    );
    await page.locator("#copy-move-path").fill("target/archive/");
    await page.locator("#copy-move-copy-btn").click();

    await expect
      .poll(async () => {
        const calls = await readMockCallLog(page);
        return commandCalls(calls, "copy_prefix_to").length;
      })
      .toBe(1);
    const calls = await readMockCallLog(page);
    await saveSuiteArtifact(
      page,
      testInfo,
      "frontend-safety",
      "offline-local-endpoint",
      calls,
    );
  });

  test("connects to bracketed IPv6 loopback without a remote-HTTP warning", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { endpoint: "http://[::1]:9000" });
    await expect(page.locator("#main-layout")).toBeVisible();
    await expect(page.locator("#dialog-title")).not.toHaveText(
      "Insecure connection",
    );
    await saveSuiteArtifact(
      page,
      testInfo,
      "frontend-safety",
      "ipv6-loopback-connect",
      await readMockCallLog(page),
    );
  });

  test("an in-flight unlock cannot be canceled from the lock view, and a successful one does not relock", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, {
      security: { encryption_enabled: true, unlocked: true },
      unlockPasswords: ["correct-password"],
      deferUnlock: true,
    });

    await page.locator("#settings-btn").click();
    await page.locator("#settings-tab-security").click();
    await page.locator("#security-lock-btn").click();
    await page.locator("#settings-btn").click();
    await page.locator("#settings-tab-security").click();

    const locksBefore = commandCalls(
      await readMockCallLog(page),
      "lock_security",
    ).length;

    await page.locator("#security-unlock-btn").click();
    await expect(page.locator("#lock-view")).toBeVisible();
    await page.locator("#lock-view-password").fill("correct-password");
    await page.locator("#lock-view-unlock").click();
    await expect
      .poll(
        async () =>
          commandCalls(await readMockCallLog(page), "unlock_security").length,
      )
      .toBe(1);
    await expect(page.locator("#lock-view-continue")).toBeDisabled();
    await expect(page.locator("#lock-view-unlock")).toBeDisabled();
    await releaseMockUnlock(page);

    await expect(page.locator("#lock-view")).toBeHidden();
    await expect(page.locator("#security-status-text")).toHaveText(
      "Encrypted (AES-256) and unlocked",
    );
    const calls = await readMockCallLog(page);
    expect(commandCalls(calls, "lock_security")).toHaveLength(locksBefore);
    await saveSuiteArtifact(
      page,
      testInfo,
      "frontend-safety",
      "in-flight-unlock",
      calls,
    );
  });
});
