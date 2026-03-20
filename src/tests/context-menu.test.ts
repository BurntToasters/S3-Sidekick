import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hideContextMenu, showContextMenu } from "../context-menu.ts";

describe("context menu", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
  });

  afterEach(() => {
    hideContextMenu();
    vi.useRealTimers();
  });

  it("renders menu items, separators, and invokes action on click", () => {
    const onAction = vi.fn();
    showContextMenu(
      20,
      30,
      [
        { label: "Open", action: "open" },
        { separator: true },
        { label: "Delete", action: "delete" },
      ],
      onAction,
    );

    const menu = document.querySelector(".context-menu") as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.querySelectorAll(".context-menu__item")).toHaveLength(2);
    expect(menu.querySelectorAll(".context-menu__sep")).toHaveLength(1);
    expect(menu.style.left).toBe("20px");
    expect(menu.style.top).toBe("30px");

    const buttons = menu.querySelectorAll<HTMLButtonElement>(
      ".context-menu__item",
    );
    buttons[1].click();
    expect(onAction).toHaveBeenCalledWith("delete");
    expect(document.querySelector(".context-menu")).toBeNull();
  });

  it("supports keyboard navigation and escape to close", () => {
    showContextMenu(
      10,
      10,
      [
        { label: "One", action: "one" },
        { label: "Two", action: "two" },
      ],
      () => {},
    );
    vi.runAllTimers();

    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".context-menu__item"),
    );
    expect(document.activeElement).toBe(buttons[0]);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    expect(document.activeElement).toBe(buttons[1]);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    expect(document.activeElement).toBe(buttons[0]);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    );
    expect(document.activeElement).toBe(buttons[1]);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(document.querySelector(".context-menu")).toBeNull();
  });

  it("closes when clicking outside and handles disabled items", () => {
    const onAction = vi.fn();
    showContextMenu(
      5,
      5,
      [
        { label: "Enabled", action: "enabled" },
        { label: "Disabled", action: "disabled", disabled: true },
      ],
      onAction,
    );
    vi.runAllTimers();

    const disabled = document.querySelectorAll<HTMLButtonElement>(
      ".context-menu__item",
    )[1];
    expect(disabled.disabled).toBe(true);
    disabled.click();
    expect(onAction).not.toHaveBeenCalled();

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".context-menu")).toBeNull();
  });

  it("hideContextMenu is safe to call repeatedly", () => {
    showContextMenu(0, 0, [{ label: "Open", action: "open" }], () => {});
    hideContextMenu();
    hideContextMenu();
    expect(document.querySelector(".context-menu")).toBeNull();
  });

  it("clamps menu position to viewport bounds", () => {
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        width: 200,
        height: 120,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 200,
        bottom: 120,
        toJSON: () => ({}),
      } as DOMRect);

    Object.defineProperty(window, "innerWidth", {
      value: 100,
      configurable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      value: 80,
      configurable: true,
    });

    showContextMenu(95, 75, [{ label: "Open", action: "open" }], () => {});
    const menu = document.querySelector(".context-menu") as HTMLElement;
    expect(menu.style.left).toBe("4px");
    expect(menu.style.top).toBe("4px");

    rectSpy.mockRestore();
  });

  it("handles no-focusable menu items and navigation from unfocused/previous item", () => {
    showContextMenu(8, 8, [{ separator: true }], () => {});
    vi.runAllTimers();
    expect(document.querySelectorAll(".context-menu__item")).toHaveLength(0);
    expect(document.querySelector(".context-menu")).not.toBeNull();
    hideContextMenu();

    showContextMenu(
      10,
      10,
      [
        { label: "One", action: "one" },
        { label: "Two", action: "two" },
      ],
      () => {},
    );
    vi.runAllTimers();
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".context-menu__item"),
    );

    buttons[0].blur();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    expect(document.activeElement).toBe(buttons[0]);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    expect(document.activeElement).toBe(buttons[1]);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    );
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("does not dismiss on inside clicks and skips stale deferred handlers after hide", () => {
    showContextMenu(12, 12, [{ label: "Open", action: "open" }], () => {});
    hideContextMenu();
    vi.runAllTimers();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".context-menu")).toBeNull();

    showContextMenu(14, 16, [{ label: "Inside", action: "inside" }], () => {});
    vi.runAllTimers();
    const menu = document.querySelector(".context-menu") as HTMLElement;
    menu.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".context-menu")).not.toBeNull();
  });
});
