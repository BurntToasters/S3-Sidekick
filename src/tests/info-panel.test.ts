import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

function renderFixture(): void {
  document.body.innerHTML = `
    <div id="info-overlay" class="modal-overlay">
      <h2 id="info-title"></h2>
      <div class="info-tabs">
        <button class="info-tab info-tab--active" data-tab="general"></button>
        <button class="info-tab" data-tab="permissions"></button>
        <button class="info-tab" data-tab="metadata"></button>
        <button class="info-tab" data-tab="s3"></button>
      </div>
      <div id="info-body"></div>
      <button id="info-save">Save</button>
      <button id="info-close"></button>
      <button id="info-cancel"></button>
    </div>
    <div id="status"></div>
  `;
}

async function flushMicrotasks(cycles = 3): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve();
  }
}

function headPayload(
  overrides: Partial<{
    content_type: string;
    content_length: number;
    last_modified: string;
    etag: string;
    storage_class: string;
    cache_control: string;
    content_disposition: string;
    content_encoding: string;
    server_side_encryption: string;
    metadata: Record<string, string>;
  }> = {},
) {
  return {
    content_type: "text/plain",
    content_length: 10,
    last_modified: "2025-01-01T00:00:00Z",
    etag: '"etag-default"',
    storage_class: "STANDARD",
    cache_control: "",
    content_disposition: "",
    content_encoding: "",
    server_side_encryption: "",
    metadata: {},
    ...overrides,
  };
}

