import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { saveArtifact } from "./helpers";
import {
  installLayoutTauriMock,
  openMockListing,
  readMockCallLog,
} from "./tauri-layout";

// Integration leftovers from the 0.12.0 UI/UX audit: selection kept across
// background refreshes, focus after delete, failed last-bucket restore,
// Keep editing selection, properties wrapping, transfer placeholder and
// Prioritize, the overwrite prompt for single downloads, and palette commands.

const SUITE = "ux-final-integration";

/** Save the screenshot and the observed values as the repeatable artifact. */
async function artifact(
  page: Page,
  testInfo: TestInfo,
  name: string,
  data: unknown,
): Promise<void> {
  await saveArtifact(page, testInfo, SUITE, name, [
    { command: "report", args: data },
  ]);
}

interface FinalWindow {
  __listingDelayMs?: number;
  __deletedKeys?: string[];
  __savePath?: string | null;
}

/** Install a native wrapper before the layout mock; the layout mock's
 *  `__TAURI_INTERNALS__` setter then wraps the same `invoke` (see
 *  ux-selection-safety.spec.ts). */
async function wrapNative<A>(
  page: Page,
  wrapper: (arg: A) => void,
  arg: A,
): Promise<void> {
  // Serialize the wrapper the same way Playwright does for function scripts.
  await page.addInitScript(`(${wrapper.toString()})(${JSON.stringify(arg)});`);
}

function rowByKey(page: Page, key: string): Locator {
  return page.locator(`#object-tbody .object-row[data-key="${key}"]`);
}

