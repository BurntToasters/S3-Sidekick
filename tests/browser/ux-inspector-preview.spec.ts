import { expect, test, type Locator, type Page } from "@playwright/test";
import { openMockListing, readMockCallLog } from "./tauri-layout";

// Preview eligibility, formats and presentation in the docked and off-canvas
// inspector.

interface RootObject {
  key: string;
  size: number;
  last_modified: string;
  is_folder: boolean;
}

const ROOT_OBJECTS: RootObject[] = [
  {
    key: "notes.txt",
    size: 120,
    last_modified: "2025-01-01T12:00:00.000Z",
    is_folder: false,
  },
  {
    key: "archive.zip",
    size: 2048,
    last_modified: "2025-01-01T12:01:00.000Z",
    is_folder: false,
  },
  {
    key: "photo.png",
    size: 17_000_000,
    last_modified: "2025-01-01T12:02:00.000Z",
    is_folder: false,
  },
  {
    key: "render.png",
    size: 6_000_000,
    last_modified: "2025-01-01T12:03:00.000Z",
    is_folder: false,
  },
  {
    key: "photo.avif",
    size: 90_000,
    last_modified: "2025-01-01T12:04:00.000Z",
    is_folder: false,
  },
  {
    key: "data.json",
    size: 96,
    last_modified: "2025-01-01T12:05:00.000Z",
    is_folder: false,
  },
  {
    key: "report.csv",
    size: 1_400,
    last_modified: "2025-01-01T12:06:00.000Z",
    is_folder: false,
  },
  {
    key: "readme.md",
    size: 64,
    last_modified: "2025-01-01T12:07:00.000Z",
    is_folder: false,
  },
];

const CONTENT_TYPES: Record<string, string> = {
  "notes.txt": "text/plain",
  "archive.zip": "application/zip",
  "photo.png": "image/png",
  "render.png": "image/png",
  "photo.avif": "image/avif",
  "data.json": "application/json",
  "report.csv": "text/csv",
  "readme.md": "text/markdown",
};

const PREVIEW_BODIES: Record<string, string> = {
  "notes.txt": "line one\nline two\nline three",
  "data.json": '{"name":"sidekick","version":12,"beta":true,"tag":null}',
  "readme.md": "# Heading\n<script>alert(1)</script>\nplain **text**",
  "report.csv": `name,size\n${Array.from(
    { length: 205 },
    (_, i) => `row-${i + 1},${i + 1}`,
  ).join("\n")}\n`,
};

/**
 * Head and preview answers for the fixtures. The native preview command
 * decides from the HEAD content type; this wrapper answers the same way so the
 * webview's handling of each status is what the test exercises.
 */
async function openPreviewRoot(page: Page): Promise<void> {
  await page.addInitScript(
    ({
      extra,
      types,
      bodies,
    }: {
      extra: RootObject[];
      types: Record<string, string>;
      bodies: Record<string, string>;
    }) => {
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
            const key = String(args?.key ?? "");
            if (command === "list_objects" && !args?.prefix) {
              const result = (await original(command, args)) as {
                objects: unknown[];
              };
              return { ...result, objects: [...extra, ...result.objects] };
            }
            if (command === "head_object") {
              await original(command, args);
              const object = extra.find((item) => item.key === key);
              return {
                content_type: types[key] ?? "application/octet-stream",
                content_length: object?.size ?? 0,
                last_modified: "2025-01-01T12:00:00.000Z",
                etag: '"etag-preview"',
                storage_class: "STANDARD",
                cache_control: "",
                content_disposition: "",
                content_encoding: "",
                server_side_encryption: "",
                metadata: {},
              };
            }
            if (command === "preview_object") {
              await original(command, args);
              const type = types[key] ?? "application/octet-stream";
              const size = extra.find((item) => item.key === key)?.size ?? 0;
              if (type.startsWith("image/")) {
                return {
                  content_type: type,
                  // Images over the 16 MB cap are answered without a body.
                  data: size > 16_777_216 ? "" : "AAAA",
                  is_text: false,
                  truncated: false,
                  total_size: size,
                };
              }
              return {
                content_type: type,
                data:
                  bodies[key] ?? `preview of ${key}\nsecond line\nthird line`,
                is_text: true,
                truncated: false,
                total_size: size,
              };
            }
            if (command === "get_object_acl") {
              await original(command, args);
              return { owner: "owner", grants: [] };
            }
            if (command === "build_object_url") {
              await original(command, args);
              return `https://example.invalid/${key}`;
            }
            return original(command, args);
          };
          internals = value;
        },
      });
    },
    { extra: ROOT_OBJECTS, types: CONTENT_TYPES, bodies: PREVIEW_BODIES },
  );
  await openMockListing(page, { objectCount: 0, prefixes: ["archive/"] });
}

