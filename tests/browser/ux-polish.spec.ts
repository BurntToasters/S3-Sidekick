// Failure modes covered before implementation (UI/UX audit 0.12.0, polish):
// - A copy/move refused by the transfer queue closes the dialog, clears the
//   selection and reports "Queued" anyway.
// - An accepted copy/move reports "Queued 1 copy transfer(s)." instead of the
//   item count, and the "(s)" placeholder leaks into the status line.
// - The Recent destinations heading must stay hidden when there are none.
// - Text in the accent and danger roles uses fills (--accent, --danger), which
//   fail WCAG AA as text in the dark and light themes.
// - Text under 11px survives in the header and modal overlays (for example the
//   password reveal button at 0.75rem).
// - Bookmark chips are 24px, not the 28px target, and the bookmark delete
//   control is under 24px.
// - Buttons without a type attribute remain in the header, connection screen
//   and modal overlays.
// - The transfer indeterminate bar freezes at 35% under reduced motion and
//   reads as real progress.
// - The settings sidebar landmark has no accessible name.
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  countOf,
  openCopyMoveFromRow,
  saveArtifact as saveSuiteArtifact,
} from "./helpers";
import {
  connectMockListing,
  installLayoutTauriMock,
  openMockListing,
  readMockCallLog,
} from "./tauri-layout";

const SUITE = "ux-polish";

/**
 * Pending recovery state from a previous session. Connecting with it raises
 * the "Resume transfers from last session?" prompt, which blocks new queueing.
 */
const PENDING_MANIFEST = JSON.stringify({
  version: 6,
  items: [
    {
      operation: "download",
      bucket: "layout-test-bucket",
      fileName: "report.csv",
      filePath: "",
      key: "reports/report.csv",
      destination: "/tmp/report.csv",
      size: 0,
      totalBytes: 0,
      attempt: 1,
      maxAttempts: 1,
      conflictResolution: "ask",
      resumable: true,
      checkpointId: "ckpt-report-csv",
      completedParts: 0,
      totalParts: 0,
    },
  ],
});

const ENDPOINT = "https://layout-test.invalid";

/** Overlays and header that this area owns; every text node must be 11px or more. */
const OWNED_ROOTS = [
  "header",
  "#connection-screen",
  "#settings-overlay",
  "#dialog-overlay",
  "#copy-move-overlay",
  "#licenses-overlay",
  "#support-overlay",
  "#setup-wizard-overlay",
];

/**
 * The recovery prompt is shown at startup and again when a connection starts
 * while recovery is still unresolved. Answer each one with Escape ("Decide
 * later"), which keeps the manifest and leaves queueing refused.
 */
async function declineRecoveryPrompt(page: Page): Promise<void> {
  const overlay = page.locator("#dialog-overlay");
  await page.waitForFunction(() => {
    const dialogOverlay = document.getElementById("dialog-overlay");
    const main = document.getElementById("main-layout");
    return (
      dialogOverlay?.classList.contains("active") === true ||
      (main !== null && main.offsetParent !== null)
    );
  });
  if (!(await overlay.evaluate((el) => el.classList.contains("active")))) {
    return;
  }
  await expect(page.locator("#dialog-title")).toHaveText(
    "Resume transfers from last session?",
  );
  await page.keyboard.press("Escape");
  await expect(overlay).not.toHaveClass(/active/);
}

async function connectWithPendingRecovery(page: Page): Promise<void> {
  await declineRecoveryPrompt(page);
  await expect(page.locator("#connection-screen")).toBeVisible();
  await page.locator("#conn-endpoint").fill(ENDPOINT);
  await page.locator("#conn-access-key").fill("layout-access-key");
  await page.locator("#conn-secret-key").fill("layout-secret-key");
  await page.locator("#connect-btn").click();
  await declineRecoveryPrompt(page);
  await expect(page.locator("#main-layout")).toBeVisible();
  const bucket = page.locator("#bucket-list .list__item-btn").first();
  await expect(bucket).toBeVisible();
  await bucket.click();
  await expect(page.locator("#object-panel")).toBeVisible();
}

