import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

const DEFAULT_STATE = {
  connected: false,
  connecting: false,
  endpoint: "",
  region: "",
  currentBucket: "",
  currentPrefix: "",
  buckets: [],
  objects: [],
  prefixes: [],
  continuationToken: "",
  hasMore: false,
};

describe("connection module", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockInvoke.mockReset();
  });

  function resetState(state: typeof import("../state.ts").state): void {
    state.connected = DEFAULT_STATE.connected;
    state.connecting = DEFAULT_STATE.connecting;
    state.endpoint = DEFAULT_STATE.endpoint;
    state.region = DEFAULT_STATE.region;
    state.currentBucket = DEFAULT_STATE.currentBucket;
    state.currentPrefix = DEFAULT_STATE.currentPrefix;
    state.buckets = [];
    state.objects = [];
    state.prefixes = [];
    state.selectedKeys.clear();
    state.continuationToken = DEFAULT_STATE.continuationToken;
    state.hasMore = DEFAULT_STATE.hasMore;
  }

  it("connect sets state and returns resolved region", async () => {
    mockInvoke.mockResolvedValueOnce("us-west-2");

    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    resetState(state);

    const resolvedRegion = await connection.connect(
      "https://s3.example.com",
      "",
      "AKIA123",
      "secret",
    );

    expect(resolvedRegion).toBe("us-west-2");
    expect(mockInvoke).toHaveBeenCalledWith("connect", {
      endpoint: "https://s3.example.com",
      region: "",
      accessKey: "AKIA123",
      secretKey: "secret",
    });
    expect(state.connected).toBe(true);
    expect(state.connecting).toBe(false);
    expect(state.endpoint).toBe("https://s3.example.com");
    expect(state.region).toBe("us-west-2");
  });

  it("connect clears connecting flag on failure", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("boom"));

    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    resetState(state);

    await expect(
      connection.connect("https://s3.example.com", "us-east-1", "k", "s"),
    ).rejects.toThrow("boom");
    expect(state.connecting).toBe(false);
    expect(state.connected).toBe(false);
  });

  it("disconnect resets state fields", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);

    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    resetState(state);
    state.connected = true;
    state.endpoint = "https://s3.example.com";
    state.region = "us-east-1";
    state.currentBucket = "bucket-a";
    state.currentPrefix = "nested/";
    state.buckets = [{ name: "bucket-a", creation_date: "today" }];
    state.objects = [
      {
        key: "nested/file.txt",
        size: 12,
        last_modified: "now",
        is_folder: false,
      },
    ];
    state.prefixes = ["nested/"];
    state.selectedKeys.add("nested/file.txt");
    state.continuationToken = "token";
    state.hasMore = true;

    await connection.disconnect();

    expect(mockInvoke).toHaveBeenCalledWith("disconnect");
    expect(state.connected).toBe(false);
    expect(state.endpoint).toBe("");
    expect(state.region).toBe("");
    expect(state.currentBucket).toBe("");
    expect(state.currentPrefix).toBe("");
    expect(state.buckets).toEqual([]);
    expect(state.objects).toEqual([]);
    expect(state.prefixes).toEqual([]);
    expect(state.selectedKeys.size).toBe(0);
    expect(state.continuationToken).toBe("");
    expect(state.hasMore).toBe(false);
  });

  it("saveConnection serializes data for backend", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    const connection = await import("../connection.ts");
    await connection.saveConnection(
      "https://s3.example.com",
      "us-east-1",
      "AKIA1",
      "secret1",
    );

    expect(mockInvoke).toHaveBeenCalledWith("save_connection", {
      json: JSON.stringify({
        endpoint: "https://s3.example.com",
        region: "us-east-1",
        access_key: "AKIA1",
        secret_key: "secret1",
      }),
    });
  });

  it("loadConnection returns parsed connection when shape is valid", async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        endpoint: "https://s3.example.com",
        region: "us-east-1",
        access_key: "AKIA1",
        secret_key: "secret1",
      }),
    );
    const connection = await import("../connection.ts");
    await expect(connection.loadConnection()).resolves.toEqual({
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      access_key: "AKIA1",
      secret_key: "secret1",
    });
  });

  it("loadConnection returns null for empty, invalid JSON, and wrong shape", async () => {
    const connection = await import("../connection.ts");

    mockInvoke.mockResolvedValueOnce("");
    await expect(connection.loadConnection()).resolves.toBeNull();

    mockInvoke.mockResolvedValueOnce("{broken");
    await expect(connection.loadConnection()).resolves.toBeNull();

    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({ endpoint: "https://s3.example.com" }),
    );
    await expect(connection.loadConnection()).resolves.toBeNull();
  });

  it("refreshBuckets stores returned buckets", async () => {
    mockInvoke.mockResolvedValueOnce([
      { name: "bucket-a", creation_date: "2024-01-01" },
      { name: "bucket-b", creation_date: "2024-01-02" },
    ]);
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    resetState(state);

    await connection.refreshBuckets();

    expect(mockInvoke).toHaveBeenCalledWith("list_buckets");
    expect(state.buckets).toEqual([
      { name: "bucket-a", creation_date: "2024-01-01" },
      { name: "bucket-b", creation_date: "2024-01-02" },
    ]);
  });

  it("refreshObjects replaces listing state and clears selection", async () => {
    mockInvoke.mockResolvedValueOnce({
      objects: [
        {
          key: "docs/readme.txt",
          size: 1024,
          last_modified: "2024-01-01T00:00:00Z",
          is_folder: false,
        },
      ],
      prefixes: ["docs/"],
      truncated: true,
      next_continuation_token: "next-token",
    });
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    resetState(state);
    state.selectedKeys.add("old-key");

    await connection.refreshObjects("bucket-a", "docs/");

    expect(mockInvoke).toHaveBeenCalledWith("list_objects", {
      bucket: "bucket-a",
      prefix: "docs/",
      delimiter: "/",
      continuationToken: "",
    });
    expect(state.currentBucket).toBe("bucket-a");
    expect(state.currentPrefix).toBe("docs/");
    expect(state.objects).toHaveLength(1);
    expect(state.prefixes).toEqual(["docs/"]);
    expect(state.continuationToken).toBe("next-token");
    expect(state.hasMore).toBe(true);
    expect(state.selectedKeys.size).toBe(0);
  });

  it("loadMoreObjects is a no-op when pagination is not active", async () => {
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    resetState(state);
    state.hasMore = false;
    state.continuationToken = "";

    await connection.loadMoreObjects();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("loadMoreObjects appends objects and deduplicates prefixes", async () => {
    mockInvoke.mockResolvedValueOnce({
      objects: [
        {
          key: "docs/file-2.txt",
          size: 22,
          last_modified: "2024-01-02T00:00:00Z",
          is_folder: false,
        },
      ],
      prefixes: ["docs/", "images/"],
      truncated: false,
      next_continuation_token: "",
    });
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    resetState(state);
    state.currentBucket = "bucket-a";
    state.currentPrefix = "docs/";
    state.objects = [
      {
        key: "docs/file-1.txt",
        size: 11,
        last_modified: "2024-01-01T00:00:00Z",
        is_folder: false,
      },
    ];
    state.prefixes = ["docs/"];
    state.hasMore = true;
    state.continuationToken = "token-1";

    await connection.loadMoreObjects();

    expect(mockInvoke).toHaveBeenCalledWith("list_objects", {
      bucket: "bucket-a",
      prefix: "docs/",
      delimiter: "/",
      continuationToken: "token-1",
    });
    expect(state.objects.map((o) => o.key)).toEqual([
      "docs/file-1.txt",
      "docs/file-2.txt",
    ]);
    expect(state.prefixes).toEqual(["docs/", "images/"]);
    expect(state.hasMore).toBe(false);
    expect(state.continuationToken).toBe("");
  });
});
