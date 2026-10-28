// Failure modes covered (UI overhaul 0.12.0, design tokens and primitives):
// - A new spacing, type, motion, elevation, scrim or success token is missing
//   in one theme, so the value resolves to an empty string.
// - The default row height drifts from 36px, or compact density stops at 28px.
// - An overlay backdrop uses its own colour instead of the shared --scrim.
// - A focused field, settings search or palette input shows no focus ring.
// - A stylesheet references a custom property that no token defines.
// - Owned stylesheets reintroduce raw hex/rgb colours or px font sizes.
// - Any stylesheet outside tokens.css reintroduces a raw hex/rgb/hsl colour.
// - A component surface token drifts between the light and dark theme blocks.
// - The .badge, .switch and select chevron primitives are missing or unthemed.
// - The connected-dot pulse repeats forever.
// - The dialog title and modal title sizes diverge.
// - Every 0.12.0 icon name resolves in the icon registry.
// - .btn--danger lives in controls.css, not modals.css.
import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installLayoutTauriMock, openMockListing } from "./tauri-layout.ts";

// Theme tokens are resolved in the browser and compared here. Every value is
// read through getComputedStyle so the assertions follow what actually renders.

const OS_SCHEMES = ["light", "dark"] as const;
const APP_THEMES = ["system", "light", "dark"] as const;
type OsScheme = (typeof OS_SCHEMES)[number];
type AppTheme = (typeof APP_THEMES)[number];
type Rgb = [number, number, number];

const PARITY_TOKENS = [
  "--bg",
  "--bg-surface",
  "--bg-hover",
  "--bg-active",
  "--bg-elevated",
  "--border",
  "--border-strong",
  "--border-focus",
  "--focus-ring-color",
  "--text",
  "--text-secondary",
  "--text-muted",
  "--accent",
  "--accent-hover",
  "--accent-text",
  "--accent-fg",
  "--danger",
  "--danger-text",
  "--danger-strong",
  "--warning",
  "--warning-text",
  "--tooltip-bg",
  "--tooltip-text",
  "--glass-bg",
  "--glass-bg-subtle",
  "--shadow-overlay",
  "--disconnect-text",
  "--badge-off-bg",
  "--badge-on-text",
  "--success",
  "--success-bg",
  "--success-text",
  "--scrim",
  "--danger-hover",
  "--titlebar-close-hover",
  "--shadow-1",
  "--shadow-2",
  "--shadow-3",
  "--drawer-shadow",
  "--resizer-grip",
  "--panel-scrim",
  "--support-scrim",
  "--setup-scrim",
  "--form-error-bg",
  "--form-error-border",
  "--scrollbar-thumb",
  "--scrollbar-thumb-hover",
  "--settings-preview-light-frame",
  "--settings-preview-light-surface",
  "--settings-preview-light-accent",
  "--settings-preview-light-text",
  "--settings-preview-light-edge",
  "--settings-preview-dark-frame",
  "--settings-preview-dark-surface",
  "--settings-preview-dark-accent",
  "--settings-preview-dark-text",
  "--settings-preview-dark-edge",
  "--settings-preview-system-edge",
  "--settings-preview-system-light-row",
  "--settings-preview-system-dark-row",
];

/** Tokens added for the 0.12.0 design system; each must resolve in both themes. */
const DESIGN_TOKENS = [
  "--space-6",
  "--space-7",
  "--space-8",
  "--space-9",
  "--text-base",
  "--text-lg",
  "--text-xl",
  "--line-height-tight",
  "--line-height-body",
  "--line-height-relaxed",
  "--font-sans",
  "--font-mono",
  "--duration-fast",
  "--duration-base",
  "--duration-slow",
  "--ease-standard",
  "--success",
  "--success-bg",
  "--success-text",
  "--scrim",
  "--shadow-1",
  "--shadow-2",
  "--shadow-3",
  "--danger-hover",
  "--titlebar-close-hover",
  "--focus-ring-width",
  "--focus-ring-offset",
  "--row-height",
];

/** Stylesheets this worker owns; the static checks read them from src/styles. */
const OWNED_STYLE_FILES = [
  "tokens.css",
  "controls.css",
  "effects.css",
  "feedback.css",
  "dialogs.css",
  "modals.css",
  "command-palette.css",
  "toasts.css",
  "header.css",
  "titlebar.css",
];

