import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshObjectsMock = vi.fn(
  async (bucket: string, prefix: string): Promise<void> => {
    const { state } = await import("../state.ts");
    state.currentBucket = bucket;
    state.currentPrefix = prefix;
  },
);

vi.mock("../connection.ts", () => ({
  refreshObjects: refreshObjectsMock,
}));

function renderFixture(): void {
  document.body.innerHTML = `
    <input id="filter-input" />
    <ul id="bucket-list"></ul>
    <nav id="breadcrumb"></nav>
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
    <div id="batch-toolbar" hidden><span id="batch-count"></span></div>
    <div id="load-more-row"></div>
    <span id="statusbar-count"></span>
    <span id="object-count"></span>
    <button id="nav-back"></button>
    <button id="nav-forward"></button>
    <span id="status"></span>
  `;
}

describe("browser core rendering and selection", () => {
  beforeEach(async () => {
    vi.resetModules();
    refreshObjectsMock.mockClear();
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
    state.continuationToken = "";
    state.hasMore = false;
  });

  it("renders bucket list empty and active states", async () => {
    const browser = await import("../browser.ts");
    const { state } = await import("../state.ts");

    browser.renderBucketList();
    expect(
      (document.getElementById("bucket-list") as HTMLUListElement).innerHTML,
    ).toContain("No buckets found");

    state.buckets = [
      { name: "bucket-a", creation_date: "2024-01-01" },
      { name: "bucket-b", creation_date: "2024-01-02" },
    ];
    state.currentBucket = "bucket-b";
    browser.renderBucketList();
    const active = document.querySelector(
      '.list__item-btn[data-bucket="bucket-b"]',
    ) as HTMLButtonElement;
    expect(active.getAttribute("aria-current")).toBe("true");
  });

  it("renders object table, breadcrumb, counts, and selection UI", async () => {
    const browser = await import("../browser.ts");
    const { state } = await import("../state.ts");
    state.currentBucket = "bucket-a";
    state.currentPrefix = "docs/";
    state.prefixes = ["docs/folder/"];
    state.objects = [
      {
        key: "docs/file-a.txt",
        size: 100,
        last_modified: "2024-01-01T00:00:00Z",
        is_folder: false,
      },
      {
        key: "docs/file-b.txt",
        size: 300,
        last_modified: "2024-01-02T00:00:00Z",
        is_folder: false,
      },
    ];

    browser.renderObjectTable();
    browser.renderBreadcrumb();

    const rows = document.querySelectorAll("#object-tbody .object-row");
    expect(rows).toHaveLength(3);
    expect(
      (document.getElementById("statusbar-count") as HTMLSpanElement)
        .textContent,
    ).toContain("1 folder, 2 files");
    expect(
      (document.getElementById("breadcrumb") as HTMLElement).textContent,
    ).toContain("bucket-a");

    state.selectedKeys.add("docs/file-a.txt");
    state.selectedKeys.add("docs/file-b.txt");
    browser.updateSelectionUI();
    expect(
      (document.getElementById("batch-toolbar") as HTMLDivElement).hidden,
    ).toBe(false);
    expect(
      (document.getElementById("batch-count") as HTMLSpanElement).textContent,
    ).toContain("2 files selected");
  });

  it("supports row click multi-selection and select-all", async () => {
    const browser = await import("../browser.ts");
    const { state } = await import("../state.ts");
    state.prefixes = ["folder/"];
    state.objects = [
      {
        key: "file-a.txt",
        size: 1,
        last_modified: "2024-01-01T00:00:00Z",
        is_folder: false,
      },
      {
        key: "file-b.txt",
        size: 2,
        last_modified: "2024-01-01T00:00:00Z",
        is_folder: false,
      },
      {
        key: "file-c.txt",
        size: 3,
        last_modified: "2024-01-01T00:00:00Z",
        is_folder: false,
      },
    ];

    browser.renderObjectTable();

    browser.handleRowClick(
      "file-a.txt",
      new MouseEvent("click", { bubbles: true }),
    );
    expect(state.selectedKeys.has("file-a.txt")).toBe(true);

    browser.handleRowClick(
      "file-b.txt",
      new MouseEvent("click", { bubbles: true, ctrlKey: true }),
    );
    expect(state.selectedKeys.has("file-a.txt")).toBe(true);
    expect(state.selectedKeys.has("file-b.txt")).toBe(true);

    browser.handleRowClick(
      "file-c.txt",
      new MouseEvent("click", { bubbles: true, shiftKey: true }),
    );
    expect(state.selectedKeys.has("file-c.txt")).toBe(true);

    browser.handleSelectAll(true);
    expect(
      (document.getElementById("select-all") as HTMLInputElement).checked,
    ).toBe(true);

    browser.clearSelection();
    expect(state.selectedKeys.size).toBe(0);
  });

  it("covers macOS accel toggle, reverse shift range, and stale selection pruning", async () => {
    const browser = await import("../browser.ts");
    const { state } = await import("../state.ts");
    state.platformName = "macos";
    state.prefixes = ["folder/"];
    state.objects = [
      {
        key: "file-a.txt",
        size: 1,
        last_modified: "2024-01-01T00:00:00Z",
        is_folder: false,
      },
      {
        key: "file-b.txt",
        size: 2,
        last_modified: "2024-01-01T00:00:00Z",
        is_folder: false,
      },
      {
        key: "file-c.txt",
        size: 3,
        last_modified: "2024-01-01T00:00:00Z",
        is_folder: false,
      },
      {
        key: "ignored-folder-marker",
        size: 0,
        last_modified: "2024-01-01T00:00:00Z",
        is_folder: true,
      },
    ];
    browser.renderObjectTable();

    browser.handleRowClick(
      "file-c.txt",
      new MouseEvent("click", { bubbles: true }),
    );
    browser.handleRowClick(
      "file-a.txt",
      new MouseEvent("click", { bubbles: true, shiftKey: true }),
    );
    expect(state.selectedKeys.has("file-a.txt")).toBe(true);
    expect(state.selectedKeys.has("file-b.txt")).toBe(true);
    expect(state.selectedKeys.has("file-c.txt")).toBe(true);

    browser.handleRowClick(
      "file-a.txt",
      new MouseEvent("click", { bubbles: true, metaKey: true }),
    );
    expect(state.selectedKeys.has("file-a.txt")).toBe(false);

    state.selectedKeys.add("ghost-file");
    browser.updateSelectionUI();
    expect(state.selectedKeys.has("ghost-file")).toBe(false);
    expect(browser.getSelectableKeys()).not.toContain("ignored-folder-marker");
  });

  it("filters rows, updates modified sort, and handles hasMore toggle", async () => {
    const browser = await import("../browser.ts");
    const { state } = await import("../state.ts");
    state.currentPrefix = "docs/";
    state.filterText = "leaf";
    state.sortColumn = "modified";
    state.sortAsc = true;
    state.hasMore = true;
    state.prefixes = ["docs/leaf-folder/", "docs/other-folder/"];
    state.objects = [
      {
        key: "docs/leaf-a.txt",
        size: 0,
        last_modified: "2024-01-02T00:00:00Z",
        is_folder: false,
      },
      {
        key: "docs/leaf-b.txt",
        size: 10,
        last_modified: "2024-01-01T00:00:00Z",
        is_folder: false,
      },
      {
        key: "docs/other.txt",
        size: 25,
        last_modified: "2024-01-03T00:00:00Z",
        is_folder: false,
      },
    ];

    browser.renderObjectTable();
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>("#object-tbody .object-row"),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0].dataset.prefix).toBe("docs/leaf-folder/");
    expect(rows[1].dataset.key).toBe("docs/leaf-b.txt");
    expect(rows[2].dataset.key).toBe("docs/leaf-a.txt");
    expect(
      (document.getElementById("load-more-row") as HTMLDivElement).style
        .display,
    ).toBe("");
    expect(
      (rows[1].querySelector(".object-size") as HTMLElement).getAttribute(
        "style",
      ),
    ).toContain("linear-gradient");
    expect(
      (rows[2].querySelector(".object-size") as HTMLElement).getAttribute(
        "style",
      ),
    ).toBe(null);

    state.hasMore = false;
    browser.renderObjectTable();
    expect(
      (document.getElementById("load-more-row") as HTMLDivElement).style
        .display,
    ).toBe("none");
  });

  it("updates sort indicators and handles empty state", async () => {
    const browser = await import("../browser.ts");
    const { state } = await import("../state.ts");
    state.objects = [
      {
        key: "a.txt",
        size: 5,
        last_modified: "2024-01-01T00:00:00Z",
        is_folder: false,
      },
      {
        key: "b.txt",
        size: 1,
        last_modified: "2024-01-03T00:00:00Z",
        is_folder: false,
      },
    ];
    browser.renderObjectTable();

    browser.toggleSort("size");
    expect(
      (document.getElementById("sort-size") as HTMLElement).innerHTML,
    ).not.toBe("");
    browser.toggleSort("size");
    expect(
      (
        document.querySelector('th[data-sort="size"]') as HTMLElement
      ).getAttribute("aria-sort"),
    ).toBe("descending");

    state.objects = [];
    state.prefixes = [];
    browser.renderObjectTable();
    expect(
      (document.getElementById("object-tbody") as HTMLElement).textContent,
    ).toContain("No objects");

    browser.showEmptyState();
    expect(
      (document.getElementById("object-panel") as HTMLDivElement).style.display,
    ).toBe("none");
    expect(
      (document.getElementById("bucket-list") as HTMLUListElement).innerHTML,
    ).toBe("");
  });

  it("covers descending prefix sort, zero-size bars, and singular count labels", async () => {
    const browser = await import("../browser.ts");
    const { state } = await import("../state.ts");
    state.sortAsc = false;
    state.prefixes = ["docs/a/", "docs/z/"];
    state.objects = [
      {
        key: "docs/only.txt",
        size: 0,
        last_modified: "2024-01-01T00:00:00Z",
        is_folder: false,
      },
    ];

    browser.renderObjectTable();
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>("#object-tbody .object-row"),
    );
    expect(rows[0].dataset.prefix).toBe("docs/z/");
    expect(rows[1].dataset.prefix).toBe("docs/a/");
    expect(rows[2].dataset.key).toBe("docs/only.txt");
    expect(
      (rows[2].querySelector(".object-size") as HTMLElement).getAttribute(
        "style",
      ),
    ).toBe(null);
    expect(
      (document.getElementById("statusbar-count") as HTMLSpanElement)
        .textContent,
    ).toContain("1 file");
  });

  it("handles missing selection and count/status elements", async () => {
    const browser = await import("../browser.ts");
    const { state } = await import("../state.ts");
    document.getElementById("select-all")?.remove();
    document.getElementById("statusbar-count")?.remove();
    document.getElementById("object-count")?.remove();
    state.prefixes = ["folder/"];
    state.objects = [
      {
        key: "single.txt",
        size: 1,
        last_modified: "2024-01-01T00:00:00Z",
        is_folder: false,
      },
    ];

    expect(() => browser.renderObjectTable()).not.toThrow();
    document.getElementById("status")?.remove();
    expect(() => browser.showEmptyState()).not.toThrow();
  });
});
