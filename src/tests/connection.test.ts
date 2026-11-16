import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SftpConnectCallbacks } from "../connection.ts";

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
      sessionToken: null,
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

  it("connect exposes conditional DELETE support and fails closed when it is absent or malformed", async () => {
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    resetState(state);

    mockInvoke.mockResolvedValueOnce({
      ...CONNECT_RESULT,
      connection_id: "conn-delete-yes",
      conditional_delete_supported: true,
    });
    await connection.connect("https://s3.example.com", "", "k", "s");
    expect(state.conditionalDeleteSupported).toBe(true);

    mockInvoke.mockResolvedValueOnce({
      ...CONNECT_RESULT,
      connection_id: "conn-delete-missing",
    });
    await connection.connect("https://s3.example.com", "", "k", "s");
    expect(state.conditionalDeleteSupported).toBe(false);

    mockInvoke.mockResolvedValueOnce({
      ...CONNECT_RESULT,
      connection_id: "conn-delete-malformed",
      conditional_delete_supported: "yes",
    });
    await connection.connect("https://s3.example.com", "", "k", "s");
    expect(state.conditionalDeleteSupported).toBe(false);
  });

  it("disconnect clears conditional DELETE support", async () => {
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    resetState(state);
    state.conditionalDeleteSupported = true;
    mockInvoke.mockResolvedValueOnce({
      ...CONNECT_RESULT,
      conditional_delete_supported: true,
    });
    await connection.connect("https://s3.example.com", "", "k", "s");
    mockInvoke.mockResolvedValueOnce(undefined);
    await connection.disconnect();
    expect(state.conditionalDeleteSupported).toBe(false);
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
    expect(connection.getConnectionLoadError()).toBe(null);

    mockInvoke.mockResolvedValueOnce("{broken");
    await expect(connection.loadConnection()).resolves.toBeNull();
    expect(connection.getConnectionLoadError()).toContain("parsed");

    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({ endpoint: "https://s3.example.com" }),
    );
    await expect(connection.loadConnection()).resolves.toBeNull();
    expect(connection.getConnectionLoadError()).toContain("corrupt");
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
        {
          key: "docs/tail-1.txt",
          size: 1,
          last_modified: "",
          is_folder: false,
        },
        {
          key: "docs/tail-2.txt",
          size: 1,
          last_modified: "",
          is_folder: false,
        },
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
      objects: [{ key: "b.txt", size: 1, last_modified: "", is_folder: false }],
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

describe("SFTP connection flow and state", () => {
  const SFTP_PARAMS = {
    host: "Example.com",
    port: 22,
    username: "alice",
    authMethod: "password" as const,
    password: "pw",
  };
  const SFTP_CONNECTED = {
    step: "connected",
    connection_id: "sftp-1",
    connection_identity: "sftp-ident-1",
    endpoint: "sftp://example.com:22",
    home_path: "/home/alice",
    host_key: "ssh-ed25519 AAAAC3",
    host_key_fingerprint: "SHA256:abc",
    create_only_supported: true,
  };
  const HOST_KEY_STEP = {
    step: "host_key_unknown",
    attempt_id: "att-1",
    key_type: "ssh-ed25519",
    fingerprint_sha256: "SHA256:abc",
    host_key: "ssh-ed25519 AAAAC3",
  };
  const PROMPT_STEP = {
    step: "prompt",
    attempt_id: "att-2",
    name: "",
    instructions: "",
    prompts: [{ text: "Password: ", echo: false }],
  };
  const S3_RESULT = {
    region: "us-west-2",
    connection_id: "s3-1",
    connection_identity: "s3-ident-1",
    create_only_capabilities: {
      put_object: true,
      complete_multipart: false,
      copy_object: true,
    },
  };
  const SFTP_LISTING = {
    path: "/docs",
    truncated: true,
    entries: [
      {
        name: "a.txt",
        path: "/docs/a.txt",
        kind: "file",
        size: 3,
        mtime: 0,
        permissions: null,
        uid: null,
        gid: null,
        owner: null,
        group: null,
        name_lossy: false,
      },
      {
        name: "sub",
        path: "/docs/sub",
        kind: "dir",
        size: null,
        mtime: null,
        permissions: null,
        uid: null,
        gid: null,
        owner: null,
        group: null,
        name_lossy: false,
      },
    ],
  };

  beforeEach(() => {
    vi.resetModules();
    mockInvoke.mockReset();
  });

  function callbacks(overrides: Partial<SftpConnectCallbacks> = {}) {
    return {
      onHostKeyUnknown: vi.fn(async (): Promise<boolean> => true),
      onPrompt: vi.fn(async (): Promise<string[] | null> => ["pw"]),
      ...overrides,
    };
  }

  function commandCalls(command: string): unknown[][] {
    return mockInvoke.mock.calls.filter(([cmd]) => cmd === command);
  }

  function savedPayload(): string {
    const args: unknown = commandCalls("save_connection")[0]?.[1];
    if (
      typeof args !== "object" ||
      args === null ||
      !("json" in args) ||
      typeof args.json !== "string"
    ) {
      throw new Error("save_connection was not called");
    }
    return args.json;
  }

  function freshState(state: typeof import("../state.ts").state): void {
    state.connected = false;
    state.connecting = false;
    state.protocol = "s3";
    state.sftpHomePath = "";
    state.endpoint = "";
    state.region = "";
    state.connectionId = "";
    state.connectionIdentity = "";
    state.currentBucket = "";
    state.currentPrefix = "";
    state.buckets = [];
    state.objects = [];
    state.prefixes = [];
    state.selectedKeys.clear();
    state.selectedPrefixes.clear();
    state.continuationToken = "";
    state.hasMore = false;
    state.listingCapped = false;
  }

  function route(replies: Record<string, unknown>): void {
    mockInvoke.mockImplementation(async (command) => {
      if (typeof command === "string" && command in replies) {
        const reply = replies[command];
        if (reply instanceof Error) throw reply;
        return reply;
      }
      return undefined;
    });
  }

  it("connectSftp publishes the SFTP session and returns the trusted host key", async () => {
    mockInvoke.mockResolvedValueOnce(SFTP_CONNECTED);
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    freshState(state);
    const cb = callbacks();

    const outcome = await connection.connectSftp(SFTP_PARAMS, cb);

    expect(mockInvoke).toHaveBeenCalledWith("sftp_connect", {
      host: "Example.com",
      port: 22,
      username: "alice",
      authMethod: "password",
      password: "pw",
      privateKey: null,
      passphrase: null,
      pinnedHostKey: null,
    });
    expect(outcome).toEqual({
      endpoint: "sftp://example.com:22",
      hostKey: "ssh-ed25519 AAAAC3",
      hostKeyFingerprint: "SHA256:abc",
      homePath: "/home/alice",
    });
    expect(cb.onHostKeyUnknown).not.toHaveBeenCalled();
    expect(cb.onPrompt).not.toHaveBeenCalled();
    expect(state.connected).toBe(true);
    expect(state.connecting).toBe(true);
    connection.finishConnecting(connection.currentConnectionGeneration());
    expect(state.connecting).toBe(false);
    expect(state.protocol).toBe("sftp");
    expect(state.endpoint).toBe("sftp://example.com:22");
    expect(state.region).toBe("");
    expect(state.connectionId).toBe("sftp-1");
    expect(state.connectionIdentity).toBe("sftp-ident-1");
    expect(state.createOnlyCapabilities).toEqual({
      put_object: true,
      complete_multipart: true,
      copy_object: false,
    });
    expect(state.conditionalDeleteSupported).toBe(false);
    expect(state.sftpHomePath).toBe("/home/alice");
  });

  it("sends a trusted host key only through sftp_connect_continue", async () => {
    route({
      sftp_connect: HOST_KEY_STEP,
      sftp_connect_continue: SFTP_CONNECTED,
    });
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    freshState(state);
    const cb = callbacks();

    const outcome = await connection.connectSftp(SFTP_PARAMS, cb);

    expect(cb.onHostKeyUnknown).toHaveBeenCalledWith(HOST_KEY_STEP);
    expect(commandCalls("sftp_connect_continue")).toEqual([
      ["sftp_connect_continue", { attemptId: "att-1", trustHostKey: true }],
    ]);
    expect(commandCalls("sftp_connect_cancel")).toHaveLength(0);
    expect(outcome.endpoint).toBe("sftp://example.com:22");
    expect(state.connected).toBe(true);
  });

  it("answers a prompt with the callback responses", async () => {
    route({ sftp_connect: PROMPT_STEP, sftp_connect_continue: SFTP_CONNECTED });
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    freshState(state);
    const cb = callbacks({
      onPrompt: vi.fn(async () => ["hunter2"]),
    });

    await connection.connectSftp(SFTP_PARAMS, cb);

    expect(cb.onPrompt).toHaveBeenCalledWith(PROMPT_STEP);
    expect(commandCalls("sftp_connect_continue")).toEqual([
      ["sftp_connect_continue", { attemptId: "att-2", responses: ["hunter2"] }],
    ]);
    expect(state.connected).toBe(true);
  });

  it("a declined host key cancels the pending attempt and never continues", async () => {
    route({ sftp_connect: HOST_KEY_STEP, sftp_connect_cancel: undefined });
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    freshState(state);
    const cb = callbacks({ onHostKeyUnknown: vi.fn(async () => false) });

    await expect(connection.connectSftp(SFTP_PARAMS, cb)).rejects.toThrow(
      "Connection cancelled",
    );

    expect(commandCalls("sftp_connect_cancel")).toEqual([
      ["sftp_connect_cancel", { attemptId: "att-1" }],
    ]);
    expect(commandCalls("sftp_connect_continue")).toHaveLength(0);
    expect(state.connected).toBe(false);
    expect(state.connecting).toBe(false);
  });

  it("a cancelled prompt cancels the pending attempt and never continues", async () => {
    route({ sftp_connect: PROMPT_STEP, sftp_connect_cancel: undefined });
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    freshState(state);
    const cb = callbacks({ onPrompt: vi.fn(async () => null) });

    await expect(connection.connectSftp(SFTP_PARAMS, cb)).rejects.toThrow(
      "Connection cancelled",
    );

    expect(commandCalls("sftp_connect_cancel")).toEqual([
      ["sftp_connect_cancel", { attemptId: "att-2" }],
    ]);
    expect(commandCalls("sftp_connect_continue")).toHaveLength(0);
    expect(state.connecting).toBe(false);
  });

  it("refuses prompt answers that do not match the prompts and cancels the attempt", async () => {
    route({ sftp_connect: PROMPT_STEP, sftp_connect_cancel: undefined });
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    freshState(state);
    const cb = callbacks({ onPrompt: vi.fn(async () => ["one", "two"]) });

    await expect(connection.connectSftp(SFTP_PARAMS, cb)).rejects.toThrow(
      "answers",
    );

    expect(commandCalls("sftp_connect_cancel")).toEqual([
      ["sftp_connect_cancel", { attemptId: "att-2" }],
    ]);
    expect(commandCalls("sftp_connect_continue")).toHaveLength(0);
    expect(state.connected).toBe(false);
  });

  it("a connect cancelled before its first step opens no dialog and cancels the attempt", async () => {
    route({ sftp_connect: HOST_KEY_STEP, sftp_connect_cancel: undefined });
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    freshState(state);
    const cb = callbacks({ isCancelled: () => true });

    await expect(connection.connectSftp(SFTP_PARAMS, cb)).rejects.toThrow(
      "Connection cancelled",
    );

    expect(cb.onHostKeyUnknown).not.toHaveBeenCalled();
    expect(commandCalls("sftp_connect_continue")).toHaveLength(0);
    expect(commandCalls("sftp_connect_cancel")).toEqual([
      ["sftp_connect_cancel", { attemptId: "att-1" }],
    ]);
    expect(state.connected).toBe(false);
  });

  it("a trust answer given after the user cancelled is never sent", async () => {
    route({ sftp_connect: HOST_KEY_STEP, sftp_connect_cancel: undefined });
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    freshState(state);
    let cancelled = false;
    const cb = callbacks({
      onHostKeyUnknown: vi.fn(async () => {
        cancelled = true;
        return true;
      }),
      isCancelled: () => cancelled,
    });

    await expect(connection.connectSftp(SFTP_PARAMS, cb)).rejects.toThrow(
      "Connection cancelled",
    );

    expect(commandCalls("sftp_connect_continue")).toHaveLength(0);
    expect(commandCalls("sftp_connect_cancel")).toEqual([
      ["sftp_connect_cancel", { attemptId: "att-1" }],
    ]);
  });

  it("cancelSftpConnectInFlight reaches the backend only while an SFTP connect runs", async () => {
    let releaseConnect: ((value: unknown) => void) | undefined;
    mockInvoke.mockImplementation(async (command) => {
      if (command === "sftp_connect") {
        return new Promise((resolve) => {
          releaseConnect = resolve;
        });
      }
      return undefined;
    });
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    freshState(state);

    connection.cancelSftpConnectInFlight();
    expect(commandCalls("sftp_connect_cancel_pending")).toHaveLength(0);

    const connecting = connection.connectSftp(SFTP_PARAMS, callbacks());
    await vi.waitFor(() => expect(releaseConnect).toBeDefined());
    connection.cancelSftpConnectInFlight();
    expect(commandCalls("sftp_connect_cancel_pending")).toEqual([
      ["sftp_connect_cancel_pending"],
    ]);

    releaseConnect?.(SFTP_CONNECTED);
    await connecting;
    connection.cancelSftpConnectInFlight();
    expect(commandCalls("sftp_connect_cancel_pending")).toHaveLength(1);
  });

  it("a host key reply that arrives after the connect was superseded is never sent", async () => {
    route({ sftp_connect: HOST_KEY_STEP, sftp_connect_cancel: undefined });
    let resolveTrust: ((value: boolean) => void) | undefined;
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    freshState(state);
    const cb = callbacks({
      onHostKeyUnknown: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveTrust = resolve;
          }),
      ),
    });

    const connecting = connection.connectSftp(SFTP_PARAMS, cb);
    await vi.waitFor(() => expect(cb.onHostKeyUnknown).toHaveBeenCalled());
    connection.setConnectionAccessLocked(true);
    resolveTrust?.(true);

    try {
      await expect(connecting).rejects.toThrow("superseded");
      expect(commandCalls("sftp_connect_continue")).toHaveLength(0);
      expect(commandCalls("sftp_connect_cancel")).toEqual([
        ["sftp_connect_cancel", { attemptId: "att-1" }],
      ]);
      expect(state.connected).toBe(false);
    } finally {
      connection.setConnectionAccessLocked(false);
    }
  });

  it("a prompt reply that arrives after a disconnect is never sent", async () => {
    route({ sftp_connect: PROMPT_STEP, sftp_connect_cancel: undefined });
    let resolvePrompt: ((value: string[] | null) => void) | undefined;
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    freshState(state);
    const cb = callbacks({
      onPrompt: vi.fn(
        () =>
          new Promise<string[] | null>((resolve) => {
            resolvePrompt = resolve;
          }),
      ),
    });

    const connecting = connection.connectSftp(SFTP_PARAMS, cb);
    await vi.waitFor(() => expect(cb.onPrompt).toHaveBeenCalled());
    const disconnecting = connection.disconnect();
    resolvePrompt?.(["hunter2"]);

    await expect(connecting).rejects.toThrow("superseded");
    await expect(disconnecting).resolves.toBe(true);
    expect(commandCalls("sftp_connect_continue")).toHaveLength(0);
    expect(commandCalls("sftp_connect_cancel")).toEqual([
      ["sftp_connect_cancel", { attemptId: "att-2" }],
    ]);
    expect(state.connected).toBe(false);
  });

  it("a callback that throws cancels the pending attempt and rethrows", async () => {
    route({ sftp_connect: HOST_KEY_STEP, sftp_connect_cancel: undefined });
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    freshState(state);
    const cb = callbacks({
      onHostKeyUnknown: vi.fn(async (): Promise<boolean> => {
        throw new Error("dialog failed");
      }),
    });

    await expect(connection.connectSftp(SFTP_PARAMS, cb)).rejects.toThrow(
      "dialog failed",
    );
    expect(commandCalls("sftp_connect_cancel")).toEqual([
      ["sftp_connect_cancel", { attemptId: "att-1" }],
    ]);
    expect(commandCalls("sftp_connect_continue")).toHaveLength(0);
  });

  it("a failed cancel does not replace the original cancellation", async () => {
    route({
      sftp_connect: HOST_KEY_STEP,
      sftp_connect_cancel: new Error("cancel failed"),
    });
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    freshState(state);
    const cb = callbacks({ onHostKeyUnknown: vi.fn(async () => false) });

    await expect(connection.connectSftp(SFTP_PARAMS, cb)).rejects.toThrow(
      "Connection cancelled",
    );
    expect(state.connecting).toBe(false);
  });

  it("a malformed backend step is refused without publishing or cancelling", async () => {
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    freshState(state);

    mockInvoke.mockResolvedValueOnce({ ...SFTP_CONNECTED, connection_id: "" });
    await expect(
      connection.connectSftp(SFTP_PARAMS, callbacks()),
    ).rejects.toThrow();
    expect(state.connected).toBe(false);
    expect(state.connecting).toBe(false);

    mockInvoke.mockResolvedValueOnce({ step: "password" });
    await expect(
      connection.connectSftp(SFTP_PARAMS, callbacks()),
    ).rejects.toThrow();

    const cb = callbacks();
    mockInvoke.mockResolvedValueOnce({ ...HOST_KEY_STEP, attempt_id: "" });
    await expect(connection.connectSftp(SFTP_PARAMS, cb)).rejects.toThrow();
    expect(cb.onHostKeyUnknown).not.toHaveBeenCalled();
    expect(commandCalls("sftp_connect_cancel")).toHaveLength(0);
  });

  it("refuses to connect while encrypted storage is locked", async () => {
    const connection = await import("../connection.ts");
    connection.setConnectionAccessLocked(true);
    try {
      await expect(
        connection.connectSftp(SFTP_PARAMS, callbacks()),
      ).rejects.toThrow("Encrypted storage is locked");
      expect(mockInvoke).not.toHaveBeenCalled();
    } finally {
      connection.setConnectionAccessLocked(false);
    }
  });

  it("a rejected sftp_connect clears the connecting flag and publishes nothing", async () => {
    mockInvoke.mockRejectedValueOnce("Authentication failed");
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    freshState(state);

    await expect(connection.connectSftp(SFTP_PARAMS, callbacks())).rejects.toBe(
      "Authentication failed",
    );
    expect(state.connecting).toBe(false);
    expect(state.connected).toBe(false);
    expect(state.protocol).toBe("s3");
  });

  it("SFTP and S3 session state do not leak across disconnect and reconnect", async () => {
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    freshState(state);

    mockInvoke.mockResolvedValueOnce(S3_RESULT);
    await connection.connect("https://s3.example.com", "", "k", "s");
    expect(state.protocol).toBe("s3");
    expect(state.sftpHomePath).toBe("");

    mockInvoke.mockResolvedValueOnce(undefined);
    await connection.disconnect();

    mockInvoke.mockResolvedValueOnce({
      ...SFTP_CONNECTED,
      create_only_supported: false,
    });
    await connection.connectSftp(SFTP_PARAMS, callbacks());
    expect(state.protocol).toBe("sftp");
    expect(state.sftpHomePath).toBe("/home/alice");
    expect(state.createOnlyCapabilities).toEqual({
      put_object: false,
      complete_multipart: false,
      copy_object: false,
    });

    mockInvoke.mockResolvedValueOnce(undefined);
    await connection.disconnect();
    expect(state.protocol).toBe("s3");
    expect(state.sftpHomePath).toBe("");
    expect(state.createOnlyCapabilities).toEqual({
      put_object: true,
      complete_multipart: true,
      copy_object: true,
    });

    mockInvoke.mockResolvedValueOnce(S3_RESULT);
    await connection.connect("https://s3.example.com", "", "k", "s");
    expect(state.protocol).toBe("s3");
    expect(state.createOnlyCapabilities).toEqual({
      put_object: true,
      complete_multipart: false,
      copy_object: true,
    });
  });

  it("an S3 connect after an SFTP session clears the protocol and home path", async () => {
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    freshState(state);

    mockInvoke.mockResolvedValueOnce(SFTP_CONNECTED);
    await connection.connectSftp(SFTP_PARAMS, callbacks());
    mockInvoke.mockResolvedValueOnce(S3_RESULT);
    await connection.connect("https://s3.example.com", "", "k", "s");

    expect(state.protocol).toBe("s3");
    expect(state.sftpHomePath).toBe("");
  });

  it("refreshBuckets lists the single virtual bucket without a backend call", async () => {
    mockInvoke.mockResolvedValueOnce(SFTP_CONNECTED);
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    freshState(state);
    await connection.connectSftp(SFTP_PARAMS, callbacks());
    mockInvoke.mockClear();

    await connection.refreshBuckets();

    expect(state.buckets).toEqual([{ name: "example.com", creation_date: "" }]);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("refreshObjects lists an SFTP directory and maps it onto the object model", async () => {
    mockInvoke.mockResolvedValueOnce(SFTP_CONNECTED);
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    freshState(state);
    await connection.connectSftp(SFTP_PARAMS, callbacks());
    mockInvoke.mockResolvedValueOnce(SFTP_LISTING);

    await expect(
      connection.refreshObjects("example.com", "docs/"),
    ).resolves.toBe(true);

    expect(mockInvoke).toHaveBeenLastCalledWith("sftp_list_dir", {
      connectionId: "sftp-1",
      path: "/docs",
    });
    expect(state.currentBucket).toBe("example.com");
    expect(state.currentPrefix).toBe("docs/");
    expect(state.objects).toEqual([
      {
        key: "docs/a.txt",
        size: 3,
        last_modified: "1970-01-01T00:00:00.000Z",
        is_folder: false,
        sftp_kind: "file",
        name_lossy: false,
      },
    ]);
    expect(state.prefixes).toEqual(["docs/sub/"]);
    expect(state.listingCapped).toBe(true);
    expect(state.hasMore).toBe(false);
    expect(state.continuationToken).toBe("");
  });

  it("drops an SFTP listing that finishes after its session was disconnected", async () => {
    mockInvoke.mockResolvedValueOnce(SFTP_CONNECTED);
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    freshState(state);
    await connection.connectSftp(SFTP_PARAMS, callbacks());
    let resolveListing: ((value: unknown) => void) | undefined;
    mockInvoke.mockImplementation(async (command) => {
      if (command === "sftp_list_dir") {
        return new Promise((resolve) => {
          resolveListing = resolve;
        });
      }
      return undefined;
    });

    const pending = connection.refreshObjects("example.com", "");
    await connection.disconnect();
    resolveListing?.(SFTP_LISTING);

    await expect(pending).resolves.toBe(false);
    expect(state.objects).toEqual([]);
    expect(state.protocol).toBe("s3");
  });

  it("keeps the previous listing when the SFTP listing is malformed", async () => {
    mockInvoke.mockResolvedValueOnce(SFTP_CONNECTED);
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    freshState(state);
    await connection.connectSftp(SFTP_PARAMS, callbacks());
    state.currentBucket = "example.com";
    state.currentPrefix = "docs/";
    state.objects = [
      { key: "docs/keep.txt", size: 1, last_modified: "", is_folder: false },
    ];
    mockInvoke.mockResolvedValueOnce({
      ...SFTP_LISTING,
      entries: [{ ...SFTP_LISTING.entries[0], name: "x/y", path: "/docs/x/y" }],
    });

    await expect(
      connection.refreshObjects("example.com", "docs/"),
    ).rejects.toThrow();
    expect(state.objects.map((object) => object.key)).toEqual([
      "docs/keep.txt",
    ]);
  });

  it("loadMoreObjects is a no-op for SFTP even when a token is present", async () => {
    const connection = await import("../connection.ts");
    const { state } = await import("../state.ts");
    freshState(state);
    state.connected = true;
    state.protocol = "sftp";
    state.connectionId = "sftp-1";
    state.hasMore = true;
    state.continuationToken = "token";

    await connection.loadMoreObjects();

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(state.hasMore).toBe(true);
    expect(state.continuationToken).toBe("token");
  });

  it("saveSftpConnection stores the password shape bound to the session", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    const connection = await import("../connection.ts");

    await connection.saveSftpConnection("sftp-1", {
      endpoint: "sftp://Example.com:22",
      username: "alice",
      secret: "pw",
      auth: "password",
    });

    expect(mockInvoke).toHaveBeenCalledWith("save_connection", {
      connectionId: "sftp-1",
      json: expect.any(String),
    });
    expect(JSON.parse(savedPayload())).toEqual({
      protocol: "sftp",
      endpoint: "sftp://example.com:22",
      region: "",
      access_key: "alice",
      secret_key: "pw",
      sftp: { auth: "password" },
    });
  });

  it("saveSftpConnection stores the key path and pinned host key", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    const connection = await import("../connection.ts");

    await connection.saveSftpConnection("sftp-1", {
      endpoint: "sftp://example.com:22",
      username: "alice",
      secret: "phrase",
      auth: "key",
      privateKey: "KEYTEXT",
      hostKey: "ssh-ed25519 AAA",
    });

    expect(JSON.parse(savedPayload())).toEqual({
      protocol: "sftp",
      endpoint: "sftp://example.com:22",
      region: "",
      access_key: "alice",
      secret_key: "phrase",
      sftp: {
        auth: "key",
        private_key: "KEYTEXT",
        host_key: "ssh-ed25519 AAA",
      },
    });
  });

  it("saveSftpConnection refuses bad input before anything is saved", async () => {
    const connection = await import("../connection.ts");

    await expect(
      connection.saveSftpConnection("", {
        endpoint: "sftp://example.com:22",
        username: "alice",
        secret: "pw",
        auth: "password",
      }),
    ).rejects.toThrow("Connection id is required");
    await expect(
      connection.saveSftpConnection("sftp-1", {
        endpoint: "https://example.com",
        username: "alice",
        secret: "pw",
        auth: "password",
      }),
    ).rejects.toThrow();
    await expect(
      connection.saveSftpConnection("sftp-1", {
        endpoint: "sftp://example.com:22",
        username: "alice",
        secret: "pw",
        auth: "key",
        privateKey: "x".repeat(16385),
      }),
    ).rejects.toThrow();
    expect(commandCalls("save_connection")).toHaveLength(0);
  });

  it("loadConnection accepts a saved SFTP connection and reports every other shape as corrupt", async () => {
    const connection = await import("../connection.ts");
    const SAVED_SFTP = {
      protocol: "sftp",
      endpoint: "sftp://example.com:22",
      region: "",
      access_key: "alice",
      secret_key: "pw",
      sftp: { auth: "password" },
    };
    mockInvoke.mockResolvedValueOnce(JSON.stringify(SAVED_SFTP));
    await expect(connection.loadConnection()).resolves.toEqual(SAVED_SFTP);
    expect(connection.getConnectionLoadError()).toBeNull();

    const corrupt: unknown[] = [
      { ...SAVED_SFTP, protocol: "ftp" },
      { ...SAVED_SFTP, endpoint: "https://example.com" },
      { ...SAVED_SFTP, sftp: undefined },
      { ...SAVED_SFTP, sftp: { auth: "agent" } },
      {
        endpoint: "https://s3.example.com",
        region: "",
        access_key: "k",
        secret_key: "s",
        sftp: { auth: "password" },
      },
      {
        endpoint: "sftp://example.com:22",
        region: "",
        access_key: "k",
        secret_key: "s",
      },
    ];
    for (const row of corrupt) {
      mockInvoke.mockResolvedValueOnce(JSON.stringify(row));
      await expect(connection.loadConnection()).resolves.toBeNull();
      expect(connection.getConnectionLoadError()).toContain("corrupt");
    }
  });
});