test.describe("selection and focus survive background work", () => {
  test("a transfer that finishes behind a slow listing keeps the selection and inspector", async ({
    page,
  }, testInfo) => {
    await wrapNative(
      page,
      () => {
        type Invoke = (
          command: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>;
        let internals: { invoke: Invoke } | undefined;
        Object.defineProperty(window, "__TAURI_INTERNALS__", {
          configurable: true,
          get: () => internals,
          set: (value: { invoke: Invoke }) => {
            const original = value.invoke;
            value.invoke = async (command, args) => {
              const holdMs = (window as unknown as FinalWindow)
                .__listingDelayMs;
              if (command === "list_objects" && holdMs) {
                await new Promise((resolve) => setTimeout(resolve, holdMs));
              }
              return original(command, args);
            };
            internals = value;
          },
        });
      },
      undefined,
    );
    await openMockListing(page, { objectCount: 6, prefixes: [] });

    const row = page.locator("#object-tbody .object-row--file").nth(1);
    const key = (await row.getAttribute("data-key")) ?? "";
    expect(key).not.toBe("");
    await row.locator(".object-name").click();
    await expect(row).toHaveAttribute("aria-selected", "true");
    const headerBefore = await page
      .locator("#inspector-header-title")
      .textContent();

    // A manual refresh holds the listing open; the upload finishes inside
    // that window, so its completion refresh must queue behind it.
    await page.evaluate(() => {
      (window as unknown as FinalWindow).__listingDelayMs = 900;
    });
    const listingsBefore = (await readMockCallLog(page)).filter(
      (call) => call.command === "list_objects",
    ).length;
    await page.locator("#btn-refresh").click();
    await page.evaluate(async () => {
      const url =
        performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .find((name) => /\/transfers\.ts(\?|$)/.test(name)) ??
        new URL("/transfers.ts", window.location.href).href;
      const mod = (await import(/* @vite-ignore */ url)) as {
        enqueueFiles(files: File[], targetPrefix: string): void;
      };
      const file = new File([new Uint8Array(1024)], "during-refresh.txt", {
        type: "text/plain",
      });
      mod.enqueueFiles([file], "");
    });

    await expect
      .poll(
        async () =>
          (await readMockCallLog(page)).filter(
            (call) => call.command === "list_objects",
          ).length,
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(listingsBefore + 2);
    await expect(page.locator("#status")).not.toContainText("failed", {
      timeout: 15_000,
    });
    await page.waitForTimeout(1200);

    await expect(rowByKey(page, key)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#inspector-header-title")).toHaveText(
      headerBefore ?? "",
    );

    await artifact(page, testInfo, "selection-after-refresh", {
      key,
      listingCalls: listingsBefore + 2,
    });
  });
});

test.describe("focus after delete", () => {
  test("delete leaves focus on the row at the same logical position", async ({
    page,
  }, testInfo) => {
    await wrapNative(
      page,
      () => {
        type Invoke = (
          command: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>;
        const deleted = new Set<string>();
        let internals: { invoke: Invoke } | undefined;
        Object.defineProperty(window, "__TAURI_INTERNALS__", {
          configurable: true,
          get: () => internals,
          set: (value: { invoke: Invoke }) => {
            const original = value.invoke;
            value.invoke = async (command, args) => {
              if (command === "delete_objects") {
                const keys = (args?.keys as string[] | undefined) ?? [];
                for (const key of keys) deleted.add(key);
                return {
                  deleted: keys.length,
                  failed: 0,
                  incomplete: false,
                  errors: [],
                };
              }
              if (command === "list_objects") {
                const result = (await original(command, args)) as {
                  objects: Array<{ key: string }>;
                };
                return {
                  ...result,
                  objects: result.objects.filter(
                    (object) => !deleted.has(object.key),
                  ),
                };
              }
              return original(command, args);
            };
            internals = value;
          },
        });
      },
      undefined,
    );
    await openMockListing(page, { objectCount: 6, prefixes: [] });

    const rows = page.locator("#object-tbody .object-row");
    const keysBefore = await rows.evaluateAll((elements) =>
      elements.map((element) => (element as HTMLElement).dataset.key ?? ""),
    );
    const fileIndexes = keysBefore
      .map((key, index) => ({ key, index }))
      .filter(({ key }) => key !== "" && !key.endsWith("/"));
    const target = fileIndexes[1];
    const expectedNext = keysBefore[target.index + 1];
    expect(expectedNext).toBeTruthy();

    await rowByKey(page, target.key).locator(".object-name").click();
    await expect(rowByKey(page, target.key)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    if (!(await page.locator("#batch-delete").isVisible())) {
      await page.locator("#inspector-close").click();
    }
    await page.locator("#batch-delete").click();
    await expect(page.locator("#dialog-overlay")).toBeVisible();
    await page.locator("#dialog-ok").click();
    await expect(page.locator("#dialog-overlay")).toBeHidden();

    await expect(rowByKey(page, target.key)).toHaveCount(0);
    await expect(
      page.locator("#object-tbody .object-row:focus"),
    ).toHaveAttribute("data-key", expectedNext);

    await artifact(page, testInfo, "focus-after-delete", {
      deleted: target.key,
      focused: expectedNext,
    });
  });
});

test.describe("failed bucket restore", () => {
  test("a remembered bucket that fails to list shows the inline Retry row", async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "s3-sidekick.last-bucket",
        "layout-test-bucket",
      );
    });
    await installLayoutTauriMock(page, {
      scenario: "error",
      objectCount: 0,
      prefixes: [],
    });
    await page.goto("/");
    await expect(page.locator("#connection-screen")).toBeVisible();
    await page.locator("#conn-endpoint").fill("https://layout-test.invalid");
    await page.locator("#conn-access-key").fill("layout-access-key");
    await page.locator("#conn-secret-key").fill("layout-secret-key");
    await page.locator("#connect-btn").click();

    const errorRow = page.locator('#object-tbody [data-nav-error="true"]');
    await expect(errorRow).toBeVisible();
    await expect(
      errorRow.locator("button", { hasText: "Retry" }),
    ).toBeVisible();
    await expect(page.locator("#object-tbody")).not.toContainText(
      "Empty folder",
    );

    await artifact(page, testInfo, "restore-failure-row", {
      text: (await errorRow.textContent()) ?? "",
    });
  });
});