/** Icon names the 0.12.0 registry must resolve (each has a lucide-static file). */
const UI_ICON_NAMES = [
  "pencil",
  "history",
  "keyboard",
  "grip-vertical",
  "layers",
  "filter",
  "external-link",
  "columns-3",
  "chevron-right",
  "chevron-left",
  "chevrons-up-down",
  "sun",
  "moon",
  "rows-3",
  "share-2",
  "copy",
  "folder-input",
  "unlock",
  "fingerprint",
];

/** Tokens other workers already reference; each must resolve to a value. */
const CONTRACT_TOKENS = [
  "--danger-text",
  "--danger-strong",
  "--warning-text",
  "--accent-fg",
  "--border-strong",
  "--bg-elevated",
  "--tooltip-bg",
  "--tooltip-text",
  "--titlebar-height",
  "--statusbar-height",
  "--radius-md",
  "--glass-bg-subtle",
  "--titlebar-traffic-spacer",
  "--shadow-overlay",
];

/** Overlay stacking order today. Values must not change, only gain names. */
const Z_SCALE: Record<string, string> = {
  "--z-biometric": "259",
  "--z-modal": "260",
  "--z-context-menu": "300",
  "--z-dialog": "320",
  "--z-palette": "400",
  "--z-support": "450",
  "--z-wizard": "500",
  "--z-toast": "600",
  "--z-skip-link": "10000",
};

/** [foreground token, background token, minimum WCAG ratio]. */
const CONTRAST_PAIRS: readonly (readonly [string, string, number])[] = [
  ["--accent-text", "--accent", 4.5],
  ["--accent-text", "--accent-hover", 4.5],
  ["--accent-text", "--danger-strong", 4.5],
  ["--danger-text", "--bg-surface", 4.5],
  ["--danger-text", "--bg-active", 4.5],
  ["--warning-text", "--bg-surface", 4.5],
  ["--warning-text", "--bg-active", 4.5],
  ["--accent-fg", "--bg-surface", 4.5],
  ["--accent-fg", "--bg-active", 4.5],
  ["--text-muted", "--bg-surface", 4.5],
  ["--text-muted", "--bg", 4.5],
  ["--text-muted", "--bg-hover", 4.5],
  ["--tooltip-text", "--tooltip-bg", 4.5],
  ["--border-strong", "--bg-surface", 3],
  ["--success-text", "--bg-surface", 4.5],
  ["--success-text", "--success-bg", 4.5],
  ["--accent-text", "--danger-hover", 4.5],
  ["--accent-text", "--titlebar-close-hover", 4.5],
];

interface PaletteRow {
  dataTheme: string | null;
  colorScheme: string;
  tokens: Record<string, string>;
}

interface ContrastCheck {
  label: string;
  fg: string;
  bg: string;
  ratio: number;
  min: number;
}

function paletteKey(os: OsScheme, app: AppTheme): string {
  return `os=${os} app=${app}`;
}

async function openPalette(
  page: Page,
  os: OsScheme,
  app: AppTheme,
): Promise<Page> {
  const p = await page.context().newPage();
  await p.setViewportSize({ width: 1280, height: 800 });
  await p.emulateMedia({ colorScheme: os, reducedMotion: "reduce" });
  await installLayoutTauriMock(p, { settings: { theme: app } });
  await p.goto("/");
  await expect(p.locator("#connection-screen")).toBeVisible();
  if (app === "system") {
    await expect(p.locator("html")).not.toHaveAttribute("data-theme");
  } else {
    await expect(p.locator("html")).toHaveAttribute("data-theme", app);
  }
  return p;
}

async function readPalette(page: Page): Promise<PaletteRow> {
  const names = [...new Set([...PARITY_TOKENS, ...CONTRACT_TOKENS])];
  return page.evaluate((list) => {
    const root = document.documentElement;
    const computed = getComputedStyle(root);
    const tokens: Record<string, string> = {};
    for (const name of list) {
      tokens[name] = computed.getPropertyValue(name).trim();
    }
    return {
      dataTheme: root.getAttribute("data-theme"),
      colorScheme: computed.colorScheme,
      tokens,
    };
  }, names);
}