test.describe("copy and move reports the queue's answer", () => {
  test("a refused copy keeps the dialog and selection open with the reason", async ({
    page,
  }, testInfo: TestInfo) => {
    await installLayoutTauriMock(page, {
      transferManifestJson: PENDING_MANIFEST,
    });
    await page.goto("/");
    await connectWithPendingRecovery(page);

    const row = page.locator(".object-row--file").first();
    await openCopyMoveFromRow(page, row);
    await page.locator("#copy-move-path").fill("destination/");
    await page.locator("#copy-move-copy-btn").click();

    await expect(page.locator("#copy-move-error")).toContainText(
      "not resolved yet",
    );
    await expect(page.locator("#copy-move-overlay")).toHaveClass(/active/);
    await expect(row.locator(".row-check")).toBeChecked();
    await expect(page.locator("#status")).not.toContainText("Queued");
    await expect(page.locator("#copy-move-copy-btn")).toBeEnabled();

    const calls = await readMockCallLog(page);
    expect(countOf(calls, "copy_object_to")).toBe(0);
    await saveSuiteArtifact(
      page,
      testInfo,
      SUITE,
      "copy-refused-by-recovery",
      calls,
    );
  });

  test("an accepted copy reports the item count without a plural placeholder", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, {});
    await page.goto("/");
    await connectMockListing(page);

    await openCopyMoveFromRow(page, page.locator(".object-row--file").first());
    await page.locator("#copy-move-path").fill("destination/");
    await page.locator("#copy-move-copy-btn").click();
    await expect(page.locator("#copy-move-overlay")).not.toHaveClass(/active/);
    await expect(page.locator("#status")).toContainText("Queued 1 item");
    await expect(page.locator("#status")).not.toContainText("(s)");
  });

  test("Recent destinations stays hidden when there are no recent destinations", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, {});
    await page.goto("/");
    await connectMockListing(page);

    await openCopyMoveFromRow(page, page.locator(".object-row--file").first());
    await expect(page.locator("#copy-move-recent-wrap")).toBeHidden();
    await expect(page.getByText("Recent destinations")).toBeHidden();
  });
});