test.describe("inspector keep editing", () => {
  test("Keep editing puts the table selection back on the edited file", async ({
    page,
  }, testInfo) => {
    await wrapNative(
      page,
      (extra: unknown[]) => {
        type Invoke = (
          command: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>;
        let internals: { invoke: Invoke } | undefined;
        Object.defineProperty(window, "__TAURI_INTERNALS__", {
          configurable: true,
          get: () => internals,
          set: (value: { invoke: Invoke }) => {
            const original = value.invoke;
            value.invoke = async (command, args) => {
              if (command === "list_objects" && !args?.prefix) {
                const result = (await original(command, args)) as {
                  objects: unknown[];
                };
                return { ...result, objects: [...extra, ...result.objects] };
              }
              if (command === "head_object") {
                await original(command, args);
                return {
                  content_type: "text/plain",
                  content_length: 120,
                  last_modified: "2025-01-01T12:00:00.000Z",
                  etag: '"etag-final"',
                  storage_class: "STANDARD",
                  cache_control: "",
                  content_disposition: "",
                  content_encoding: "",
                  server_side_encryption: "",
                  metadata: {},
                };
              }
              return original(command, args);
            };
            internals = value;
          },
        });
      },
      [
        {
          key: "notes.txt",
          size: 120,
          last_modified: "2025-01-01T12:00:00.000Z",
          is_folder: false,
        },
        {
          key: "data.json",
          size: 64,
          last_modified: "2025-01-01T12:01:00.000Z",
          is_folder: false,
        },
      ],
    );
    await openMockListing(page, { objectCount: 0, prefixes: [] });

    await rowByKey(page, "notes.txt").locator(".object-name").click();
    await page
      .locator('#inspector-panel [data-inspector-tab="properties"]')
      .click();
    await page.locator('#inspector-pane-info [data-tab="metadata"]').click();
    await page.locator("#metadata-add-row").click();
    await page.locator(".metadata-entry__key").last().fill("x-final");
    await page.locator(".metadata-entry__value").last().fill("pending");

    await rowByKey(page, "data.json").locator(".object-name").click();
    await expect(page.locator("#dialog-overlay")).toBeVisible();
    await expect(page.locator("#dialog-title")).toHaveText("Discard changes?");
    await page.locator("#dialog-cancel").click();
    await expect(page.locator("#dialog-overlay")).toBeHidden();

    await expect(rowByKey(page, "notes.txt")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(rowByKey(page, "data.json")).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await expect(page.locator("#inspector-header-title")).toHaveText(
      "notes.txt",
    );

    await artifact(page, testInfo, "keep-editing-selection", {
      selected: "notes.txt",
    });
  });
});

test.describe("properties wrapping", () => {
  for (const width of [1280, 820]) {
    test(`a long path and ETag wrap inside the panel at ${width}px`, async ({
      page,
    }, testInfo) => {
      const longKey = `archive-root/${"segment-of-a-long-path-".repeat(6)}final.txt`;
      const etag = `"${"0123456789abcdef".repeat(4)}-${"fedcba9876543210".repeat(2)}"`;
      await wrapNative(
        page,
        ({ longKey, etag }: { longKey: string; etag: string }) => {
          type Invoke = (
            command: string,
            args?: Record<string, unknown>,
          ) => Promise<unknown>;
          let internals: { invoke: Invoke } | undefined;
          Object.defineProperty(window, "__TAURI_INTERNALS__", {
            configurable: true,
            get: () => internals,
            set: (value: { invoke: Invoke }) => {
              const original = value.invoke;
              value.invoke = async (command, args) => {
                if (command === "list_objects" && !args?.prefix) {
                  const result = (await original(command, args)) as {
                    objects: unknown[];
                  };
                  return {
                    ...result,
                    objects: [
                      {
                        key: longKey,
                        size: 120,
                        last_modified: "2025-01-01T12:00:00.000Z",
                        is_folder: false,
                      },
                      ...result.objects,
                    ],
                  };
                }
                if (command === "head_object") {
                  await original(command, args);
                  return {
                    content_type: "text/plain",
                    content_length: 120,
                    last_modified: "2025-01-01T12:00:00.000Z",
                    etag,
                    storage_class: "STANDARD",
                    cache_control: "",
                    content_disposition: "",
                    content_encoding: "",
                    server_side_encryption: "",
                    metadata: {},
                  };
                }
                return original(command, args);
              };
              internals = value;
            },
          });
        },
        { longKey, etag },
      );
      await page.setViewportSize({ width, height: 800 });
      await openMockListing(page, { objectCount: 0, prefixes: [] });

      await rowByKey(page, longKey).locator(".object-name").click();
      // At <=900px the inspector is an off-canvas drawer that starts closed.
      if (!(await page.locator("#inspector-panel").isVisible())) {
        await page.locator("#btn-inspector").click();
      }
      await page
        .locator('#inspector-panel [data-inspector-tab="properties"]')
        .click();
      const values = page.locator(
        "#inspector-info-body .metadata-info-row__value",
      );
      await expect(values.first()).toBeVisible();

      const measured = await values.evaluateAll((elements) =>
        elements.map((element) => {
          const el = element as HTMLElement;
          const style = window.getComputedStyle(el);
          const lineHeight = parseFloat(style.lineHeight) || 16;
          return {
            text: el.textContent ?? "",
            height: el.getBoundingClientRect().height,
            lineHeight,
            overflowX: el.scrollWidth - el.clientWidth,
            wordBreak: style.wordBreak,
          };
        }),
      );
      const body = await page
        .locator("#inspector-info-body")
        .evaluate((element) => ({
          overflowX: element.scrollWidth - element.clientWidth,
        }));

      expect(body.overflowX).toBeLessThanOrEqual(1);
      for (const value of measured) {
        expect(value.overflowX).toBeLessThanOrEqual(1);
        expect(value.wordBreak).toBe("normal");
      }
      const path = measured.find((value) =>
        value.text.includes(longKey.slice(0, 20)),
      );
      const tag = measured.find((value) => value.text.includes("0123456789"));
      expect(path, "path row is rendered").toBeTruthy();
      expect(tag, "ETag row is rendered").toBeTruthy();
      expect(path!.height).toBeGreaterThan(path!.lineHeight * 1.5);
      expect(tag!.height).toBeGreaterThan(tag!.lineHeight * 1.5);

      await artifact(page, testInfo, `properties-wrap-${width}`, {
        width,
        body,
        measured,
      });
    });
  }
});

test.describe("transfers panel semantics", () => {
  test("the empty queue placeholder is not a list item and Prioritize explains why it is off", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 2, prefixes: [] });
    if (!(await page.locator("#bottom-drawer").isVisible())) {
      await page.locator("#transfer-toggle").click();
    }
    await page.locator("#drawer-tab-transfers").click();
    await expect(page.locator("#transfer-list")).toBeVisible();
    await expect(page.getByText("No transfers", { exact: true })).toBeVisible();

    await expect(page.locator('#transfer-list [role="listitem"]')).toHaveCount(
      0,
    );

    await page.locator("#transfer-more").click();
    const prioritize = page.locator('.context-menu [role="menuitem"]', {
      hasText: "Prioritize selected",
    });
    await expect(prioritize).toBeDisabled();
    const reasonId = await prioritize.getAttribute("aria-describedby");
    expect(reasonId).toBeTruthy();
    await expect(page.locator(`#${reasonId}`)).toContainText(
      "Select a queued transfer",
    );

    await artifact(page, testInfo, "transfers-placeholder-prioritize", {
      reason: (await page.locator(`#${reasonId}`).textContent()) ?? "",
    });
  });
});