/** Resolves custom properties to the browser's normalized `rgb(...)` string. */
async function resolveTokenColors(
  page: Page,
  names: readonly string[],
): Promise<Record<string, string | null>> {
  return page.evaluate((list) => {
    const probe = document.createElement("span");
    document.body.appendChild(probe);
    const out: Record<string, string | null> = {};
    for (const name of list) {
      const raw = getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();
      if (!raw || !CSS.supports("color", raw)) {
        out[name] = null;
        continue;
      }
      probe.style.color = raw;
      out[name] = getComputedStyle(probe).color;
    }
    probe.remove();
    return out;
  }, names);
}

function toRgb(value: string | null | undefined): Rgb | null {
  const match = value?.match(
    /^rgb\((\d+(?:\.\d+)?), (\d+(?:\.\d+)?), (\d+(?:\.\d+)?)\)$/,
  );
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function relativeLuminance([r, g, b]: Rgb): number {
  const [R, G, B] = [r, g, b].map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function contrastCheck(
  label: string,
  fg: string | null | undefined,
  bg: string | null | undefined,
  min: number,
): ContrastCheck {
  const a = toRgb(fg);
  const b = toRgb(bg);
  const ratio = a && b ? contrastRatio(a, b) : 0;
  return { label, fg: fg ?? "unresolved", bg: bg ?? "unresolved", ratio, min };
}

function artifactDir(testInfo: TestInfo): string {
  const dir = path.join("test-results/ux-theme-tokens", testInfo.project.name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function runContrastChecks(
  page: Page,
  os: OsScheme,
  app: AppTheme,
): Promise<{
  dataTheme: string | null;
  colorScheme: string;
  checks: ContrastCheck[];
}> {
  const p = await openPalette(page, os, app);
  try {
    const checks: ContrastCheck[] = [];
    const names = [
      ...new Set([
        ...CONTRAST_PAIRS.flatMap(([fg, bg]) => [fg, bg]),
        "--accent-hover",
      ]),
    ];
    const colors = await resolveTokenColors(p, names);
    for (const [fg, bg, min] of CONTRAST_PAIRS) {
      checks.push(contrastCheck(`${fg} on ${bg}`, colors[fg], colors[bg], min));
    }

    // The placeholder is read while the endpoint field is still empty.
    const endpoint = p.locator("#conn-endpoint");
    const placeholder = await endpoint.evaluate((el) => ({
      fg: getComputedStyle(el, "::placeholder").color,
      bg: getComputedStyle(el).backgroundColor,
    }));
    checks.push(
      contrastCheck(
        "placeholder on field",
        placeholder.fg,
        placeholder.bg,
        4.5,
      ),
    );

    await endpoint.fill("https://layout-test.invalid");
    await p.locator("#conn-access-key").fill("contrast-access-key");
    await p.locator("#conn-secret-key").fill("contrast-secret-key");

    const connect = p.locator("#connect-btn");
    const rest = await connect.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { fg: cs.color, bg: cs.backgroundColor };
    });
    checks.push(
      contrastCheck("connect-btn text on fill", rest.fg, rest.bg, 4.5),
    );

    await connect.hover();
    await expect
      .poll(
        () => connect.evaluate((el) => getComputedStyle(el).backgroundColor),
        {
          message: "connect-btn hover fill should resolve to --accent-hover",
        },
      )
      .toBe(colors["--accent-hover"]);
    const hover = await connect.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { fg: cs.color, bg: cs.backgroundColor };
    });
    checks.push(
      contrastCheck("connect-btn text on hover fill", hover.fg, hover.bg, 4.5),
    );

    const dataTheme = await p.locator("html").getAttribute("data-theme");
    const colorScheme = await p.evaluate(
      () => getComputedStyle(document.documentElement).colorScheme,
    );
    return { dataTheme, colorScheme, checks };
  } finally {
    await p.close();
  }
}

test("theme parity: OS scheme x app theme resolve the same tokens", async ({
  page,
}, testInfo) => {
  const rows: Record<string, PaletteRow> = {};
  for (const os of OS_SCHEMES) {
    for (const app of APP_THEMES) {
      const p = await openPalette(page, os, app);
      try {
        rows[paletteKey(os, app)] = await readPalette(p);
      } finally {
        await p.close();
      }
    }
  }

  for (const [key, row] of Object.entries(rows)) {
    for (const name of CONTRACT_TOKENS) {
      expect(row.tokens[name], `${key} ${name}`).toBeTruthy();
    }
  }

  for (const os of OS_SCHEMES) {
    for (const app of APP_THEMES) {
      const resolved = app === "system" ? os : app;
      const row = rows[paletteKey(os, app)];
      const reference = rows[paletteKey(resolved, "system")];
      expect(row.tokens, paletteKey(os, app)).toEqual(reference.tokens);
      expect(row.colorScheme, paletteKey(os, app)).toBe(resolved);
    }
  }

  writeFileSync(
    path.join(artifactDir(testInfo), "theme-parity.json"),
    `${JSON.stringify(rows, null, 2)}\n`,
  );
});

