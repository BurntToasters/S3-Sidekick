import { beforeEach, describe, expect, it, vi } from "vitest";

let failNextRefresh = false;
let stateModule: typeof import("../state.ts") | null = null;

const refreshObjectsMock = vi.fn(async (bucket: string, prefix: string) => {
  if (stateModule) {
    stateModule.state.currentBucket = bucket;
    stateModule.state.currentPrefix = prefix;
    stateModule.state.objects = [];
    stateModule.state.prefixes = [];
    stateModule.state.continuationToken = "";
    stateModule.state.hasMore = false;
  }
  if (failNextRefresh) {
    failNextRefresh = false;
    throw new Error("simulated navigation failure");
  }
});

vi.mock("../connection.ts", () => ({
  refreshObjects: refreshObjectsMock,
}));

function renderFixture(): void {
  document.body.innerHTML = `
    <input id="filter-input" />
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
    <div id="batch-toolbar" hidden><span id="batch-count"></span></div>
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

describe("browser navigation recovery", () => {
  beforeEach(async () => {
    vi.resetModules();
    refreshObjectsMock.mockClear();
    failNextRefresh = false;
    renderFixture();
    stateModule = await import("../state.ts");
    stateModule.state.selectedKeys.clear();
    stateModule.state.objects = [];
    stateModule.state.prefixes = [];
    stateModule.state.sortColumn = "name";
    stateModule.state.sortAsc = true;
    stateModule.state.filterText = "";
    stateModule.state.currentBucket = "";
    stateModule.state.currentPrefix = "";
  });

  it("restores nav behavior after a failed back navigation", async () => {
    const browser = await import("../browser.ts");

    await browser.selectBucket("bucket-a");
    await browser.navigateToFolder("x/");

    failNextRefresh = true;
    await browser.navigateBack();

    await browser.navigateToFolder("y/");
    await browser.navigateBack();

    expect(stateModule?.state.currentPrefix).toBe("x/");
  });

  it("handles back/forward transitions across bucket history", async () => {
    const browser = await import("../browser.ts");

    await browser.selectBucket("bucket-a");
    await browser.selectBucket("bucket-b");

    await browser.navigateBack();
    expect(stateModule?.state.currentBucket).toBe("bucket-a");

    await browser.navigateForward();
    expect(stateModule?.state.currentBucket).toBe("bucket-b");
  });

  it("no-ops back and forward when history bounds are reached", async () => {
    const browser = await import("../browser.ts");

    const beforeCalls = refreshObjectsMock.mock.calls.length;
    await browser.navigateBack();
    await browser.navigateForward();
    expect(refreshObjectsMock.mock.calls.length).toBe(beforeCalls);

    await browser.selectBucket("bucket-a");
    await browser.navigateForward();
    expect(stateModule?.state.currentBucket).toBe("bucket-a");
  });

  it("navigates up one level and no-ops at root", async () => {
    const browser = await import("../browser.ts");

    await browser.selectBucket("bucket-a");
    await browser.navigateToFolder("a/b/c/");
    expect(
      (document.getElementById("nav-up") as HTMLButtonElement).disabled,
    ).toBe(false);
    await browser.navigateUp();
    expect(stateModule?.state.currentPrefix).toBe("a/b/");

    await browser.navigateToFolder("");
    expect(
      (document.getElementById("nav-up") as HTMLButtonElement).disabled,
    ).toBe(true);
    const beforeCalls = refreshObjectsMock.mock.calls.length;
    await browser.navigateUp();
    expect(refreshObjectsMock.mock.calls.length).toBe(beforeCalls);
  });

  it("parses location paths and navigates via path input", async () => {
    const browser = await import("../browser.ts");
    stateModule!.state.buckets = [
      { name: "bucket-a", creation_date: "2024-01-01" },
      { name: "bucket-b", creation_date: "2024-01-02" },
    ];

    expect(browser.parseLocationPath("")).toBeNull();
    expect(browser.parseLocationPath("bucket-a")).toEqual({
      bucket: "bucket-a",
      prefix: "",
    });
    expect(browser.parseLocationPath("s3://bucket-a/docs/sub")).toEqual({
      bucket: "bucket-a",
      prefix: "docs/sub/",
    });
    expect(browser.formatLocationPath("bucket-a", "docs/")).toBe(
      "bucket-a/docs/",
    );

    await browser.selectBucket("bucket-a");
    await browser.navigateToLocationPath("bucket-a/x/y/");
    expect(stateModule?.state.currentBucket).toBe("bucket-a");
    expect(stateModule?.state.currentPrefix).toBe("x/y/");
    expect(
      (document.getElementById("location-omnibar-edit") as HTMLInputElement)
        .value,
    ).toBe("bucket-a/x/y/");

    await browser.navigateToLocationPath("bucket-b/");
    expect(stateModule?.state.currentBucket).toBe("bucket-b");
    expect(stateModule?.state.currentPrefix).toBe("");

    const ok = await browser.navigateToLocationPath("missing-bucket/");
    expect(ok).toBe(false);
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Unknown bucket");
  });

  it("clears nav history and disables nav controls", async () => {
    const browser = await import("../browser.ts");

    await browser.selectBucket("bucket-a");
    await browser.navigateToFolder("x/");
    await browser.clearNavHistory();

    const backBtn = document.getElementById("nav-back") as HTMLButtonElement;
    const fwdBtn = document.getElementById("nav-forward") as HTMLButtonElement;
    expect(backBtn.disabled).toBe(true);
    expect(fwdBtn.disabled).toBe(true);
  });

  it("restores snapshot and sets status when forward navigation fails", async () => {
    const browser = await import("../browser.ts");

    await browser.selectBucket("bucket-a");
    await browser.navigateToFolder("x/");
    await browser.navigateToFolder("y/");
    await browser.navigateBack();
    expect(stateModule?.state.currentPrefix).toBe("x/");

    failNextRefresh = true;
    await browser.navigateForward();

    expect(stateModule?.state.currentPrefix).toBe("x/");
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Navigation failed:");
  });

  it("covers missing nav/filter/status elements and status-timeout replacement", async () => {
    vi.useFakeTimers();
    const browser = await import("../browser.ts");

    document.getElementById("nav-back")?.remove();
    document.getElementById("nav-forward")?.remove();
    document.getElementById("filter-input")?.remove();

    await browser.selectBucket("bucket-a");
    await browser.navigateToFolder("x/");
    await browser.navigateToFolder("y/");

    failNextRefresh = true;
    await browser.navigateBack();
    failNextRefresh = true;
    await browser.navigateBack();

    document.getElementById("status")?.remove();
    await vi.advanceTimersByTimeAsync(6000);
    vi.useRealTimers();
  });
});
