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

const CONNECT_RESULT = {
  region: "us-west-2",
  connection_id: "conn-1",
  connection_identity: "ident-1",
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
    state.connectionId = "";
    state.connectionIdentity = "";
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
    mockInvoke.mockResolvedValueOnce(CONNECT_RESULT);

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
    expect(state.connecting).toBe(true);
    connection.finishConnecting(connection.currentConnectionGeneration());
    expect(state.connecting).toBe(false);
    expect(state.endpoint).toBe("https://s3.example.com");
    expect(state.region).toBe("us-west-2");
    expect(state.connectionId).toBe("conn-1");
    expect(state.connectionIdentity).toBe("ident-1");
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
    state.connectionId = "conn-1";
    state.connectionIdentity = "ident-1";
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

    expect(mockInvoke).toHaveBeenCalledWith("disconnect", {
      connectionId: "conn-1",
    });
    expect(state.connected).toBe(false);
    expect(state.endpoint).toBe("");
    expect(state.region).toBe("");
    expect(state.connectionId).toBe("");
    expect(state.connectionIdentity).toBe("");
    expect(state.currentBucket).toBe("");
    expect(state.currentPrefix).toBe("");
    expect(state.buckets).toEqual([]);
    expect(state.objects).toEqual([]);
    expect(state.prefixes).toEqual([]);
    expect(state.selectedKeys.size).toBe(0);
    expect(state.continuationToken).toBe("");
    expect(state.hasMore).toBe(false);
  });

  it("disconnect does not clear a newer session", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);

    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    resetState(state);
    state.connected = true;
    state.connectionId = "conn-new";
    state.connectionIdentity = "ident-new";
    state.endpoint = "https://new.example.com";

    await connection.disconnect("conn-old");

    expect(mockInvoke).toHaveBeenCalledWith("disconnect", {
      connectionId: "conn-old",
    });
    expect(state.connected).toBe(true);
    expect(state.connectionId).toBe("conn-new");
    expect(state.connectionIdentity).toBe("ident-new");
  });

  it("invokeS3For injects the supplied connection id", async () => {
    mockInvoke.mockResolvedValueOnce([]);

    const connection = await import("../connection.ts");
    await connection.invokeS3For("frozen-id", "list_buckets", { extra: 1 });

    expect(mockInvoke).toHaveBeenCalledWith("list_buckets", {
      extra: 1,
      connectionId: "frozen-id",
    });
  });

  it("invokeS3For rejects an empty connection id", async () => {
    const connection = await import("../connection.ts");
    expect(() => connection.invokeS3For("", "list_buckets")).toThrow(
      "Connection id is required",
    );
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("saveConnection serializes data for backend", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    const connection = await import("../connection.ts");
    await connection.saveConnection(
      "conn-1",
      "https://s3.example.com",
      "us-east-1",
      "AKIA1",
      "secret1",
    );

    expect(mockInvoke).toHaveBeenCalledWith("save_connection", {
      connectionId: "conn-1",
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
    state.connectionId = "conn-1";
    state.connectionIdentity = "ident-1";

    await connection.refreshBuckets();

    expect(mockInvoke).toHaveBeenCalledWith("list_buckets", {
      connectionId: "conn-1",
    });
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
    state.connectionId = "conn-1";
    state.connectionIdentity = "ident-1";
    state.selectedKeys.add("old-key");

    await connection.refreshObjects("bucket-a", "docs/");

    expect(mockInvoke).toHaveBeenCalledWith("list_objects", {
      bucket: "bucket-a",
      prefix: "docs/",
      delimiter: "/",
      continuationToken: "",
      connectionId: "conn-1",
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
    state.connectionId = "conn-1";
    state.connectionIdentity = "ident-1";
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
      connectionId: "conn-1",
    });
    expect(state.objects.map((o) => o.key)).toEqual([
      "docs/file-1.txt",
      "docs/file-2.txt",
    ]);
    expect(state.prefixes).toEqual(["docs/", "images/"]);
    expect(state.hasMore).toBe(false);
    expect(state.continuationToken).toBe("");
  });

  it("ignores stale object responses after navigation", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    let resolveSecond: ((value: unknown) => void) | undefined;
    mockInvoke.mockImplementation(async (command, payload) => {
      if (command !== "list_objects") return undefined;
      const bucket = (payload as { bucket: string }).bucket;
      return new Promise((resolve) => {
        if (bucket === "bucket-a") resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    });

    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    resetState(state);
    state.connectionId = "conn-1";
    state.connectionIdentity = "ident-1";
    const first = connection.refreshObjects("bucket-a", "");
    const second = connection.refreshObjects("bucket-b", "");

    resolveFirst?.({
      objects: [
        {
          key: "old.txt",
          size: 1,
          last_modified: "",
          is_folder: false,
        },
      ],
      prefixes: [],
      truncated: false,
      next_continuation_token: "",
    });
    await first;
    expect(state.currentBucket).toBe("bucket-b");
    expect(state.objects).toEqual([]);

    resolveSecond?.({
      objects: [
        {
          key: "new.txt",
          size: 2,
          last_modified: "",
          is_folder: false,
        },
      ],
      prefixes: [],
      truncated: false,
      next_continuation_token: "",
    });
    await second;
    expect(state.objects.map((object) => object.key)).toEqual(["new.txt"]);
  });

  it("does not let a superseded connect overwrite disconnect state", async () => {
    let resolveConnect: ((value: typeof CONNECT_RESULT) => void) | undefined;
    mockInvoke.mockImplementation(async (command) => {
      if (command === "connect") {
        return new Promise((resolve) => {
          resolveConnect = resolve;
        });
      }
      return undefined;
    });

    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    resetState(state);
    const connecting = connection.connect(
      "https://slow.example.com",
      "us-east-1",
      "key",
      "secret",
    );
    const disconnecting = connection.disconnect();
    resolveConnect?.({
      region: "us-east-1",
      connection_id: "stale",
      connection_identity: "stale-ident",
    });

    await expect(connecting).rejects.toThrow("superseded");
    await disconnecting;
    expect(state.connected).toBe(false);
    expect(state.endpoint).toBe("");
  });
});