for (const os of OS_SCHEMES) {
  for (const app of APP_THEMES) {
    test(`contrast meets WCAG AA: OS ${os}, app ${app}`, async ({
      page,
    }, testInfo) => {
      const key = paletteKey(os, app);
      const result = await runContrastChecks(page, os, app);
      writeFileSync(
        path.join(artifactDir(testInfo), `theme-contrast-${os}-${app}.json`),
        `${JSON.stringify({ key, ...result }, null, 2)}\n`,
      );
      const failures = result.checks
        .filter((check) => !(check.ratio >= check.min))
        .map(
          (check) =>
            `${check.label} = ${check.ratio.toFixed(2)}:1 (need ${check.min}) [${check.fg} on ${check.bg}]`,
        );
      expect(failures, key).toEqual([]);
    });
  }
}

test("token contract: names resolve, z-index order holds, titlebar height is theme-independent", async ({
  page,
}) => {
  await installLayoutTauriMock(page);
  await page.goto("/");
  await expect(page.locator("#connection-screen")).toBeVisible();

  const names = [...CONTRACT_TOKENS, ...Object.keys(Z_SCALE)];
  const values = await page.evaluate((list) => {
    const computed = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      list.map((name) => [name, computed.getPropertyValue(name).trim()]),
    );
  }, names);
  for (const name of CONTRACT_TOKENS) {
    expect(values[name], name).toBeTruthy();
  }
  for (const [name, value] of Object.entries(Z_SCALE)) {
    expect(values[name], name).toBe(value);
  }
  expect(values["--titlebar-height"]).toBe("40px");

  const bodyTitlebar = await page.evaluate(() =>
    getComputedStyle(document.body)
      .getPropertyValue("--titlebar-height")
      .trim(),
  );
  expect(bodyTitlebar, "no custom titlebar keeps today's 0px").toBe("0px");
});

test("statusbar token matches the rendered status bar", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openMockListing(page, { objectCount: 3 });
  const bar = await page.locator(".statusbar").boundingBox();
  expect(bar).not.toBeNull();
  const token = await page.evaluate(() =>
    parseFloat(
      getComputedStyle(document.documentElement)
        .getPropertyValue("--statusbar-height")
        .trim(),
    ),
  );
  const rendered = bar?.height ?? 0;
  expect(
    Math.abs(rendered - token),
    `rendered ${rendered}px vs --statusbar-height ${token}px`,
  ).toBeLessThanOrEqual(1);
});

test("narrow sidebar overlay leaves the toolbar toggle clickable", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 820, height: 640 });
  await openMockListing(page, { objectCount: 3 });
  const layout = page.locator("#main-layout");
  const toggle = page.locator("#sidebar-toggle");
  const isOpen = () =>
    layout.evaluate((el) => el.classList.contains("main-layout--sidebar-open"));
  if (!(await isOpen())) {
    await toggle.click();
  }
  await expect(layout).toHaveClass(/main-layout--sidebar-open/);
  // The sidebar slides in over 0.18s; wait for it to settle so the artifact
  // shows the finished layout rather than a mid-transition frame.
  await expect
    .poll(async () => (await page.locator(".sidebar").boundingBox())?.x)
    .toBe(0);
  await page.screenshot({
    path: path.join(artifactDir(testInfo), "narrow-820x640-sidebar-open.png"),
  });

  const box = await toggle.boundingBox();
  expect(box).not.toBeNull();
  const point = {
    x: (box?.x ?? 0) + (box?.width ?? 0) / 2,
    y: (box?.y ?? 0) + (box?.height ?? 0) / 2,
  };
  const coveredBySidebar = await page.evaluate(
    ({ x, y }) =>
      Boolean(document.elementFromPoint(x, y)?.closest("#bucket-panel")),
    point,
  );
  expect(coveredBySidebar, "toggle centre must not be under the sidebar").toBe(
    false,
  );

  await page.mouse.click(point.x, point.y);
  await expect(layout).not.toHaveClass(/main-layout--sidebar-open/);
});

