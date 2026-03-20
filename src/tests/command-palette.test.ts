import { beforeEach, describe, expect, it, vi } from "vitest";

describe("command palette", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    if (!HTMLElement.prototype.scrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        value: vi.fn(),
        configurable: true,
      });
    } else {
      vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
        () => undefined,
      );
    }
    document.body.innerHTML = `
      <div id="palette-overlay" hidden>
        <div class="palette">
          <div class="palette__input-wrap">
            <input id="palette-input" type="text" />
          </div>
          <div id="palette-results"></div>
        </div>
      </div>
    `;
  });

  it("opens, filters, and executes commands with keyboard", async () => {
    const actionUpload = vi.fn();
    const actionRefresh = vi.fn();
    const palette = await import("../command-palette.ts");

    palette.registerCommands([
      {
        id: "upload-files",
        label: "Upload Files",
        icon: "1f4e4",
        action: actionUpload,
      },
      {
        id: "refresh",
        label: "Refresh",
        icon: "1f504",
        action: actionRefresh,
      },
      {
        id: "hidden",
        label: "Hidden",
        icon: "1f441",
        action: vi.fn(),
        available: () => false,
      },
    ]);
    palette.initPalette();
    palette.openPalette();

    const overlay = document.getElementById(
      "palette-overlay",
    ) as HTMLDivElement;
    const input = document.getElementById("palette-input") as HTMLInputElement;
    const results = document.getElementById(
      "palette-results",
    ) as HTMLDivElement;
    expect(overlay.hidden).toBe(false);
    expect(results.textContent).toContain("Upload Files");
    expect(results.textContent).toContain("Refresh");
    expect(results.textContent).not.toContain("Hidden");

    input.value = "refresh";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(results.textContent).toContain("Refresh");
    expect(results.textContent).not.toContain("Upload Files");

    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(actionRefresh).toHaveBeenCalledTimes(1);
    expect(overlay.hidden).toBe(true);
  });

  it("supports arrow navigation, click execution, and escape close", async () => {
    const runA = vi.fn();
    const runB = vi.fn();
    const palette = await import("../command-palette.ts");

    palette.registerCommands([
      { id: "a", label: "Action A", icon: "1f170", action: runA },
      { id: "b", label: "Action B", icon: "1f171", action: runB },
    ]);
    palette.initPalette();
    palette.openPalette();

    const input = document.getElementById("palette-input") as HTMLInputElement;
    const overlay = document.getElementById(
      "palette-overlay",
    ) as HTMLDivElement;

    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    );
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    const active = document.querySelector(
      ".palette__item--active .palette__item-label",
    ) as HTMLElement;
    expect(active.textContent).toBe("Action B");

    const secondItem =
      document.querySelectorAll<HTMLElement>(".palette__item")[1];
    secondItem.click();
    expect(runB).toHaveBeenCalledTimes(1);
    expect(overlay.hidden).toBe(true);

    palette.openPalette();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(overlay.hidden).toBe(true);
  });

  it("handles invalid result clicks and exposes shortcut text", async () => {
    const action = vi.fn();
    const palette = await import("../command-palette.ts");
    palette.registerCommands([
      {
        id: "download",
        label: "Download",
        icon: "1f4e5",
        shortcut: "Ctrl+D",
        action,
      },
    ]);
    palette.initPalette();
    palette.openPalette();

    const results = document.getElementById(
      "palette-results",
    ) as HTMLDivElement;
    expect(results.textContent).toContain("Ctrl+D");

    results.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(action).not.toHaveBeenCalled();

    const badItem = document.createElement("div");
    badItem.className = "palette__item";
    badItem.dataset.index = "not-a-number";
    results.appendChild(badItem);
    badItem.click();
    expect(action).not.toHaveBeenCalled();
  });

  it("gracefully handles missing palette elements", async () => {
    document.body.innerHTML = "";
    const palette = await import("../command-palette.ts");
    palette.initPalette();
    palette.openPalette();
    palette.closePalette();
    expect(palette.isPaletteOpen()).toBe(false);
  });

  it("renders empty state when no commands match and closes on backdrop click", async () => {
    const palette = await import("../command-palette.ts");
    palette.registerCommands([
      { id: "only", label: "Only Command", icon: "2705", action: vi.fn() },
    ]);
    palette.initPalette();
    palette.openPalette();

    const overlay = document.getElementById(
      "palette-overlay",
    ) as HTMLDivElement;
    const input = document.getElementById("palette-input") as HTMLInputElement;
    const results = document.getElementById(
      "palette-results",
    ) as HTMLDivElement;

    input.value = "does-not-exist";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(results.textContent).toContain("No commands found");

    overlay.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(overlay.hidden).toBe(true);
  });

  it("covers missing-results guards and non-executable Enter/click paths", async () => {
    const action = vi.fn();
    const palette = await import("../command-palette.ts");
    palette.registerCommands([
      { id: "run", label: "Run", icon: "25b6", action },
    ]);
    palette.initPalette();

    const input = document.getElementById("palette-input") as HTMLInputElement;
    document.getElementById("palette-results")?.remove();
    palette.openPalette();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );

    const wrap = document.querySelector(".palette") as HTMLDivElement;
    const results = document.createElement("div");
    results.id = "palette-results";
    wrap.appendChild(results);

    palette.initPalette();
    palette.openPalette();
    input.value = "no-match";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );

    const itemWithoutIndex = document.createElement("div");
    itemWithoutIndex.className = "palette__item";
    results.appendChild(itemWithoutIndex);
    itemWithoutIndex.click();

    expect(action).not.toHaveBeenCalled();
  });
});