describe("info panel", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockInvoke.mockReset();
    renderFixture();
    const { state } = await import("../state.ts");
    state.currentBucket = "bucket-a";
    state.statusTimeout = undefined;
  });

  it("opens a single object and renders tabs/permissions/s3", async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "head_object") {
        return {
          content_type: "text/plain",
          content_length: 123,
          last_modified: "2025-01-01T10:00:00Z",
          etag: '"etag123"',
          storage_class: "STANDARD",
          cache_control: "max-age=3600",
          content_disposition: "",
          content_encoding: "",
          server_side_encryption: "AES256",
          metadata: { project: "sidekick" },
        };
      }
      if (cmd === "build_object_url") {
        return "https://example.com/notes.txt";
      }
      if (cmd === "get_object_acl") {
        return {
          owner: "owner-1",
          grants: [{ grantee: "user:a", permission: "READ" }],
        };
      }
      return undefined;
    });

    const info = await import("../info-panel.ts");
    await info.openInfoPanel(["docs/notes.txt"]);
    await flushMicrotasks();

    expect(
      (
        document.getElementById("info-overlay") as HTMLDivElement
      ).classList.contains("active"),
    ).toBe(true);
    expect(
      (document.getElementById("info-title") as HTMLHeadingElement).textContent,
    ).toBe("notes.txt");
    expect(
      (document.getElementById("info-body") as HTMLDivElement).textContent,
    ).toContain("Content Type");
    expect(
      (document.getElementById("info-body") as HTMLDivElement).textContent,
    ).toContain("https://example.com/notes.txt");

    info.switchTab("permissions");
    await flushMicrotasks();
    expect(
      (document.getElementById("info-body") as HTMLDivElement).textContent,
    ).toContain("owner-1");
    expect(
      (document.getElementById("info-body") as HTMLDivElement).textContent,
    ).toContain("READ");

    info.switchTab("metadata");
    expect(document.querySelectorAll(".metadata-entry").length).toBeGreaterThan(
      0,
    );
    (document.getElementById("metadata-add-row") as HTMLButtonElement).click();
    expect(document.querySelectorAll(".metadata-entry").length).toBeGreaterThan(
      1,
    );

    info.switchTab("s3");
    expect(
      (document.getElementById("info-body") as HTMLDivElement).textContent,
    ).toContain("Storage Class");
  });

  it("handles single-file load errors and single-file save failures", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("head failed"));
    const info = await import("../info-panel.ts");
    await info.openInfoPanel(["broken/file.txt"]);

    expect(
      (document.getElementById("info-body") as HTMLDivElement).textContent,
    ).toContain("Failed to load");

    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "head_object") {
        return {
          content_type: "text/plain",
          content_length: 10,
          last_modified: "2025-01-01T00:00:00Z",
          etag: '"e1"',
          storage_class: "STANDARD",
          cache_control: "",
          content_disposition: "",
          content_encoding: "",
          server_side_encryption: "",
          metadata: {},
        };
      }
      if (cmd === "update_metadata") {
        throw new Error("update failed");
      }
      return "";
    });

    await info.openInfoPanel(["broken-save.txt"]);
    info.switchTab("metadata");
    (document.getElementById("metadata-add-row") as HTMLButtonElement).click();
    const keyInputs = Array.from(
      document.querySelectorAll<HTMLInputElement>(".metadata-entry__key"),
    );
    const valInputs = Array.from(
      document.querySelectorAll<HTMLInputElement>(".metadata-entry__value"),
    );
    keyInputs[1].value = "Cache-Control";
    keyInputs[1].dispatchEvent(new Event("input", { bubbles: true }));
    valInputs[1].value = "no-cache";
    valInputs[1].dispatchEvent(new Event("input", { bubbles: true }));
    await info.saveInfoPanel();

    expect(
      (document.getElementById("status") as HTMLDivElement).textContent,
    ).toContain("Failed to update metadata");
    expect(
      (document.getElementById("info-save") as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (document.getElementById("info-save") as HTMLButtonElement).textContent,
    ).toBe("Save");
  });

  it("supports single-file metadata save success", async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "head_object") {
        return {
          content_type: "text/plain",
          content_length: 10,
          last_modified: "2025-01-01T00:00:00Z",
          etag: '"e2"',
          storage_class: "STANDARD",
          cache_control: "",
          content_disposition: "",
          content_encoding: "",
          server_side_encryption: "",
          metadata: {},
        };
      }
      if (cmd === "update_metadata") return undefined;
      return "";
    });

    const info = await import("../info-panel.ts");
    await info.openInfoPanel(["single-success.txt"]);
    info.switchTab("metadata");
    (document.getElementById("metadata-add-row") as HTMLButtonElement).click();

    const keyInputs = Array.from(
      document.querySelectorAll<HTMLInputElement>(".metadata-entry__key"),
    );
    const valInputs = Array.from(
      document.querySelectorAll<HTMLInputElement>(".metadata-entry__value"),
    );
    keyInputs[1].value = "Cache-Control";
    keyInputs[1].dispatchEvent(new Event("input", { bubbles: true }));
    valInputs[1].value = "max-age=60";
    valInputs[1].dispatchEvent(new Event("input", { bubbles: true }));

    await info.saveInfoPanel();

    expect(mockInvoke).toHaveBeenCalledWith(
      "update_metadata",
      expect.objectContaining({
        bucket: "bucket-a",
        key: "single-success.txt",
        contentType: "text/plain",
        metadata: { "Cache-Control": "max-age=60" },
      }),
    );
    expect(
      (
        document.getElementById("info-overlay") as HTMLDivElement
      ).classList.contains("active"),
    ).toBe(false);
    expect(
      (document.getElementById("status") as HTMLDivElement).textContent,
    ).toContain("Metadata updated.");
  });

  it("updates single-file visibility from private to public", async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "head_object") return headPayload();
      if (cmd === "build_object_url") return "";
      if (cmd === "get_object_acl") {
        return {
          owner: "owner-1",
          grants: [{ grantee: "owner-1", permission: "FULL_CONTROL" }],
        };
      }
      if (cmd === "set_object_acl") return undefined;
      return undefined;
    });

    const info = await import("../info-panel.ts");
    await info.openInfoPanel(["single-acl.txt"]);
    info.switchTab("permissions");
    await flushMicrotasks();

    const visibility = document.getElementById(
      "permissions-visibility",
    ) as HTMLSelectElement;
    visibility.value = "public-read";
    visibility.dispatchEvent(new Event("change", { bubbles: true }));

    await info.saveInfoPanel();

    expect(mockInvoke).toHaveBeenCalledWith("set_object_acl", {
      bucket: "bucket-a",
      key: "single-acl.txt",
      visibility: "public-read",
    });
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "update_metadata",
      expect.anything(),
    );
    expect(
      (document.getElementById("status") as HTMLDivElement).textContent,
    ).toContain("Permissions updated.");
  });

  it("does not rewrite metadata when saving a single file with no edits", async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "head_object") return headPayload();
      if (cmd === "build_object_url") return "";
      if (cmd === "update_metadata") return undefined;
      if (cmd === "set_object_acl") return undefined;
      return undefined;
    });

    const info = await import("../info-panel.ts");
    await info.openInfoPanel(["no-change.txt"]);
    await info.saveInfoPanel();

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "update_metadata",
      expect.anything(),
    );
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "set_object_acl",
      expect.anything(),
    );
    expect(
      (document.getElementById("status") as HTMLDivElement).textContent,
    ).toContain("No property changes to apply");
  });

  it("updates batch visibility without requiring metadata edits", async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "set_object_acl") return undefined;
      return undefined;
    });

    const info = await import("../info-panel.ts");
    await info.openInfoPanel(["alpha.txt", "beta.txt"]);

    const visibility = document.getElementById(
      "batch-visibility",
    ) as HTMLSelectElement;
    visibility.value = "public-read";
    visibility.dispatchEvent(new Event("change", { bubbles: true }));

    await info.saveInfoPanel();

    expect(mockInvoke).toHaveBeenCalledWith("set_object_acl", {
      bucket: "bucket-a",
      key: "alpha.txt",
      visibility: "public-read",
    });
    expect(mockInvoke).toHaveBeenCalledWith("set_object_acl", {
      bucket: "bucket-a",
      key: "beta.txt",
      visibility: "public-read",
    });
    expect(
      (document.getElementById("status") as HTMLDivElement).textContent,
    ).toContain("Permissions updated on 2 file(s).");
  });

  it("reports partial failures when one of metadata/permissions fails in batch properties", async () => {
    mockInvoke.mockImplementation(async (cmd, payload) => {
      const key = (payload as { key?: string } | undefined)?.key;
      if (cmd === "head_object") {
        return headPayload({ metadata: { existing: "1" } });
      }
      if (cmd === "update_metadata") return undefined;
      if (cmd === "set_object_acl" && key === "beta.txt") {
        throw new Error("acl failed");
      }
      if (cmd === "set_object_acl") return undefined;
      return undefined;
    });

    const info = await import("../info-panel.ts");
    await info.openInfoPanel(["alpha.txt", "beta.txt"]);

    const visibility = document.getElementById(
      "batch-visibility",
    ) as HTMLSelectElement;
    visibility.value = "public-read";
    visibility.dispatchEvent(new Event("change", { bubbles: true }));

    const keyInput = document.querySelector<HTMLInputElement>(
      ".metadata-entry__key",
    );
    const valInput = document.querySelector<HTMLInputElement>(
      ".metadata-entry__value",
    );
    keyInput!.value = "Cache-Control";
    keyInput!.dispatchEvent(new Event("input", { bubbles: true }));
    valInput!.value = "no-cache";
    valInput!.dispatchEvent(new Event("input", { bubbles: true }));

    await info.saveInfoPanel();

    expect(
      (document.getElementById("status") as HTMLDivElement).textContent,
    ).toContain("1 partial");
  });

  it("handles batch selection views and partial batch save failures", async () => {
    mockInvoke.mockImplementation(async (cmd, payload) => {
      const key = (payload as { key?: string } | undefined)?.key;
      if (cmd === "head_object" && key === "alpha.txt") {
        return {
          content_type: "text/plain",
          content_length: 1,
          last_modified: "2025-01-01T00:00:00Z",
          etag: '"a"',
          storage_class: "STANDARD",
          cache_control: "",
          content_disposition: "",
          content_encoding: "",
          server_side_encryption: "",
          metadata: { source: "alpha" },
        };
      }
      if (cmd === "head_object" && key === "beta.txt") {
        throw new Error("head failed");
      }
      if (cmd === "update_metadata") return undefined;
      return "";
    });

    const info = await import("../info-panel.ts");

    await info.openInfoPanel(["prefix:one/", "prefix:two/"]);
    expect(
      (document.getElementById("info-save") as HTMLButtonElement).style.display,
    ).toBe("none");
    expect(
      (document.querySelector(".info-tabs") as HTMLDivElement).style.display,
    ).toBe("none");
    expect(
      (document.getElementById("info-body") as HTMLDivElement).textContent,
    ).toContain("folder(s)");

    await info.openInfoPanel(["alpha.txt", "prefix:folder/", "beta.txt"]);
    const keyInput = document.querySelector<HTMLInputElement>(
      ".metadata-entry__key",
    );
    const valInput = document.querySelector<HTMLInputElement>(
      ".metadata-entry__value",
    );
    expect(keyInput).toBeTruthy();
    expect(valInput).toBeTruthy();
    keyInput!.value = "Cache-Control";
    keyInput!.dispatchEvent(new Event("input", { bubbles: true }));
    valInput!.value = "no-cache";
    valInput!.dispatchEvent(new Event("input", { bubbles: true }));

    await info.saveInfoPanel();

    expect(mockInvoke).toHaveBeenCalledWith(
      "update_metadata",
      expect.objectContaining({
        key: "alpha.txt",
        metadata: expect.objectContaining({
          source: "alpha",
          "Cache-Control": "no-cache",
        }),
      }),
    );
    expect(
      (document.getElementById("status") as HTMLDivElement).textContent,
    ).toContain("1 failed");
  });

  it("resets panel state on close", async () => {
    mockInvoke.mockResolvedValue({
      content_type: "text/plain",
      content_length: 1,
      last_modified: "2025-01-01T00:00:00Z",
      etag: '"x"',
      storage_class: "STANDARD",
      cache_control: "",
      content_disposition: "",
      content_encoding: "",
      server_side_encryption: "",
      metadata: {},
    });
    const info = await import("../info-panel.ts");
    await info.openInfoPanel(["close-me.txt"]);
    expect(
      (
        document.getElementById("info-overlay") as HTMLDivElement
      ).classList.contains("active"),
    ).toBe(true);

    info.closeInfoPanel();
    expect(
      (
        document.getElementById("info-overlay") as HTMLDivElement
      ).classList.contains("active"),
    ).toBe(false);
  });

  it("renders optional metadata rows, ACL no-grants fallback, and S3 defaults", async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "head_object") {
        return {
          content_type: "application/octet-stream",
          content_length: 8,
          last_modified: "2025-01-01T00:00:00Z",
          etag: '"etag-opt"',
          storage_class: "",
          cache_control: "",
          content_disposition: "attachment",
          content_encoding: "gzip",
          server_side_encryption: "",
          metadata: {},
        };
      }
      if (cmd === "build_object_url") return "";
      if (cmd === "get_object_acl") return { owner: "", grants: [] };
      return undefined;
    });
    const info = await import("../info-panel.ts");
    await info.openInfoPanel(["optional.bin"]);
    await flushMicrotasks();

    const body = document.getElementById("info-body") as HTMLDivElement;
    expect(body.textContent).toContain("Content-Disposition");
    expect(body.textContent).toContain("Content-Encoding");

    info.switchTab("permissions");
    await flushMicrotasks();
    expect(body.textContent).toContain("N/A");
    expect(body.textContent).toContain("No ACL grants found");

    info.switchTab("s3");
    expect(body.textContent).toContain("STANDARD");
    expect(body.textContent).toContain("None");
  });

  it("shows permissions load failures", async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "head_object") {
        return {
          content_type: "text/plain",
          content_length: 10,
          last_modified: "2025-01-01T00:00:00Z",
          etag: '"acl-err"',
          storage_class: "STANDARD",
          cache_control: "",
          content_disposition: "",
          content_encoding: "",
          server_side_encryption: "",
          metadata: {},
        };
      }
      if (cmd === "build_object_url") return "";
      if (cmd === "get_object_acl") throw new Error("acl failed");
      return undefined;
    });
    const info = await import("../info-panel.ts");
    await info.openInfoPanel(["acl-fail.txt"]);
    info.switchTab("permissions");
    await flushMicrotasks();

    expect(
      (document.getElementById("info-body") as HTMLDivElement).textContent,
    ).toContain("Failed to load permissions");
  });

  it("validates empty batch metadata, supports delete-row, and handles full batch success", async () => {
    vi.useFakeTimers();
    mockInvoke.mockImplementation(async (cmd, payload) => {
      const key = (payload as { key?: string } | undefined)?.key;
      if (
        cmd === "head_object" &&
        (key === "alpha.txt" || key === "beta.txt")
      ) {
        return {
          content_type: "text/plain",
          content_length: 1,
          last_modified: "2025-01-01T00:00:00Z",
          etag: '"batch"',
          storage_class: "STANDARD",
          cache_control: "",
          content_disposition: "",
          content_encoding: "",
          server_side_encryption: "",
          metadata: { existing: "1" },
        };
      }
      if (cmd === "update_metadata") return undefined;
      return "";
    });
    const info = await import("../info-panel.ts");

    await info.openInfoPanel(["alpha.txt", "beta.txt"]);
    await info.saveInfoPanel();
    expect(
      (document.getElementById("status") as HTMLDivElement).textContent,
    ).toContain("No property changes to apply");

    const addBtn = document.getElementById(
      "metadata-add-row",
    ) as HTMLButtonElement;
    addBtn.click();
    let keyInputs = Array.from(
      document.querySelectorAll<HTMLInputElement>(".metadata-entry__key"),
    );
    let deleteButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".metadata-entry__delete"),
    );
    expect(deleteButtons.length).toBeGreaterThan(0);
    deleteButtons[deleteButtons.length - 1].click();
    keyInputs = Array.from(
      document.querySelectorAll<HTMLInputElement>(".metadata-entry__key"),
    );
    expect(keyInputs.length).toBe(1);

    const keyInput = keyInputs[0];
    const valInput = document.querySelector<HTMLInputElement>(
      ".metadata-entry__value",
    );
    keyInput.value = "Cache-Control";
    keyInput.dispatchEvent(new Event("input", { bubbles: true }));
    valInput!.value = "public, max-age=3600";
    valInput!.dispatchEvent(new Event("input", { bubbles: true }));

    await info.saveInfoPanel();
    expect(mockInvoke).toHaveBeenCalledWith(
      "update_metadata",
      expect.objectContaining({
        key: "alpha.txt",
        metadata: expect.objectContaining({
          existing: "1",
          "Cache-Control": "public, max-age=3600",
        }),
      }),
    );
    expect(mockInvoke).toHaveBeenCalledWith(
      "update_metadata",
      expect.objectContaining({
        key: "beta.txt",
      }),
    );
    expect(
      (
        document.getElementById("info-overlay") as HTMLDivElement
      ).classList.contains("active"),
    ).toBe(false);
    expect(
      (document.getElementById("status") as HTMLDivElement).textContent,
    ).toContain("Metadata updated on 2 file(s).");

    await info.saveInfoPanel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(
      (document.getElementById("status") as HTMLDivElement).textContent,
    ).toBe("");
    vi.useRealTimers();
  });

  it("ignores stale single-object head responses (success and error) after selection changes", async () => {
    let resolveSlowHead: (value: ReturnType<typeof headPayload>) => void = () =>
      undefined;
    let rejectSlowHead: (reason?: unknown) => void = () => undefined;
    mockInvoke.mockImplementation(async (cmd, payload) => {
      const key = (payload as { key?: string } | undefined)?.key;
      if (cmd === "head_object" && key === "slow-success.txt") {
        return new Promise<ReturnType<typeof headPayload>>((resolve) => {
          resolveSlowHead = resolve;
        });
      }
      if (cmd === "head_object" && key === "slow-fail.txt") {
        return new Promise<ReturnType<typeof headPayload>>((_, reject) => {
          rejectSlowHead = reject;
        });
      }
      if (cmd === "head_object") {
        return headPayload({ etag: `"${key}"` });
      }
      if (cmd === "build_object_url") return "";
      return undefined;
    });

    const info = await import("../info-panel.ts");

    const firstOpen = info.openInfoPanel(["slow-success.txt"]);
    await flushMicrotasks();
    await info.openInfoPanel(["fast.txt"]);
    resolveSlowHead(headPayload({ etag: '"slow-success"' }));
    await firstOpen;
    await flushMicrotasks();

    expect(
      (document.getElementById("info-title") as HTMLHeadingElement).textContent,
    ).toBe("fast.txt");
    expect(
      (document.getElementById("info-body") as HTMLDivElement).textContent,
    ).toContain("Content Type");

    const secondOpen = info.openInfoPanel(["slow-fail.txt"]);
    await flushMicrotasks();
    await info.openInfoPanel(["new-fast.txt"]);
    rejectSlowHead(new Error("late failure"));
    await expect(secondOpen).resolves.toBeUndefined();
    await flushMicrotasks();

    expect(
      (document.getElementById("info-title") as HTMLHeadingElement).textContent,
    ).toBe("new-fast.txt");
    expect(
      (document.getElementById("info-body") as HTMLDivElement).textContent,
    ).not.toContain("Failed to load");
  });

  it("ignores stale permissions responses and tolerates missing metadata value datalist", async () => {
    let resolveAcl: (value: {
      owner: string;
      grants: Array<{ grantee: string; permission: string }>;
    }) => void = () => undefined;
    let rejectAcl: (reason?: unknown) => void = () => undefined;
    mockInvoke.mockImplementation(async (cmd, payload) => {
      const key = (payload as { key?: string } | undefined)?.key;
      if (cmd === "head_object") return headPayload();
      if (cmd === "build_object_url") return "";
      if (cmd === "get_object_acl" && key === "perm-success.txt") {
        return new Promise<{
          owner: string;
          grants: Array<{ grantee: string; permission: string }>;
        }>((resolve) => {
          resolveAcl = resolve;
        });
      }
      if (cmd === "get_object_acl" && key === "perm-error.txt") {
        return new Promise<{
          owner: string;
          grants: Array<{ grantee: string; permission: string }>;
        }>((_, reject) => {
          rejectAcl = reject;
        });
      }
      if (cmd === "update_metadata") return undefined;
      return undefined;
    });

    const info = await import("../info-panel.ts");

    await info.openInfoPanel(["perm-success.txt"]);
    info.switchTab("permissions");
    await flushMicrotasks();
    info.switchTab("general");
    resolveAcl({
      owner: "stale-owner",
      grants: [{ grantee: "u", permission: "READ" }],
    });
    await flushMicrotasks();
    expect(
      (document.getElementById("info-body") as HTMLDivElement).textContent,
    ).not.toContain("stale-owner");

    await info.openInfoPanel(["perm-error.txt"]);
    info.switchTab("permissions");
    await flushMicrotasks();
    info.switchTab("general");
    rejectAcl(new Error("stale acl failure"));
    await flushMicrotasks();
    expect(
      (document.getElementById("info-body") as HTMLDivElement).textContent,
    ).not.toContain("Failed to load permissions");

    info.switchTab("metadata");
    const missingDatalist = document.getElementById("metadata-val-0");
    missingDatalist?.remove();
    const keyInput = document.querySelector<HTMLInputElement>(
      ".metadata-entry__key",
    ) as HTMLInputElement;
    keyInput.value = "Cache-Control";
    keyInput.dispatchEvent(new Event("input", { bubbles: true }));

    (document.getElementById("metadata-add-row") as HTMLButtonElement).click();
    const valueInputs = Array.from(
      document.querySelectorAll<HTMLInputElement>(".metadata-entry__value"),
    );
    valueInputs[1].value = "ignored-empty-key";
    valueInputs[1].dispatchEvent(new Event("input", { bubbles: true }));
    await info.saveInfoPanel();

    expect(mockInvoke).toHaveBeenCalledWith(
      "update_metadata",
      expect.objectContaining({
        key: "perm-error.txt",
        metadata: {},
      }),
    );
  });

  it("clears existing status timeout and handles missing status element safely", async () => {
    vi.useFakeTimers();
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "head_object") return headPayload();
      if (cmd === "update_metadata") return undefined;
      if (cmd === "build_object_url") return "";
      return undefined;
    });
    const info = await import("../info-panel.ts");
    const { state } = await import("../state.ts");

    state.statusTimeout = setTimeout(() => undefined, 10000);
    document.getElementById("status")?.remove();
    await info.openInfoPanel(["status-safe.txt"]);
    await info.saveInfoPanel();
    await vi.advanceTimersByTimeAsync(5000);

    expect(state.statusTimeout).toBeUndefined();
    vi.useRealTimers();
  });
});