test("support overlay starts below the custom title bar", async ({ page }) => {
  await installLayoutTauriMock(page);
  await page.goto("/");
  await expect(page.locator("#connection-screen")).toBeVisible();
  const result = await page.evaluate(() => {
    document.body.classList.add("titlebar-custom", "platform-macos");
    const overlay = document.getElementById("support-overlay") as HTMLElement;
    overlay.hidden = false;
    return {
      top: overlay.getBoundingClientRect().top,
      titlebar: getComputedStyle(document.body)
        .getPropertyValue("--titlebar-height")
        .trim(),
    };
  });
  expect(result.titlebar).toBe("40px");
  expect(result.top).toBe(40);
});

test("reduced motion also stops pseudo-element animations", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installLayoutTauriMock(page);
  await page.goto("/");
  await expect(page.locator("#connection-screen")).toBeVisible();
  const duration = await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent =
      ".ux-motion-probe::before { content: ''; animation: spin 2s linear infinite; }";
    document.head.appendChild(style);
    const probe = document.createElement("span");
    probe.className = "ux-motion-probe";
    document.body.appendChild(probe);
    return getComputedStyle(probe, "::before").animationDuration;
  });
  expect(duration).toBe("0s");
});

test("forced colors keep a non-colour cue on active selections", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active", colorScheme: "light" });
  await installLayoutTauriMock(page);
  await page.goto("/");
  await expect(page.locator("#connection-screen")).toBeVisible();
  const cues = await page.evaluate(() => {
    const samples: [string, string][] = [
      [
        "settings tab",
        '<button class="settings-tab settings-tab--active"></button>',
      ],
      ["info tab", '<button class="info-tab info-tab--active"></button>'],
      [
        "inspector tab",
        '<button class="inspector-tab inspector-tab--active"></button>',
      ],
      [
        "drawer tab",
        '<button class="bottom-drawer__tab bottom-drawer__tab--active"></button>',
      ],
      [
        "active bucket",
        '<ul><li class="list__item list__item--active"></li></ul>',
      ],
      ["theme card", '<label class="theme-card theme-card--active"></label>'],
    ];
    const host = document.createElement("div");
    document.body.appendChild(host);
    const out: Record<string, boolean> = {};
    for (const [label, html] of samples) {
      host.innerHTML = html;
      const el = host.querySelector<HTMLElement>("button, li, label");
      if (!el) continue;
      const cs = getComputedStyle(el);
      out[label] =
        cs.outlineStyle !== "none" ||
        cs.textDecorationLine.includes("underline");
    }
    host.remove();
    return out;
  });
  expect(Object.keys(cues)).toHaveLength(6);
  for (const [label, hasCue] of Object.entries(cues)) {
    expect(hasCue, label).toBe(true);
  }
});

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function ownedStyles(): { file: string; css: string }[] {
  const dir = path.resolve(process.cwd(), "src/styles");
  return OWNED_STYLE_FILES.map((file) => ({
    file,
    css: stripCssComments(readFileSync(path.join(dir, file), "utf8")),
  }));
}

/** Computed focus indicator: an outline or a box-shadow ring. */
async function focusIndicator(locator: Locator): Promise<boolean> {
  await locator.focus();
  return locator.evaluate((el) => {
    const cs = getComputedStyle(el);
    const outline =
      cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
    return outline || cs.boxShadow !== "none";
  });
}

test("design tokens resolve in light and dark, with the new font stacks", async ({
  page,
}, testInfo) => {
  const byTheme: Record<string, Record<string, string>> = {};
  for (const os of OS_SCHEMES) {
    const p = await openPalette(page, os, "system");
    try {
      byTheme[os] = await p.evaluate((names) => {
        const computed = getComputedStyle(document.documentElement);
        return Object.fromEntries(
          names.map((name) => [name, computed.getPropertyValue(name).trim()]),
        );
      }, DESIGN_TOKENS);
    } finally {
      await p.close();
    }
  }
  for (const os of OS_SCHEMES) {
    for (const name of DESIGN_TOKENS) {
      expect(byTheme[os][name], `${os} ${name}`).toBeTruthy();
    }
    expect(byTheme[os]["--font-sans"], `${os} --font-sans`).toMatch(
      /^system-ui,/,
    );
    expect(byTheme[os]["--font-mono"], `${os} --font-mono`).toMatch(
      /^ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace$/,
    );
  }
  writeFileSync(
    path.join(artifactDir(testInfo), "design-tokens.json"),
    `${JSON.stringify(byTheme, null, 2)}\n`,
  );
});