test.describe("text tokens and target sizes", () => {
  test("accent and danger text use the text-safe tokens in both themes", async ({
    page,
  }) => {
    await page.goto("/");
    const cases = [
      {
        name: "active settings tab (dark)",
        theme: "dark",
        html: '<button class="settings-tab settings-tab--active">x</button>',
        selector: ".settings-tab--active",
        token: "--accent-fg",
      },
      {
        name: "active bookmark chip (dark)",
        theme: "dark",
        html: '<span class="bookmark-chip bookmark-chip--active">x</span>',
        selector: ".bookmark-chip--active",
        token: "--accent-fg",
      },
      {
        name: "license tag (dark)",
        theme: "dark",
        html: '<span class="license-card__tag">x</span>',
        selector: ".license-card__tag",
        token: "--accent-fg",
      },
      {
        name: "license body link (dark)",
        theme: "dark",
        html: '<div class="license-card__body"><a href="#">x</a></div>',
        selector: "a",
        token: "--accent-fg",
      },
      {
        name: "copy/move breadcrumb (dark)",
        theme: "dark",
        html: '<div class="copy-move-browser-crumbs"><button type="button">x</button></div>',
        selector: "button",
        token: "--accent-fg",
      },
      {
        name: "danger button text (light)",
        theme: "light",
        html: '<button type="button" class="btn btn--danger">x</button>',
        selector: ".btn--danger",
        token: "--danger-text",
      },
      {
        name: "validation error (light)",
        theme: "light",
        html: '<p class="dialog-validation-error">x</p>',
        selector: ".dialog-validation-error",
        token: "--danger-text",
      },
      {
        name: "settings save error (light)",
        theme: "light",
        html: '<span class="settings-save-error">x</span>',
        selector: ".settings-save-error",
        token: "--danger-text",
      },
      {
        name: "security warning (light)",
        theme: "light",
        html: '<div class="security-warning">x</div>',
        selector: ".security-warning",
        token: "--danger-text",
      },
    ];

    const results = await page.evaluate((list) => {
      const root = document.documentElement;
      return list.map((c) => {
        root.setAttribute("data-theme", c.theme);
        const host = document.createElement("div");
        host.innerHTML = c.html;
        document.body.appendChild(host);
        const el = host.querySelector(c.selector) as HTMLElement;
        const probe = document.createElement("span");
        probe.style.color = `var(${c.token})`;
        host.appendChild(probe);
        const out = {
          name: c.name,
          actual: getComputedStyle(el).color,
          expected: getComputedStyle(probe).color,
        };
        host.remove();
        return out;
      });
    }, cases);
    const mismatched = results.filter((r) => r.actual !== r.expected);
    expect(mismatched).toEqual([]);
  });

  test("text in the header and modal overlays is at least 11px", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("#connection-screen")).toBeVisible();
    const offenders = await page.evaluate((roots) => {
      const found: string[] = [];
      for (const sel of roots) {
        const scope = document.querySelector(sel);
        if (!scope) continue;
        for (const el of scope.querySelectorAll<HTMLElement>("*")) {
          const hasText = [...el.childNodes].some(
            (node) =>
              node.nodeType === Node.TEXT_NODE &&
              (node.textContent ?? "").trim() !== "",
          );
          if (!hasText) continue;
          const size = parseFloat(getComputedStyle(el).fontSize);
          if (size < 11) {
            found.push(
              `${el.tagName.toLowerCase()}#${el.id}.${el.className}: ${size}px`,
            );
          }
        }
      }
      return found;
    }, OWNED_ROOTS);
    expect(offenders).toEqual([]);
  });

  test("bookmark chips are 28px tall and the bookmark delete control is 24px", async ({
    page,
  }) => {
    await page.goto("/");
    const sizes = await page.evaluate(() => {
      const bar = document.getElementById("bookmark-bar") as HTMLElement;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "bookmark-chip";
      chip.textContent = "Production";
      bar.appendChild(chip);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "bookmark__delete";
      remove.textContent = "×";
      document.body.appendChild(remove);
      const chipBox = chip.getBoundingClientRect();
      const removeBox = remove.getBoundingClientRect();
      return {
        chipHeight: chipBox.height,
        removeWidth: removeBox.width,
        removeHeight: removeBox.height,
      };
    });
    expect(sizes.chipHeight).toBeGreaterThanOrEqual(28);
    expect(sizes.removeWidth).toBeGreaterThanOrEqual(24);
    expect(sizes.removeHeight).toBeGreaterThanOrEqual(24);
  });

  test("every button in the owned header and overlays has an explicit type", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("#connection-screen")).toBeVisible();
    const untyped = await page.evaluate((roots) => {
      const found: string[] = [];
      for (const sel of roots) {
        const scope = document.querySelector(sel);
        if (!scope) continue;
        const buttons = scope.querySelectorAll("button:not([type])");
        for (const button of buttons) {
          found.push(`${sel} ${button.id || button.className}`);
        }
      }
      return found;
    }, OWNED_ROOTS);
    expect(untyped).toEqual([]);
  });

  test("the indeterminate transfer bar fills its track under reduced motion", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const ratio = await page.evaluate(() => {
      const wrap = document.createElement("div");
      wrap.className =
        "transfer-progress-wrap transfer-progress-wrap--indeterminate";
      wrap.innerHTML =
        '<div class="transfer-progress"><div class="transfer-progress__bar"></div></div>';
      document.body.appendChild(wrap);
      const bar = wrap.querySelector(".transfer-progress__bar") as HTMLElement;
      const track = wrap.querySelector(".transfer-progress") as HTMLElement;
      const result =
        bar.getBoundingClientRect().width / track.getBoundingClientRect().width;
      wrap.remove();
      return result;
    });
    expect(ratio).toBeGreaterThan(0.9);
  });

  test("the settings sidebar has an accessible name", async ({ page }) => {
    await page.goto("/");
    const label = await page
      .locator("#settings-overlay aside")
      .first()
      .getAttribute("aria-label");
    expect(label).toBeTruthy();
  });
});

const savedConnections = [
  {
    name: "Production",
    endpoint: ENDPOINT,
    region: "us-east-1",
    access_key: "layout-access-key",
    secret_key: "stored-secret",
  },
];

/** Real token values from src/styles/tokens.css, one set per theme. */
const PREVIEW_TOKENS = {
  light: {
    bg: "#f4f4f5",
    surface: "#ffffff",
    accent: "#4f46e5",
    text: "#09090b",
  },
  dark: {
    bg: "#09090b",
    surface: "#18181b",
    accent: "#818cf8",
    text: "#fafafa",
  },
} as const;

async function openSettingsTab(page: Page, tab: string): Promise<void> {
  await page.locator("#settings-btn").click();
  await expect(page.locator("#settings-overlay")).toHaveClass(/active/);
  await page.locator(`#settings-tab-${tab}`).click();
}