test.describe("single download overwrite", () => {
  test("replacing an existing file is confirmed once, by the save dialog", async ({
    page,
  }, testInfo) => {
    await wrapNative(
      page,
      () => {
        type Invoke = (
          command: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>;
        let internals: { invoke: Invoke } | undefined;
        Object.defineProperty(window, "__TAURI_INTERNALS__", {
          configurable: true,
          get: () => internals,
          set: (value: { invoke: Invoke }) => {
            const original = value.invoke;
            value.invoke = async (command, args) => {
              if (command === "plugin:dialog|save") {
                return "/tmp/s3-final/notes.txt";
              }
              if (command === "path_exists") return true;
              return original(command, args);
            };
            internals = value;
          },
        });
      },
      undefined,
    );
    await openMockListing(page, { objectCount: 3, prefixes: [] });
    const row = page.locator("#object-tbody .object-row--file").first();
    await row.locator(".object-name").click();
    await page.locator("#batch-download").click();

    await expect
      .poll(
        async () =>
          (await readMockCallLog(page)).some((call) =>
            call.command.startsWith("download_object"),
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    await expect(page.locator("#dialog-overlay")).toBeHidden();

    await artifact(page, testInfo, "single-download-overwrite", {
      prompts: 0,
    });
  });
});

test.describe("command palette", () => {
  test("Refresh Buckets runs from the palette", async ({ page }, testInfo) => {
    await openMockListing(page, { objectCount: 2, prefixes: [] });
    const before = (await readMockCallLog(page)).filter(
      (call) => call.command === "list_buckets",
    ).length;
    await page.locator("#btn-palette").click();
    await expect(page.locator("#palette-overlay")).toBeVisible();
    await page.locator("#palette-input").fill("Refresh Buckets");
    const item = page.locator("#palette-results .palette__item", {
      hasText: "Refresh Buckets",
    });
    await expect(item).toBeVisible();
    await page.keyboard.press("Enter");
    await expect
      .poll(
        async () =>
          (await readMockCallLog(page)).filter(
            (call) => call.command === "list_buckets",
          ).length,
        { timeout: 10_000 },
      )
      .toBeGreaterThan(before);

    await artifact(page, testInfo, "palette-refresh-buckets", {
      listBucketsCalls: before + 1,
    });
  });
});

test.describe("pointer target floors", () => {
  test("icon and small buttons meet the 32px and 28px floors", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 3, prefixes: [] });

    const measured = await page
      .locator(".btn--icon, .btn--sm")
      .evaluateAll((elements) =>
        elements
          .filter((element) => element.getClientRects().length > 0)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              id:
                element.id !== ""
                  ? element.id
                  : (element.getAttribute("aria-label") ?? ""),
              classes: element.className,
              width: Math.round(rect.width * 10) / 10,
              height: Math.round(rect.height * 10) / 10,
            };
          }),
      );

    expect(measured.length, "compact buttons are rendered").toBeGreaterThan(0);
    const violations = measured.filter((button) => {
      if (button.classes.includes("btn--icon")) {
        return button.width < 32 || button.height < 32;
      }
      return button.height < 28;
    });
    expect(violations, "buttons below the pointer target floor").toEqual([]);

    await artifact(page, testInfo, "pointer-target-floors", {
      measuredCount: measured.length,
    });
  });
});