test("row height is 36px by default and 28px under compact density", async ({
  page,
}) => {
  await openMockListing(page, { objectCount: 3 });
  const read = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--row-height")
        .trim(),
    );
  expect(await read()).toBe("36px");
  await page.evaluate(() =>
    document.documentElement.setAttribute("data-density", "compact"),
  );
  expect(await read()).toBe("28px");
});

test("every overlay backdrop uses the one --scrim token", async ({ page }) => {
  await openMockListing(page, { objectCount: 3 });
  const scrim = (await resolveTokenColors(page, ["--scrim"]))["--scrim"];
  expect(scrim, "--scrim resolves to a colour").toBeTruthy();
  const backdrops = await page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        ".modal-overlay, .dialog-overlay, .palette-overlay, .biometric-overlay",
      ),
    ].map((el) => ({
      id: el.id,
      bg: getComputedStyle(el).backgroundColor,
    })),
  );
  expect(backdrops.length).toBeGreaterThanOrEqual(4);
  for (const { id, bg } of backdrops) {
    expect(bg, id).toBe(scrim);
  }
});

test("focus ring is visible on a field, the settings search and the palette input", async ({
  page,
}) => {
  await installLayoutTauriMock(page);
  await page.goto("/");
  await expect(page.locator("#connection-screen")).toBeVisible();
  expect(await focusIndicator(page.locator("#conn-endpoint"))).toBe(true);

  await openMockListing(page, { objectCount: 3 });
  await page.locator("#settings-btn").click();
  await expect(page.locator("#settings-overlay")).toBeVisible();
  expect(await focusIndicator(page.locator("#settings-search"))).toBe(true);
  await page.locator("#settings-close").click();

  await page.keyboard.press("Control+k");
  await expect(page.locator("#palette-overlay")).toBeVisible();
  expect(await focusIndicator(page.locator("#palette-input"))).toBe(true);
});

test("stylesheets reference only defined custom properties", async ({
  page,
}) => {
  const names = new Set<string>();
  for (const { css } of ownedStyles()) {
    for (const match of css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
      names.add(match[1]);
    }
  }
  expect(names.size).toBeGreaterThan(20);

  for (const os of OS_SCHEMES) {
    const p = await openPalette(page, os, "system");
    try {
      const undefinedNames = await p.evaluate(
        (list) => {
          const computed = getComputedStyle(document.documentElement);
          return list.filter((name) => !computed.getPropertyValue(name).trim());
        },
        [...names],
      );
      expect(undefinedNames, `${os} undefined tokens`).toEqual([]);
    } finally {
      await p.close();
    }
  }
});

test("owned stylesheets use tokens instead of raw colours or px font sizes", () => {
  for (const { file, css } of ownedStyles()) {
    if (file === "tokens.css") continue;
    expect(
      {
        file,
        hex: css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [],
        rgb: css.match(/rgba?\([^)]*\)/g) ?? [],
        px: css.match(/font-size:\s*\d+(\.\d+)?px/g) ?? [],
      },
      file,
    ).toEqual({ file, hex: [], rgb: [], px: [] });
  }
});

test("every stylesheet outside tokens.css uses tokens for colour", () => {
  const dir = path.resolve(process.cwd(), "src/styles");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".css"))) {
    if (file === "tokens.css") continue;
    const css = stripCssComments(readFileSync(path.join(dir, file), "utf8"));
    expect(
      {
        file,
        hex: css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [],
        fn: css.match(/(?:rgba?|hsla?)\([^)]*\)/g) ?? [],
      },
      file,
    ).toEqual({ file, hex: [], fn: [] });
  }
});