test.describe("theme previews, help tips, header and selects", () => {
  test("theme previews expose the real light and dark token values", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, { objectCount: 0, prefixes: [] });
    await page.goto("/");
    await expect(page.locator("#connection-screen")).toBeVisible();
    await openSettingsTab(page, "appearance");

    for (const theme of ["light", "dark"] as const) {
      const preview = page.locator(`.theme-card-preview--${theme}`);
      await expect(preview).toBeVisible();
      const values = await preview.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          bg: style.getPropertyValue("--preview-bg").trim().toLowerCase(),
          surface: style
            .getPropertyValue("--preview-surface")
            .trim()
            .toLowerCase(),
          accent: style
            .getPropertyValue("--preview-accent")
            .trim()
            .toLowerCase(),
          text: style.getPropertyValue("--preview-text").trim().toLowerCase(),
        };
      });
      expect(values, `${theme} preview`).toEqual(PREVIEW_TOKENS[theme]);
    }
  });

  test("wizard theme swatches show the real light and dark surfaces", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, {
      objectCount: 0,
      prefixes: [],
      settings: { _setupComplete: false, autoCheckUpdates: true },
      security: { initialized: false, encryption_enabled: false },
    });
    await page.goto("/");
    await expect(page.locator("#setup-wizard-overlay")).toBeVisible();
    await page.locator("#setup-welcome-next").click();
    await expect(page.locator("#setup-theme-next")).toBeVisible();

    const backgrounds = async (name: string) =>
      page
        .locator(`.setup-wizard-theme-btn__swatch--${name}`)
        .evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(await backgrounds("light")).toContain("rgb(244, 244, 245)");
    expect(await backgrounds("light")).toContain("rgb(255, 255, 255)");
    expect(await backgrounds("dark")).toContain("rgb(9, 9, 11)");
    expect(await backgrounds("dark")).toContain("rgb(24, 24, 27)");
    // The system swatch splits light background and dark surface on the diagonal.
    expect(await backgrounds("system")).toContain("rgb(244, 244, 245)");
    expect(await backgrounds("system")).toContain("rgb(24, 24, 27)");
  });

  test("help buttons are 24px and their tooltip stays inside the settings pane", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, { objectCount: 0, prefixes: [] });
    await page.goto("/");
    await expect(page.locator("#connection-screen")).toBeVisible();
    await openSettingsTab(page, "updates");

    const pane = page.locator(".settings-content");
    await pane.evaluate((el) => {
      el.scrollTop = 0;
    });
    const help = page.locator(".setting-help:visible").first();
    await expect(help).toBeVisible();
    const box = await help.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);

    await help.hover();
    const tip = page
      .locator(".setting-help-wrap:visible .setting-help__tip")
      .first();
    await expect(tip).toBeVisible();
    const [paneBox, tipBox] = await Promise.all([
      pane.boundingBox(),
      tip.boundingBox(),
    ]);
    expect(paneBox).not.toBeNull();
    expect(tipBox).not.toBeNull();
    expect(tipBox?.y ?? -1, "tooltip top").toBeGreaterThanOrEqual(
      paneBox?.y ?? 0,
    );
    expect(
      (tipBox?.y ?? 0) + (tipBox?.height ?? 0),
      "tooltip bottom",
    ).toBeLessThanOrEqual((paneBox?.y ?? 0) + (paneBox?.height ?? 0));

    const background = await tip.evaluate((el) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--tooltip-bg)";
      document.body.appendChild(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return { actual: getComputedStyle(el).backgroundColor, resolved };
    });
    expect(background.actual).toBe(background.resolved);
  });

  test("settings select values fit their boxes at 1280px and 820px", async ({
    page,
  }) => {
    const tabs = [
      "appearance",
      "updates",
      "transfers",
      "sharing",
      "bookmarks",
      "security",
      "about",
    ];
    for (const width of [1280, 820]) {
      await page.setViewportSize({ width, height: 800 });
      await installLayoutTauriMock(page, { objectCount: 0, prefixes: [] });
      await page.goto("/");
      await expect(page.locator("#connection-screen")).toBeVisible();

      const misfits: string[] = [];
      for (const tab of tabs) {
        await openSettingsTab(page, tab);
        const toggles = page.locator(
          '.advanced-toggle[aria-expanded="false"]:visible',
        );
        for (let i = await toggles.count(); i > 0; i -= 1) {
          await toggles.nth(i - 1).click();
        }
        const found = await page.evaluate(() => {
          const out: string[] = [];
          for (const select of Array.from(
            document.querySelectorAll<HTMLSelectElement>(
              "#settings-overlay select",
            ),
          )) {
            if (select.offsetParent === null) continue;
            const style = getComputedStyle(select);
            const context = document.createElement("canvas").getContext("2d");
            if (!context) continue;
            context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            const longest = Math.max(
              ...Array.from(select.options).map(
                (option) => context.measureText(option.text).width,
              ),
            );
            const needed =
              longest +
              parseFloat(style.paddingLeft) +
              parseFloat(style.paddingRight);
            const width = select.getBoundingClientRect().width;
            if (width + 1 < needed) {
              out.push(
                `${select.id || select.name}: ${Math.round(width)} < ${Math.round(needed)}`,
              );
            }
          }
          return out;
        });
        misfits.push(...found.map((line) => `${width}px ${tab} ${line}`));
        await page.keyboard.press("Escape");
        await expect(page.locator("#settings-overlay")).not.toHaveClass(
          /active/,
        );
      }
      expect(misfits, `width ${width}`).toEqual([]);
    }
  });

  test("at 820px with the sidebar open, header parts never overlap and Disconnect is readable", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 820, height: 640 });
    await openMockListing(page, {
      bookmarks: [
        { ...savedConnections[0], name: "Alpha" },
        { ...savedConnections[0], name: "Beta", access_key: "other-key" },
        { ...savedConnections[0], name: "Gamma", access_key: "third-key" },
      ],
    });
    await expect(page.locator("#disconnect-btn")).toBeVisible();

    const overlaps = await page.evaluate(() => {
      const parts: Record<string, Element | null> = {
        title: document.querySelector(".header__brand"),
        chips: document.getElementById("bookmark-bar"),
        badge: document.getElementById("connection-status"),
        disconnect: document.getElementById("disconnect-btn"),
        settings: document.getElementById("settings-btn"),
      };
      const boxes = Object.entries(parts).map(([name, el]) => {
        const r = el?.getBoundingClientRect();
        return {
          name,
          l: r?.left ?? 0,
          r: r?.right ?? 0,
          t: r?.top ?? 0,
          b: r?.bottom ?? 0,
          w: r?.width ?? 0,
        };
      });
      const hits: string[] = [];
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i];
          const b = boxes[j];
          if (
            a.w > 0 &&
            b.w > 0 &&
            a.l < b.r &&
            b.l < a.r &&
            a.t < b.b &&
            b.t < a.b
          ) {
            hits.push(`${a.name} x ${b.name}`);
          }
        }
      }
      return hits;
    });
    expect(overlaps).toEqual([]);

    const disconnect = await page.locator("#disconnect-btn").boundingBox();
    expect(disconnect?.height ?? 0).toBeGreaterThanOrEqual(24);

    for (const theme of ["light", "dark"] as const) {
      const ratio = await page.evaluate((mode) => {
        document.documentElement.setAttribute("data-theme", mode);
        const parse = (value: string) => {
          const parts = value.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1];
          return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
        };
        const over = (
          top: ReturnType<typeof parse>,
          bottom: ReturnType<typeof parse>,
        ) => ({
          r: top.r * top.a + bottom.r * (1 - top.a),
          g: top.g * top.a + bottom.g * (1 - top.a),
          b: top.b * top.a + bottom.b * (1 - top.a),
          a: 1,
        });
        const luminance = (c: ReturnType<typeof parse>) => {
          const lin = (v: number) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
        };
        const btn = document.getElementById("disconnect-btn");
        const header = document.querySelector(".header");
        if (!btn || !header) return 0;
        const page = over(
          parse(getComputedStyle(document.body).backgroundColor),
          { r: 255, g: 255, b: 255, a: 1 },
        );
        const headerBg = over(
          parse(getComputedStyle(header).backgroundColor),
          page,
        );
        const buttonBg = over(
          parse(getComputedStyle(btn).backgroundColor),
          headerBg,
        );
        const text = parse(getComputedStyle(btn).color);
        const a = luminance(text);
        const b = luminance(buttonBg);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      }, theme);
      expect(ratio, `Disconnect text on fill, ${theme}`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });
});
