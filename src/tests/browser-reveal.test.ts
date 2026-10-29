import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../inspector.ts", () => ({
  closeInspectorOnMobile: vi.fn(),
  isInspectorOpen: () => false,
  markInspectorHasContent: vi.fn(),
  syncInspectorFromSelection: vi.fn(async () => {}),
}));

vi.mock("../connection.ts", () => ({
  refreshObjects: vi.fn(async () => true),
  MAX_ACCUMULATED_LISTING_ITEMS: 10000,
}));

vi.mock("../info-panel.ts", () => ({
  hasUnsavedInfoChanges: () => false,
  confirmDiscardInfoProperties: async () => true,
}));

function renderFixture(): void {
  document.body.innerHTML = `
    <input id="filter-input" />
    <input id="bucket-filter-input" />
    <ul id="bucket-list"></ul>
    <nav id="location-omnibar-browse" class="breadcrumb"></nav>
    <div id="object-panel" style="display:none"></div>
    <div id="empty-state"></div>
    <table>
      <thead>
        <tr>
          <th data-sort="name"><span id="sort-name"></span></th>
          <th data-sort="size"><span id="sort-size"></span></th>
          <th data-sort="modified"><span id="sort-modified"></span></th>
        </tr>
      </thead>
      <tbody id="object-tbody"></tbody>
    </table>
    <input id="select-all" type="checkbox" />
    <div id="batch-toolbar">
      <span id="batch-count"></span>
      <div id="batch-toolbar-actions" hidden>
        <button id="batch-properties"></button>
        <button id="batch-download"></button>
        <button id="batch-delete"></button>
        <button id="batch-copy-urls"></button>
        <button id="batch-deselect"></button>
        <button id="batch-more"></button>
      </div>
    </div>
    <div id="load-more-row"></div>
    <span id="statusbar-count"></span>
    <span id="object-count"></span>
    <button id="nav-back"></button>
    <button id="nav-forward"></button>
    <button id="nav-up"></button>
    <input id="location-omnibar-edit" type="text" hidden />
    <button id="btn-download" disabled></button>
    <span id="status"></span>
  `;
}

describe("revealRow", () => {
  beforeEach(async () => {
    vi.resetModules();
    renderFixture();
    const { state } = await import("../state.ts");
    state.connected = true;
    state.platformName = "windows";
    state.currentBucket = "bucket-a";
    state.currentPrefix = "";
    state.buckets = [];
    state.objects = [];
    state.prefixes = [];
    state.filterText = "";
    state.sortColumn = "name";
    state.sortAsc = true;
    state.selectedKeys.clear();
    state.selectedPrefixes.clear();
    state.continuationToken = "";
    state.hasMore = false;
  });

  it("returns false when the entry is not in the loaded listing", async () => {
    const browser = await import("../browser.ts");
    const { state } = await import("../state.ts");
    state.objects = [
      {
        key: "present.txt",
        size: 1,
        last_modified: "2024-01-01T00:00:00Z",
        is_folder: false,
      },
    ];
    browser.renderObjectTable();

    expect(browser.revealRow("missing.txt", "file")).toBe(false);
    expect(browser.revealRow("present.txt", "folder")).toBe(false);
    expect(state.selectedKeys.size).toBe(0);
  });

  it("selects the entry alone and focuses its row", async () => {
    const browser = await import("../browser.ts");
    const { state } = await import("../state.ts");
    state.prefixes = ["docs/"];
    state.objects = [
      {
        key: "a.txt",
        size: 1,
        last_modified: "2024-01-01T00:00:00Z",
        is_folder: false,
      },
      {
        key: "b.txt",
        size: 2,
        last_modified: "2024-01-01T00:00:00Z",
        is_folder: false,
      },
    ];
    state.selectedKeys.add("a.txt");
    browser.renderObjectTable();

    expect(browser.revealRow("b.txt", "file")).toBe(true);
    expect([...state.selectedKeys]).toEqual(["b.txt"]);
    expect(state.selectedPrefixes.size).toBe(0);
    const row = document.querySelector<HTMLElement>(
      '.object-row[data-key="b.txt"]',
    );
    expect(row?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(row);
  });

  it("mounts a row far outside the first virtualized window", async () => {
    const browser = await import("../browser.ts");
    const { state } = await import("../state.ts");
    state.objects = Array.from({ length: 400 }, (_, index) => ({
      key: `item-${String(index).padStart(3, "0")}.txt`,
      size: index,
      last_modified: "2024-01-01T00:00:00Z",
      is_folder: false,
    }));
    browser.renderObjectTable();

    expect(
      document.querySelector('.object-row[data-key="item-350.txt"]'),
    ).toBeNull();
    expect(browser.revealRow("item-350.txt", "file")).toBe(true);
    const row = document.querySelector<HTMLElement>(
      '.object-row[data-key="item-350.txt"]',
    );
    expect(row).not.toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("clears a filter that hides the entry before revealing it", async () => {
    const browser = await import("../browser.ts");
    const { state } = await import("../state.ts");
    state.objects = [
      {
        key: "alpha.txt",
        size: 1,
        last_modified: "2024-01-01T00:00:00Z",
        is_folder: false,
      },
      {
        key: "beta.txt",
        size: 1,
        last_modified: "2024-01-01T00:00:00Z",
        is_folder: false,
      },
    ];
    state.filterText = "alpha";
    browser.renderObjectTable();
    expect(
      document.querySelector('.object-row[data-key="beta.txt"]'),
    ).toBeNull();

    expect(browser.revealRow("beta.txt", "file")).toBe(true);
    expect(state.filterText).toBe("");
    expect([...state.selectedKeys]).toEqual(["beta.txt"]);
  });
});