test("btn--danger is a button primitive in controls.css", () => {
  const read = (file: string) =>
    ownedStyles().find((entry) => entry.file === file)?.css ?? "";
  expect(read("controls.css")).toMatch(/\.btn--danger\s*\{/);
  expect(read("modals.css")).not.toMatch(/\.btn--danger\b/);
});

test("badge, count and alert primitives render with token colours", async ({
  page,
}) => {
  await installLayoutTauriMock(page);
  await page.goto("/");
  await expect(page.locator("#connection-screen")).toBeVisible();
  const colors = await resolveTokenColors(page, [
    "--accent",
    "--danger-strong",
  ]);
  const badges = await page.evaluate(() => {
    const host = document.createElement("div");
    host.innerHTML =
      '<span class="badge" data-kind="base">1</span>' +
      '<span class="badge badge--count" data-kind="count">3</span>' +
      '<span class="badge badge--alert" data-kind="alert">!</span>';
    document.body.appendChild(host);
    return [...host.querySelectorAll<HTMLElement>(".badge")].map((el) => {
      const cs = getComputedStyle(el);
      return {
        kind: el.dataset.kind ?? "",
        bg: cs.backgroundColor,
        radius: cs.borderTopLeftRadius,
      };
    });
  });
  const byKind = Object.fromEntries(badges.map((b) => [b.kind, b]));
  expect(byKind.base?.bg).not.toBe("rgba(0, 0, 0, 0)");
  expect(byKind.count?.bg).toBe(colors["--accent"]);
  expect(byKind.alert?.bg).toBe(colors["--danger-strong"]);
  for (const badge of badges) {
    expect(badge.radius, badge.kind).not.toBe("0px");
  }
});

test("switch checkbox is a themed toggle with a focus ring", async ({
  page,
}) => {
  // Reduced motion lands the colour change at once, so the reads are not mid-transition.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installLayoutTauriMock(page);
  await page.goto("/");
  await expect(page.locator("#connection-screen")).toBeVisible();
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "switch";
    input.id = "probe-switch";
    document.body.appendChild(input);
  });
  const toggle = page.locator("#probe-switch");
  const box = await toggle.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(28);
  const off = await toggle.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  await toggle.evaluate((el) => {
    (el as HTMLInputElement).checked = true;
  });
  const on = await toggle.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  expect(on).not.toBe(off);
  expect(await focusIndicator(toggle)).toBe(true);
});

test("select chevron is drawn in currentColor, not a hard-coded grey", async ({
  page,
}) => {
  await installLayoutTauriMock(page);
  await page.goto("/");
  await expect(page.locator("#connection-screen")).toBeVisible();
  const image = await page.evaluate(() => {
    const select = document.createElement("select");
    select.className = "field";
    select.id = "probe-select";
    select.innerHTML = "<option>one</option>";
    document.body.appendChild(select);
    return getComputedStyle(select).backgroundImage;
  });
  expect(image).not.toMatch(/6b7280/);
});

test("connected-dot pulse does not repeat forever", async ({ page }) => {
  await installLayoutTauriMock(page);
  await page.goto("/");
  await expect(page.locator("#connection-screen")).toBeVisible();
  const iterations = await page.evaluate(() => {
    const badge = document.createElement("span");
    badge.className = "connection-badge connection-badge--on";
    document.body.appendChild(badge);
    return getComputedStyle(badge, "::before").animationIterationCount;
  });
  expect(iterations).not.toBe("infinite");
});

test("dialog title and modal title share one font size", async ({ page }) => {
  await installLayoutTauriMock(page);
  await page.goto("/");
  await expect(page.locator("#connection-screen")).toBeVisible();
  const sizes = await page.evaluate(() => {
    const host = document.createElement("div");
    host.innerHTML =
      '<div class="modal__header"><h2 data-kind="modal">Modal</h2></div>' +
      '<div class="dialog-box"><h2 class="dialog-box__title" data-kind="dialog">Dialog</h2></div>';
    document.body.appendChild(host);
    return Object.fromEntries(
      [...host.querySelectorAll<HTMLElement>("h2")].map((el) => [
        el.dataset.kind ?? "",
        getComputedStyle(el).fontSize,
      ]),
    );
  });
  expect(sizes.dialog).toBe(sizes.modal);
});

test("every 0.12.0 icon name resolves in the icon registry", async ({
  page,
}) => {
  await installLayoutTauriMock(page);
  await page.goto("/");
  await expect(page.locator("#connection-screen")).toBeVisible();
  const missing = await page.evaluate(async (names) => {
    const url = new URL("/icons.ts", window.location.href).href;
    const mod = (await import(/* @vite-ignore */ url)) as {
      getIconHtml: (name: string) => string;
    };
    return names.filter((name) => !mod.getIconHtml(name).includes("<svg"));
  }, UI_ICON_NAMES);
  expect(missing).toEqual([]);
});
