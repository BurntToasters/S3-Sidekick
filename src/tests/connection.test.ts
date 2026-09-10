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
  create_only_capabilities: {
    put_object: true,
    complete_multipart: false,
    copy_object: true,
  },
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
    expect(state.createOnlyCapabilities).toEqual({
      put_object: true,
      complete_multipart: false,
      copy_object: true,
    });
  });

  it("connect treats missing or malformed capability metadata as unsupported", async () => {
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    resetState(state);

    mockInvoke.mockResolvedValueOnce({
      region: "us-west-2",
      connection_id: "conn-missing",
      connection_identity: "ident-missing",
    });
    await connection.connect("https://s3.example.com", "", "k", "s");
    expect(state.createOnlyCapabilities).toEqual({
      put_object: false,
      complete_multipart: false,
      copy_object: false,
    });

    mockInvoke.mockResolvedValueOnce({
      region: "us-west-2",
      connection_id: "conn-malformed",
      connection_identity: "ident-malformed",
      create_only_capabilities: {
        put_object: true,
        complete_multipart: "yes",
        copy_object: true,
      },
    });
    await connection.connect("https://s3.example.com", "", "k", "s");
    expect(state.createOnlyCapabilities).toEqual({
      put_object: false,
      complete_multipart: false,
      copy_object: false,
    });
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
    mockInvoke.mockRejectedValueOnce(new Error("disconnect failed"));

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

    await expect(connection.disconnect()).rejects.toThrow("disconnect failed");
    expect(state.connected).toBe(true);
    expect(state.currentBucket).toBe("bucket-a");
    expect(state.currentPrefix).toBe("nested/");
    expect(state.objects.map((object) => object.key)).toEqual([
      "nested/file.txt",
    ]);
    expect(state.selectedKeys).toEqual(new Set(["nested/file.txt"]));

    mockInvoke.mockResolvedValueOnce(undefined);
    await expect(connection.disconnect()).resolves.toBe(true);

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
    mockInvoke.mockRejectedValueOnce(new Error("Connection changed"));

    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    resetState(state);
    state.connected = true;
    state.connectionId = "conn-new";
    state.connectionIdentity = "ident-new";
    state.endpoint = "https://new.example.com";

    const pending = connection.disconnect("conn-old");
    expect(state.connected).toBe(true);
    expect(state.connectionId).toBe("conn-new");
    await expect(pending).resolves.toBe(false);

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
    let resolveListing: ((value: unknown) => void) | undefined;
    mockInvoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveListing = resolve;
        }),
    );
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    resetState(state);
    state.connectionId = "conn-1";
    state.connectionIdentity = "ident-1";
    state.currentBucket = "bucket-old";
    state.currentPrefix = "old/";
    state.objects = [
      {
        key: "old/file.txt",
        size: 1,
        last_modified: "old",
        is_folder: false,
      },
    ];
    state.prefixes = ["old/"];
    state.continuationToken = "old-token";
    state.hasMore = true;
    state.selectedKeys.add("old-key");

    const pending = connection.refreshObjects("bucket-a", "docs/");
    expect(state.currentBucket).toBe("bucket-old");
    expect(state.currentPrefix).toBe("old/");
    expect(state.objects.map((object) => object.key)).toEqual(["old/file.txt"]);
    expect(state.selectedKeys).toEqual(new Set(["old-key"]));

    resolveListing?.({
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
    await expect(pending).resolves.toBe(true);

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
    await expect(first).resolves.toBe(false);
    expect(state.currentBucket).toBe("");
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
    await expect(second).resolves.toBe(true);
    expect(state.currentBucket).toBe("bucket-b");
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
      create_only_capabilities: {
        put_object: true,
        complete_multipart: true,
        copy_object: true,
      },
    });

    await expect(connecting).rejects.toThrow("superseded");
    await expect(disconnecting).resolves.toBe(true);
    expect(state.connected).toBe(false);
    expect(state.endpoint).toBe("");
  });

  it("ignores stale bucket responses and stale bucket errors", async () => {
    const resolvers: Array<{
      resolve: (v: unknown) => void;
      reject: (e: unknown) => void;
    }> = [];
    mockInvoke.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          resolvers.push({ resolve, reject });
        }),
    );
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    resetState(state);
    state.connectionId = "conn-1";
    state.connectionIdentity = "ident-1";

    const first = connection.refreshBuckets();
    const second = connection.refreshBuckets();
    expect(resolvers.length).toBe(2);

    resolvers[1]?.resolve([{ name: "fresh", creation_date: "t" }]);
    await expect(second).resolves.toBeUndefined();
    expect(state.buckets).toEqual([{ name: "fresh", creation_date: "t" }]);

    resolvers[0]?.resolve([{ name: "stale", creation_date: "t" }]);
    await expect(first).resolves.toBeUndefined();
    expect(state.buckets).toEqual([{ name: "fresh", creation_date: "t" }]);

    // Stale error is swallowed; fresh error is thrown.
    const errResolvers: Array<{
      resolve: (v: unknown) => void;
      reject: (e: unknown) => void;
    }> = [];
    mockInvoke.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          errResolvers.push({ resolve, reject });
        }),
    );
    const staleFail = connection.refreshBuckets();
    const freshOk = connection.refreshBuckets();
    errResolvers[0]?.reject(new Error("stale boom"));
    errResolvers[1]?.resolve([]);
    await expect(staleFail).resolves.toBeUndefined();
    await expect(freshOk).resolves.toBeUndefined();

    mockInvoke.mockRejectedValueOnce(new Error("fresh boom"));
    await expect(connection.refreshBuckets()).rejects.toThrow("fresh boom");
  });

  it("second connect supersedes the first without overwriting fresh state", async () => {
    const resolvers: Array<(v: typeof CONNECT_RESULT) => void> = [];
    mockInvoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve as (v: typeof CONNECT_RESULT) => void);
        }),
    );
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    resetState(state);

    const first = connection.connect("https://a.example.com", "", "k", "s");
    const second = connection.connect("https://b.example.com", "", "k", "s");
    resolvers[1]?.({
      region: "us-east-1",
      connection_id: "conn-fresh",
      connection_identity: "ident-fresh",
      create_only_capabilities: {
        put_object: true,
        complete_multipart: true,
        copy_object: true,
      },
    });
    await expect(second).resolves.toBe("us-east-1");
    expect(state.connectionId).toBe("conn-fresh");

    resolvers[0]?.({
      region: "us-east-1",
      connection_id: "conn-stale",
      connection_identity: "ident-stale",
      create_only_capabilities: {
        put_object: true,
        complete_multipart: true,
        copy_object: true,
      },
    });
    await expect(first).rejects.toThrow("superseded");
    expect(state.connectionId).toBe("conn-fresh");
    expect(state.endpoint).toBe("https://b.example.com");
  });

  it("synthesizeMissingPrefixes derives immediate children from markers only", async () => {
    const connection = await import("../connection.ts");
    const obj = (key: string) => ({
      key,
      size: 0,
      last_modified: "",
      is_folder: false,
    });

    // Nested marker synthesizes only the immediate child.
    expect(
      connection.synthesizeMissingPrefixes(
        [obj("docs/a/b/"), obj("docs/a/file.txt")],
        [],
        "docs/",
      ),
    ).toEqual(["docs/a/"]);

    // Marker-only folder with no prefixes entry.
    expect(
      connection.synthesizeMissingPrefixes([obj("docs/empty/")], [], "docs/"),
    ).toEqual(["docs/empty/"]);

    // Existing prefix is not duplicated; duplicate markers collapse.
    expect(
      connection.synthesizeMissingPrefixes(
        [obj("docs/empty/"), obj("docs/empty/")],
        ["docs/empty/"],
        "docs/",
      ),
    ).toEqual([]);

    // Non-markers, outside-prefix keys, and the prefix itself are ignored.
    expect(
      connection.synthesizeMissingPrefixes(
        [
          obj("docs/file.txt"),
          obj("other/folder/"),
          obj("docs/"),
          { ...obj("docs/no-slash-marker"), key: "docs/noslash" },
        ],
        [],
        "docs/",
      ),
    ).toEqual([]);
  });

  it("loadMoreObjects dedupes repeated boundary keys across pages", async () => {
    mockInvoke.mockResolvedValueOnce({
      objects: [
        { key: "docs/a.txt", size: 1, last_modified: "", is_folder: false },
        { key: "docs/b.txt", size: 2, last_modified: "", is_folder: false },
      ],
      prefixes: ["docs/", "extra/"],
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
      { key: "docs/a.txt", size: 1, last_modified: "", is_folder: false },
    ];
    state.prefixes = ["docs/"];
    state.hasMore = true;
    state.continuationToken = "token-1";

    await connection.loadMoreObjects();
    expect(state.objects.map((o) => o.key)).toEqual([
      "docs/a.txt",
      "docs/b.txt",
    ]);
    expect(state.prefixes).toEqual(["docs/", "extra/"]);
  });

  it("loadMoreObjects ignores stale paginated responses", async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    mockInvoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    resetState(state);
    state.connectionId = "conn-1";
    state.connectionIdentity = "ident-1";
    state.currentBucket = "bucket-a";
    state.currentPrefix = "docs/";
    state.objects = [
      { key: "docs/a.txt", size: 1, last_modified: "", is_folder: false },
    ];
    state.prefixes = [];
    state.hasMore = true;
    state.continuationToken = "token-1";

    const first = connection.loadMoreObjects();
    const second = connection.loadMoreObjects();
    resolvers[0]?.({
      objects: [
        { key: "docs/stale.txt", size: 9, last_modified: "", is_folder: false },
      ],
      prefixes: [],
      truncated: false,
      next_continuation_token: "",
    });
    await first;
    expect(state.objects.map((o) => o.key)).toEqual(["docs/a.txt"]);

    resolvers[1]?.({
      objects: [
        { key: "docs/fresh.txt", size: 9, last_modified: "", is_folder: false },
      ],
      prefixes: [],
      truncated: false,
      next_continuation_token: "",
    });
    await second;
    expect(state.objects.map((o) => o.key)).toEqual([
      "docs/a.txt",
      "docs/fresh.txt",
    ]);
  });

  it("loadMoreObjects caps accumulation and stops pagination", async () => {
    document.body.innerHTML = "";
    const objects = Array.from({ length: 4999 }, (_, i) => ({
      key: `docs/f-${i}.txt`,
      size: 1,
      last_modified: "",
      is_folder: false,
    }));
    mockInvoke.mockResolvedValueOnce({
      objects: [
        { key: "docs/tail-1.txt", size: 1, last_modified: "", is_folder: false },
        { key: "docs/tail-2.txt", size: 1, last_modified: "", is_folder: false },
      ],
      prefixes: ["docs/extra/"],
      truncated: true,
      next_continuation_token: "more",
    });
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    resetState(state);
    state.connectionId = "conn-1";
    state.connectionIdentity = "ident-1";
    state.currentBucket = "bucket-a";
    state.currentPrefix = "docs/";
    state.objects = [...objects];
    state.prefixes = ["docs/"];
    state.hasMore = true;
    state.continuationToken = "token-1";

    await connection.loadMoreObjects();
    expect(state.hasMore).toBe(false);
    expect(state.continuationToken).toBe("");
    expect(document.getElementById("toast-region")?.textContent).toContain(
      "Listing capped",
    );
  });

  it("refresh re-drives one trailing listing behind navigation", async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    mockInvoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    resetState(state);
    state.connectionId = "conn-1";
    state.connectionIdentity = "ident-1";

    const navigating = connection.refreshObjects("bucket-a", "");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const trailingFirst = connection.refreshObjects("bucket-a", "", {
      supersedePending: false,
    });
    const trailingSecond = connection.refreshObjects("bucket-a", "", {
      supersedePending: false,
    });
    // Coalesced automatic refreshes share one promise.
    expect(trailingFirst).toBe(trailingSecond);
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    resolvers[0]?.({
      objects: [],
      prefixes: [],
      truncated: false,
      next_continuation_token: "",
    });
    await expect(navigating).resolves.toBe(true);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ bucket: "bucket-a" }),
    );

    resolvers[1]?.({
      objects: [
        { key: "b.txt", size: 1, last_modified: "", is_folder: false },
      ],
      prefixes: [],
      truncated: false,
      next_continuation_token: "",
    });
    await expect(trailingFirst).resolves.toBe(true);
    expect(state.currentBucket).toBe("bucket-a");
  });

  it("stale refresh failure parks as false while fresh failure throws", async () => {
    const resolvers: Array<{
      resolve: (v: unknown) => void;
      reject: (e: unknown) => void;
    }> = [];
    mockInvoke.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          resolvers.push({ resolve, reject });
        }),
    );
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    resetState(state);
    state.connectionId = "conn-1";
    state.connectionIdentity = "ident-1";

    const first = connection.refreshObjects("bucket-a", "");
    const second = connection.refreshObjects("bucket-b", "");
    resolvers[0]?.reject(new Error("stale list boom"));
    await expect(first).resolves.toBe(false);
    resolvers[1]?.resolve({
      objects: [],
      prefixes: [],
      truncated: false,
      next_continuation_token: "",
    });
    await expect(second).resolves.toBe(true);

    mockInvoke.mockRejectedValueOnce(new Error("fresh list boom"));
    await expect(connection.refreshObjects("bucket-a", "")).rejects.toThrow(
      "fresh list boom",
    );
  });
});