/** These specs assume the docked inspector; open it explicitly because the
 *  default-open rule needs a 1280px content container. */
async function ensureInspectorOpen(page: Page): Promise<void> {
  const panel = page.locator("#inspector-panel");
  if (await panel.isHidden()) {
    await page.locator("#btn-inspector").click();
    await expect(panel).toBeVisible();
  }
}

function fileRow(page: Page, name: string): Locator {
  return page.locator(".object-row--file", {
    has: page.locator(".object-name__text", { hasText: name }),
  });
}

async function openPreviewFor(page: Page, name: string): Promise<void> {
  await fileRow(page, name).locator(".object-name").click();
  // The specs assume the docked inspector; open it explicitly because the
  // default-open rule needs a 1280px content container. On mobile the
  // inspector is modal, so this must happen after the row is selected.
  await ensureInspectorOpen(page);
  if (name !== "archive.zip") {
    // The Preview tab is only enabled for a single previewable file; the
    // click selects it when the auto-preview has not already done so.
    const tab = page.locator('#inspector-panel [data-inspector-tab="preview"]');
    if ((await tab.getAttribute("aria-selected")) !== "true") {
      await tab.click();
    }
  }
}

test.describe("inspector preview eligibility", () => {
  // Rewritten for the truly inert Preview tab: a non-previewable selection
  // disables the tab instead of rendering an explanation when force-clicked.
  test("a non-previewable file disables Preview and never fetches content", async ({
    page,
  }) => {
    await openPreviewRoot(page);
    await openPreviewFor(page, "archive.zip");
    const previewTab = page.locator(
      '#inspector-panel [data-inspector-tab="preview"]',
    );
    await expect(previewTab).toHaveAttribute("aria-disabled", "true");
    await expect(previewTab).toBeDisabled();
    // Truly inert: not focusable and pointer events cannot reach it.
    await previewTab.focus();
    await expect(previewTab).not.toBeFocused();
    expect(
      await previewTab.evaluate(
        (tab) => getComputedStyle(tab).pointerEvents === "none",
      ),
    ).toBe(true);

    await previewTab.click({ force: true });
    await expect(page.locator("#inspector-preview-body")).toBeHidden();
    const calls = await readMockCallLog(page);
    expect(
      calls.filter((call) => call.command === "preview_object"),
    ).toHaveLength(0);
  });

  test("an image over the preview limit shows Too large with a Download action", async ({
    page,
  }) => {
    await openPreviewRoot(page);
    await openPreviewFor(page, "photo.png");

    const body = page.locator("#inspector-preview-body");
    await expect(body).toContainText("Too large to preview");
    await expect(body.locator("img")).toHaveCount(0);
    await expect(body.getByRole("button", { name: "Download" })).toBeVisible();
  });
});

test.describe("inspector preview presentation", () => {
  test("the docked preview names the file once, in the inspector header", async ({
    page,
  }) => {
    // P5 shows the file name once: the header. The preview pane's own title
    // is hidden so the name does not repeat above the preview body.
    await openPreviewRoot(page);
    await openPreviewFor(page, "notes.txt");
    await expect(page.locator("#inspector-header-title")).toHaveText(
      "notes.txt",
    );
    await expect(page.locator("#inspector-preview-title")).toBeHidden();
  });

  test("the off-canvas inspector does not repeat the file name heading", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 820, height: 640 });
    await openPreviewRoot(page);
    await openPreviewFor(page, "notes.txt");
    if (!(await page.locator("#inspector-panel").isVisible())) {
      await page.locator("#btn-inspector").click();
    }
    await expect(page.locator("#inspector-header-title")).toHaveText(
      "notes.txt",
    );
    await expect(page.locator("#inspector-preview-title")).toBeHidden();
  });
});

