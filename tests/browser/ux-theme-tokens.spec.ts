import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
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