// Measured in the page: the text colour and the background it actually sits
// on, with translucent ancestor layers composited over the canvas.
interface TextPaint {
  color: string;
  background: string;
}

async function measureTextPaint(locator: Locator): Promise<TextPaint> {
  return locator.evaluate((element: Element): TextPaint => {
    interface Layer {
      r: number;
      g: number;
      b: number;
      a: number;
    }
    const parse = (value: string): Layer => {
      const match = /rgba?\(([^)]+)\)/.exec(value);
      if (!match) return { r: 0, g: 0, b: 0, a: 0 };
      const parts = match[1].split(",").map((part) => Number(part.trim()));
      return {
        r: parts[0] ?? 0,
        g: parts[1] ?? 0,
        b: parts[2] ?? 0,
        a: parts[3] ?? 1,
      };
    };
    const layers: Layer[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const layer = parse(getComputedStyle(node).backgroundColor);
      if (layer.a > 0) layers.push(layer);
      if (layer.a >= 1) break;
    }
    let base: Layer = { r: 255, g: 255, b: 255, a: 1 };
    for (const layer of layers.reverse()) {
      base = {
        r: layer.r * layer.a + base.r * (1 - layer.a),
        g: layer.g * layer.a + base.g * (1 - layer.a),
        b: layer.b * layer.a + base.b * (1 - layer.a),
        a: 1,
      };
    }
    return {
      color: getComputedStyle(element).color,
      background: `rgb(${base.r}, ${base.g}, ${base.b})`,
    };
  });
}

function channelsOf(value: string): [number, number, number] {
  const match = /rgba?\(([^)]+)\)/.exec(value);
  if (!match) throw new Error(`unparseable colour: ${value}`);
  const [r, g, b] = match[1].split(",").map((part) => Number(part.trim()));
  return [r ?? 0, g ?? 0, b ?? 0];
}