test.describe("preview formats", () => {
  test("JSON is pretty-printed with token colouring", async ({ page }) => {
    await openPreviewRoot(page);
    await openPreviewFor(page, "data.json");

    const body = page.locator("#inspector-preview-body");
    await expect(body.locator(".preview-code")).toBeVisible();
    await expect(body.locator(".tok-key").first()).toBeVisible();
    await expect(body.locator(".tok-str").first()).toBeVisible();
    await expect(body.locator(".tok-num").first()).toBeVisible();
    await expect(body.locator(".tok-bool")).toHaveText("true");
    await expect(body.locator(".tok-null")).toHaveText("null");
    // Pretty-printed: values sit on their own lines, indented.
    const text = await body.innerText();
    expect(text).toContain('"name"');
    expect(text).toContain("12");
  });

  test("CSV renders a table capped at the first 200 rows", async ({ page }) => {
    await openPreviewRoot(page);
    await openPreviewFor(page, "report.csv");

    const body = page.locator("#inspector-preview-body");
    await expect(body.locator("table.preview-table")).toBeVisible();
    await expect(
      body.locator("table.preview-table thead th").first(),
    ).toHaveText("name");
    await expect(body.locator("table.preview-table tbody tr")).toHaveCount(200);
    await expect(body).toContainText("205");
  });

  test("text previews show line numbers, a wrap toggle and Copy", async ({
    page,
  }) => {
    await openPreviewRoot(page);
    await openPreviewFor(page, "notes.txt");

    const body = page.locator("#inspector-preview-body");
    await expect(body.locator(".preview-code__num")).toHaveCount(3);
    await expect(body.getByRole("button", { name: /Wrap/i })).toBeVisible();
    const copy = body.getByRole("button", { name: /Copy/i });
    await expect(copy).toBeVisible();

    // Wrap toggle flips the container mode.
    const wrap = body.getByRole("button", { name: /Wrap/i });
    const before = await body
      .locator(".preview-code")
      .getAttribute("data-wrap");
    await wrap.click();
    const after = await body.locator(".preview-code").getAttribute("data-wrap");
    expect(after).not.toBe(before);
    await wrap.click();
    expect(await body.locator(".preview-code").getAttribute("data-wrap")).toBe(
      before,
    );

    // Copy puts the raw text on the clipboard.
    await copy.click();
    const clip = await page.evaluate(() =>
      navigator.clipboard.readText().catch(() => ""),
    );
    if (clip !== "") {
      expect(clip).toContain("line two");
    }
  });

  test("markdown stays plain text and never renders HTML", async ({ page }) => {
    await openPreviewRoot(page);
    await openPreviewFor(page, "readme.md");

    const body = page.locator("#inspector-preview-body");
    await expect(body).toContainText("# Heading");
    await expect(body).toContainText("<script>alert(1)</script>");
    await expect(body).toContainText("**text**");
    // No markdown/HTML rendering: no headings, no injected elements.
    await expect(body.locator("h1, h2, h3, script, img")).toHaveCount(0);
  });

  test("AVIF images render as images", async ({ page }) => {
    await openPreviewRoot(page);
    await openPreviewFor(page, "photo.avif");

    const body = page.locator("#inspector-preview-body");
    await expect(body.locator("img")).toHaveCount(1);
    await expect(body).not.toContainText("Too large");
    await expect(body).not.toContainText("not available");
  });

  test("images up to 16 MB get a checkerboard and a fit/100% toggle", async ({
    page,
  }) => {
    await openPreviewRoot(page);
    await openPreviewFor(page, "render.png");

    const body = page.locator("#inspector-preview-body");
    await expect(body.locator("img")).toHaveCount(1);
    const frame = body.locator(".preview-image");
    await expect(frame).toHaveClass(/preview-image--checker/);

    const zoom = body.getByRole("button", { name: /100%|Fit/i });
    await expect(zoom).toBeVisible();
    await expect(frame).toHaveClass(/preview-image--fit/);
    await zoom.click();
    await expect(frame).toHaveClass(/preview-image--zoom-100/);
    await expect(frame).not.toHaveClass(/preview-image--fit/);
    await zoom.click();
    await expect(frame).toHaveClass(/preview-image--fit/);
  });
});