function relativeLuminance(value: string): number {
  const [r, g, b] = channelsOf(value).map((channel) => {
    const unit = channel / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test.describe("0.12.0 residue: contrast, targets, palette, resizers", () => {
  test("dark theme: the active Properties tab keeps 4.5:1 while hovered", async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await openMockListing(page, {
      objectCount: 3,
      prefixes: [],
      settings: { theme: "dark" },
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page
      .locator("#object-tbody .object-row--file .object-name")
      .first()
      .click();
    if (!(await page.locator("#inspector-panel").isVisible())) {
      await page.locator("#btn-inspector").click();
    }
    const properties = page.locator("#inspector-tab-properties");
    await properties.click();
    await expect(properties).toHaveClass(/inspector-tab--active/);

    await properties.hover();
    const hovered = await measureTextPaint(properties);
    await page.mouse.move(0, 0);
    const rested = await measureTextPaint(properties);

    const hoveredRatio = contrastRatio(hovered.color, hovered.background);
    const restedRatio = contrastRatio(rested.color, rested.background);
    await artifact(page, testInfo, "dark-active-tab-contrast", {
      hovered: { ...hovered, ratio: hoveredRatio },
      rested: { ...rested, ratio: restedRatio },
    });
    expect(hoveredRatio, "hovered active tab contrast").toBeGreaterThanOrEqual(
      4.5,
    );
    expect(restedRatio, "resting active tab contrast").toBeGreaterThanOrEqual(
      4.5,
    );
  });

  test("light theme: the bucket-open error row and Disconnect reach 4.5:1", async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "s3-sidekick.last-bucket",
        "layout-test-bucket",
      );
    });
    await installLayoutTauriMock(page, {
      scenario: "error",
      objectCount: 0,
      prefixes: [],
      settings: { theme: "light" },
    });
    await page.goto("/");
    await expect(page.locator("#connection-screen")).toBeVisible();
    await page.locator("#conn-endpoint").fill("https://layout-test.invalid");
    await page.locator("#conn-access-key").fill("layout-access-key");
    await page.locator("#conn-secret-key").fill("layout-secret-key");
    await page.locator("#connect-btn").click();
    const errorText = page.locator(
      '#object-tbody [data-nav-error="true"] .table-error',
    );
    await expect(errorText).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    const error = await measureTextPaint(errorText);
    const disconnect = await measureTextPaint(page.locator("#disconnect-btn"));
    const errorRatio = contrastRatio(error.color, error.background);
    const disconnectRatio = contrastRatio(
      disconnect.color,
      disconnect.background,
    );
    await artifact(page, testInfo, "light-error-contrast", {
      error: { ...error, ratio: errorRatio },
      disconnect: { ...disconnect, ratio: disconnectRatio },
    });
    expect(errorRatio, "error row contrast").toBeGreaterThanOrEqual(4.5);
    expect(disconnectRatio, "Disconnect contrast").toBeGreaterThanOrEqual(4.5);
  });

  test("checkbox hit areas: points 11px from centre land on the control or its cell", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 3, prefixes: [] });
    const targets = [
      page.locator("#select-all"),
      page.locator("#object-tbody .row-check").first(),
    ];
    const report: Record<string, unknown> = {};
    for (const target of targets) {
      const id = (await target.getAttribute("id")) ?? "row-check";
      const result = await target.evaluate((input: HTMLInputElement) => {
        const rect = input.getBoundingClientRect();
        const centreX = rect.left + rect.width / 2;
        const centreY = rect.top + rect.height / 2;
        const cell = input.closest("td, th, label");
        const misses: string[] = [];
        for (const dx of [-11, 11]) {
          for (const dy of [-11, 11]) {
            const hit = document.elementFromPoint(centreX + dx, centreY + dy);
            const onTarget =
              hit === input || (hit !== null && cell?.contains(hit) === true);
            if (!onTarget) misses.push(`${dx},${dy} -> ${hit?.tagName}`);
          }
        }
        return { misses };
      });
      report[id] = result;
      expect(result.misses, `${id} hit area`).toEqual([]);
    }
    await artifact(page, testInfo, "checkbox-hit-areas-table", report);
  });

  test("checkbox hit areas: settings and setup-wizard checkboxes", async ({
    page,
  }, testInfo) => {
    await installLayoutTauriMock(page, {
      objectCount: 0,
      prefixes: [],
      settings: { _setupComplete: false, autoCheckUpdates: true },
      security: { initialized: false, encryption_enabled: false },
    });
    await page.goto("/");
    await expect(page.locator("#setup-wizard-overlay")).toBeVisible();
    await page.locator("#setup-welcome-next").click();
    await page.locator("#setup-theme-next").click();
    await page.locator("#setup-enc-skip").click();
    const setupBox = page.locator("#setup-auto-updates");
    await expect(setupBox).toBeVisible();

    const report: Record<string, unknown> = {};
    const measureHits = async (input: Locator): Promise<unknown> =>
      input.evaluate((element: HTMLInputElement) => {
        const rect = element.getBoundingClientRect();
        const centreX = rect.left + rect.width / 2;
        const centreY = rect.top + rect.height / 2;
        const cell = element.closest("td, th, label");
        const misses: string[] = [];
        for (const dx of [-11, 11]) {
          for (const dy of [-11, 11]) {
            const hit = document.elementFromPoint(centreX + dx, centreY + dy);
            const onTarget =
              hit === element || (hit !== null && cell?.contains(hit) === true);
            if (!onTarget) misses.push(`${dx},${dy} -> ${hit?.tagName}`);
          }
        }
        return { misses };
      });

    const setupResult = (await measureHits(setupBox)) as { misses: string[] };
    report["setup-auto-updates"] = setupResult;
    expect(setupResult.misses, "setup-auto-updates hit area").toEqual([]);

    await page.locator("#setup-updates-next").click();
    await page.locator("#setup-done-btn").click();
    await expect(page.locator("#setup-wizard-overlay")).toBeHidden();

    await page.locator("#settings-btn").click();
    for (const [tab, id] of [
      ["transfers", "setting-confirm-unguarded-writes"],
      ["updates", "setting-updates"],
    ] as const) {
      await page.locator(`#settings-tab-${tab}`).click();
      const box = page.locator(`#${id}`);
      await expect(box).toBeVisible();
      const result = (await measureHits(box)) as { misses: string[] };
      report[id] = result;
      expect(result.misses, `${id} hit area`).toEqual([]);
    }
    await artifact(page, testInfo, "checkbox-hit-areas-settings", report);
  });

  test("clicking the empty part of a row's checkbox cell toggles that row", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 3, prefixes: [] });
    const row = page.locator("#object-tbody .object-row").first();
    const cell = row.locator(".col-check");
    const box = await cell.boundingBox();
    expect(box, "checkbox cell is rendered").not.toBeNull();
    await page.mouse.click(box!.x + 3, box!.y + 3);
    await expect(row.locator(".row-check")).toBeChecked();
    await artifact(page, testInfo, "row-cell-toggle", {
      cellWidth: box!.width,
    });
  });

  test("the palette search input is at least 24px tall", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 1, prefixes: [] });
    await page.locator("#btn-palette").click();
    const input = page.locator("#palette-input");
    await expect(input).toBeVisible();
    // offsetHeight is layout height; the palette fades in with a transform,
    // which would make getBoundingClientRect read a scaled box mid-animation.
    const height = await input.evaluate(
      (element: HTMLInputElement) => element.offsetHeight,
    );
    expect(height, "palette input height").toBeGreaterThanOrEqual(24);
    await artifact(page, testInfo, "palette-input-height", { height });
  });

  test("sidebar and inspector separators resize from the keyboard", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 1, prefixes: [] });
    const sidebarResizer = page.locator("#sidebar-resizer");
    const sidebar = sidebarResizer.locator("xpath=preceding-sibling::*[1]");
    const before = (await sidebar.boundingBox())?.width ?? 0;
    await sidebarResizer.focus();
    await page.keyboard.press("ArrowRight");
    const afterSidebar = (await sidebar.boundingBox())?.width ?? 0;
    expect(afterSidebar, "ArrowRight widens the sidebar").toBeGreaterThan(
      before,
    );

    if (!(await page.locator("#inspector-panel").isVisible())) {
      await page.locator("#btn-inspector").click();
    }
    const inspectorResizer = page.locator("#inspector-resizer");
    const inspector = page.locator("#inspector-panel");
    const inspectorBefore = (await inspector.boundingBox())?.width ?? 0;
    await inspectorResizer.focus();
    await page.keyboard.press("ArrowLeft");
    const inspectorAfter = (await inspector.boundingBox())?.width ?? 0;
    expect(inspectorAfter, "ArrowLeft widens the inspector").toBeGreaterThan(
      inspectorBefore,
    );
    await artifact(page, testInfo, "separators-keyboard", {
      sidebar: { before, afterSidebar },
      inspector: { before: inspectorBefore, after: inspectorAfter },
    });
  });
});
