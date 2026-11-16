import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatSftpEndpoint,
  isSftpAlreadyExists,
  isSftpConnectionLost,
  isSftpRemotePath,
  isSftpSettings,
  isValidSftpEndpoint,
  looksLikeSftpEndpoint,
  MAX_SFTP_HOST_KEY_LENGTH,
  MAX_SFTP_PRIVATE_KEY_LENGTH,
  parseSftpConnectStep,
  parseSftpDeleteResult,
  parseSftpEndpoint,
  parseSftpEntry,
  parseSftpExists,
  parseSftpListResponse,
  parseSftpPreviewResponse,
  parseSftpRenameOutcome,
  parseSftpUploadOutcome,
  parseSshPrivateKeyInfo,
  parseSftpVoid,
  sftpCreateOnlyCapabilities,
  sftpFailureFocusTarget,
  sftpHomeFallbackMessage,
  sftpKeyFromPath,
  sftpListingToObjects,
  sftpPathFromKey,
  sftpVirtualBucket,
  SFTP_ALREADY_EXISTS,
  SFTP_CONNECTION_LOST,
  type SftpEntry,
  type SftpListResponse,
} from "../sftp.ts";
import { NO_CREATE_ONLY_CAPABILITIES } from "../create-only-capabilities.ts";

/**
 * Failure modes, written before the implementation:
 * - A relative, `~`, `.`, `..`, empty-segment, trailing-slash, or NUL path is
 *   accepted, so an action can name a path outside the browsed directory.
 * - Key and path mapping adds or drops a level, or changes a name with spaces,
 *   `+`, or unicode, so a listing row points at a different remote file.
 * - An endpoint with a scheme, path, userinfo, bare IPv6, port 0, a leading
 *   zero, or no port is accepted, which forks the connection identity.
 * - A connect step with an unknown tag, a missing attempt ID, or a bad endpoint
 *   or home path is accepted and published.
 * - A listing entry with a separator or dot name, a path bound to another
 *   name, an unknown kind, or a fractional or negative size is accepted.
 * - A key or password is copied into an error message.
 * - An unrelated message is treated as a lost SFTP connection.
 * - A failed connect moves focus to a control that is not on screen, or to
 *   the wrong one for the chosen auth method or the error.
 * - The fallback notice shows an empty or unparseable remembered folder.
 */

function entry(
  overrides: Partial<SftpEntry> & { name: string; path: string },
): SftpEntry {
  return {
    kind: "file",
    size: null,
    mtime: null,
    permissions: null,
    uid: null,
    gid: null,
    owner: null,
    group: null,
    name_lossy: false,
    ...overrides,
  };
}

const VALID_FILE = entry({
  name: "report.pdf",
  path: "/docs/report.pdf",
  size: 1024,
  mtime: 1700000000,
  permissions: 0o644,
  uid: 1000,
  gid: 1000,
  owner: "alice",
  group: "staff",
});

const VALID_CONNECTED = {
  step: "connected",
  connection_id: "sftp-1",
  connection_identity: "ident-1",
  endpoint: "sftp://example.com:22",
  home_path: "/home/alice",
  host_key: "ssh-ed25519 AAAAC3",
  host_key_fingerprint: "SHA256:abc",
  create_only_supported: false,
};

describe("SFTP remote paths and key mapping", () => {
  it("maps the root, folders, and files between keys and paths", () => {
    expect(sftpPathFromKey("")).toBe("/");
    expect(sftpPathFromKey("a/b/")).toBe("/a/b");
    expect(sftpPathFromKey("a/f.txt")).toBe("/a/f.txt");
    expect(sftpKeyFromPath("/", true)).toBe("");
    expect(sftpKeyFromPath("/a/b", true)).toBe("a/b/");
    expect(sftpKeyFromPath("/a/b", false)).toBe("a/b");
  });

  it("round-trips names with spaces, plus signs, and unicode", () => {
    const keys: Array<[string, boolean]> = [
      ["", true],
      ["docs/", true],
      ["my docs/", true],
      ["my docs/a b+c.txt", false],
      ["a+b/", true],
      ["é/ünï/€.txt", false],
      ["deep/er/est/", true],
    ];
    for (const [key, isDir] of keys) {
      const path = sftpPathFromKey(key);
      expect(isSftpRemotePath(path)).toBe(true);
      expect(sftpKeyFromPath(path, isDir)).toBe(key);
    }
    for (const path of ["/", "/a b", "/a/b c/d+e", "/ünï/€"]) {
      expect(sftpPathFromKey(sftpKeyFromPath(path, true))).toBe(path);
    }
    for (const path of ["/a b", "/a/b c/d+e", "/ünï/€"]) {
      expect(sftpPathFromKey(sftpKeyFromPath(path, false))).toBe(path);
    }
  });

  it("refuses keys and paths that would name an invalid remote path", () => {
    for (const key of ["a//", "/a", "a/./b", "a/../b", "a\0b"]) {
      expect(() => sftpPathFromKey(key), key).toThrow();
    }
    expect(() => sftpKeyFromPath("a/b", true)).toThrow();
    expect(() => sftpKeyFromPath("/a/", false)).toThrow();
    expect(() => sftpKeyFromPath("/", false)).toThrow();
    expect(() => sftpKeyFromPath("/a//b", false)).toThrow();
  });

  it("accepts only absolute, normalized paths within the byte limit", () => {
    for (const path of [
      "/",
      "/a",
      "/a/b.txt",
      "/a b/c d",
      "/a/.hidden",
      "/a/..b",
      "/a/b..",
      "/ünï/€",
    ]) {
      expect(isSftpRemotePath(path), path).toBe(true);
    }
    for (const path of [
      "",
      "a",
      "a/b",
      "./a",
      "~/a",
      "../a",
      "/a/",
      "//",
      "//a",
      "/a//b",
      "/a/b//",
      "/.",
      "/..",
      "/a/.",
      "/a/..",
      "/a/../b",
      "/./a",
      "/a\0b",
      "/a/b\0",
    ]) {
      expect(isSftpRemotePath(path), JSON.stringify(path)).toBe(false);
    }
    expect(isSftpRemotePath(`/${"a".repeat(4095)}`)).toBe(true);
    expect(isSftpRemotePath(`/${"a".repeat(4096)}`)).toBe(false);
    // 2047 two-byte characters plus the slash is 4095 bytes; 2048 is 4097.
    expect(isSftpRemotePath(`/${"é".repeat(2047)}`)).toBe(true);
    expect(isSftpRemotePath(`/${"é".repeat(2048)}`)).toBe(false);
  });
});

describe("SFTP endpoints", () => {
  it("formats the normalized endpoint, bracketing IPv6 hosts", () => {
    expect(formatSftpEndpoint("example.com", 22)).toBe("sftp://example.com:22");
    expect(formatSftpEndpoint("Example.COM", 2222)).toBe(
      "sftp://example.com:2222",
    );
    expect(formatSftpEndpoint("192.168.1.10", 1)).toBe("sftp://192.168.1.10:1");
    expect(formatSftpEndpoint("::1", 22)).toBe("sftp://[::1]:22");
    expect(formatSftpEndpoint("[2001:DB8::1]", 65535)).toBe(
      "sftp://[2001:db8::1]:65535",
    );
  });

  it("canonicalizes IPv6 hosts the way the native parser does", () => {
    const cases: Array<[string, string]> = [
      ["2001:0db8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
      ["1:0:0:2:0:0:0:3", "1:0:0:2::3"],
      ["1:0:1:0:1:0:1:0", "1:0:1:0:1:0:1:0"],
      ["1:2:3:4:5:6:7::", "1:2:3:4:5:6:7:0"],
      ["::", "::"],
      ["::2", "::2"],
      ["::ffff:1.2.3.4", "::ffff:1.2.3.4"],
      ["::ffff:0:1", "::ffff:0.0.0.1"],
      ["2001:DB8:0:0::1", "2001:db8::1"],
    ];
    for (const [host, canonical] of cases) {
      expect(formatSftpEndpoint(host, 22), host).toBe(
        `sftp://[${canonical}]:22`,
      );
    }
  });

  it("refuses ports outside 1 to 65535 and hosts that are not bare names", () => {
    expect(() => formatSftpEndpoint("example.com", 0)).toThrow();
    expect(() => formatSftpEndpoint("example.com", 65536)).toThrow();
    expect(() => formatSftpEndpoint("example.com", 1.5)).toThrow();
    for (const host of [
      "",
      "sftp://example.com",
      "example.com/x",
      "user@host",
      "host:22",
      "[example.com]",
      "fe80::1%eth0",
      ":::",
      "::g",
      "exa mple.com",
      "example.com.",
      ".example.com",
      "a..b",
      "-lead.example",
      "under_score.example",
      "中文.example",
    ]) {
      expect(() => formatSftpEndpoint(host, 22), host).toThrow();
    }
  });

  it("parses hostname, IPv4, and bracketed IPv6 endpoints", () => {
    expect(parseSftpEndpoint("sftp://example.com:22")).toEqual({
      host: "example.com",
      port: 22,
    });
    expect(parseSftpEndpoint("sftp://192.168.1.10:2022")).toEqual({
      host: "192.168.1.10",
      port: 2022,
    });
    expect(parseSftpEndpoint("sftp://[::1]:22")).toEqual({
      host: "::1",
      port: 22,
    });
    expect(parseSftpEndpoint("sftp://[2001:DB8:0:0::1]:65535")).toEqual({
      host: "2001:db8::1",
      port: 65535,
    });
  });

  it("requires the lowercase scheme, an explicit canonical port, and no extra parts", () => {
    for (const endpoint of [
      "example.com:22",
      "https://example.com:22",
      "SFTP://example.com:22",
      "s3://example.com:22",
      "//example.com:22",
      "sftp://example.com",
      "sftp://example.com:",
      "sftp://example.com:0",
      "sftp://example.com:65536",
      "sftp://example.com:+22",
      "sftp://example.com:022",
      "sftp://example.com:2a",
      "sftp://example.com:-1",
      "sftp://[::1]",
      "sftp://[::1]:",
      "sftp://[::1]:0",
      "sftp://user@example.com:22",
      "sftp://example.com:22/path",
      "sftp://example.com:22?x=1",
      "sftp://example.com:22#frag",
      "sftp://:22",
      "sftp://example.com:22:33",
      "sftp://[::1]:22x",
      "sftp://[::1]x22",
      "sftp://[::1",
      "sftp://[example.com]:22",
      "sftp://fe80::1:22",
    ]) {
      expect(() => parseSftpEndpoint(endpoint), endpoint).toThrow();
      expect(isValidSftpEndpoint(endpoint), endpoint).toBe(false);
    }
  });

  it("round-trips every host shape through format and parse", () => {
    for (const [host, port] of [
      ["example.com", 22],
      ["192.168.1.10", 2022],
      ["::1", 22],
      ["2001:db8::1", 65535],
      ["localhost", 1],
    ] as const) {
      const endpoint = formatSftpEndpoint(host, port);
      const parsed = parseSftpEndpoint(endpoint);
      expect(formatSftpEndpoint(parsed.host, parsed.port)).toBe(endpoint);
    }
  });

  it("maps the endpoint host to the single virtual bucket name", () => {
    expect(sftpVirtualBucket("sftp://Example.com:22")).toBe("example.com");
    expect(sftpVirtualBucket("sftp://[::1]:22")).toBe("::1");
    expect(() => sftpVirtualBucket("https://example.com")).toThrow();
  });

  it("recognizes the sftp scheme regardless of case", () => {
    expect(looksLikeSftpEndpoint("sftp://h:22")).toBe(true);
    expect(looksLikeSftpEndpoint("SFTP://h:22")).toBe(true);
    expect(looksLikeSftpEndpoint("https://h")).toBe(false);
    expect(looksLikeSftpEndpoint("h:22")).toBe(false);
  });
});

describe("SFTP connect step guard", () => {
  it("accepts each step shape the native command returns", () => {
    expect(parseSftpConnectStep(VALID_CONNECTED)).toEqual(VALID_CONNECTED);
    const hostKey = {
      step: "host_key_unknown",
      attempt_id: "att-1",
      key_type: "ssh-ed25519",
      fingerprint_sha256: "SHA256:abc",
      host_key: "ssh-ed25519 AAAAC3",
    };
    expect(parseSftpConnectStep(hostKey)).toEqual(hostKey);
    const prompt = {
      step: "prompt",
      attempt_id: "att-2",
      name: "",
      instructions: "",
      prompts: [{ text: "Password: ", echo: false }],
    };
    expect(parseSftpConnectStep(prompt)).toEqual(prompt);
  });

  it("refuses a step that is not an object or has an unknown tag", () => {
    for (const value of [
      null,
      undefined,
      "connected",
      [],
      {},
      { step: "password" },
      { ...VALID_CONNECTED, step: "Connected" },
    ]) {
      expect(() => parseSftpConnectStep(value)).toThrow();
    }
  });

  it("refuses a connected step with a missing identity, bad endpoint, or relative home", () => {
    const malformed: Array<Record<string, unknown>> = [
      { ...VALID_CONNECTED, connection_id: "" },
      { ...VALID_CONNECTED, connection_identity: undefined },
      { ...VALID_CONNECTED, endpoint: "https://example.com" },
      { ...VALID_CONNECTED, endpoint: "sftp://example.com" },
      { ...VALID_CONNECTED, home_path: "home/alice" },
      { ...VALID_CONNECTED, home_path: "/home/../x" },
      { ...VALID_CONNECTED, host_key: 7 },
      { ...VALID_CONNECTED, host_key_fingerprint: undefined },
      { ...VALID_CONNECTED, create_only_supported: "yes" },
    ];
    for (const value of malformed) {
      expect(() => parseSftpConnectStep(value)).toThrow();
    }
  });

  it("refuses host key and prompt steps without an attempt ID or valid prompts", () => {
    const hostKey = {
      step: "host_key_unknown",
      attempt_id: "att-1",
      key_type: "ssh-ed25519",
      fingerprint_sha256: "SHA256:abc",
      host_key: "ssh-ed25519 AAAAC3",
    };
    const prompt = {
      step: "prompt",
      attempt_id: "att-2",
      name: "",
      instructions: "",
      prompts: [{ text: "Password: ", echo: false }],
    };
    const malformed: Array<Record<string, unknown>> = [
      { ...hostKey, attempt_id: "" },
      { ...hostKey, key_type: undefined },
      { ...hostKey, host_key: null },
      { ...prompt, attempt_id: undefined },
      { ...prompt, name: undefined },
      { ...prompt, prompts: "Password: " },
      { ...prompt, prompts: [{ text: "Password: ", echo: "no" }] },
      { ...prompt, prompts: [{ echo: false }] },
    ];
    for (const value of malformed) {
      expect(() => parseSftpConnectStep(value)).toThrow();
    }
  });
});

describe("SFTP wire guards for filesystem results", () => {
  it("accepts a well-formed entry of each kind", () => {
    expect(parseSftpEntry(VALID_FILE)).toEqual(VALID_FILE);
    const dir = entry({ name: "docs", path: "/docs", kind: "dir" });
    expect(parseSftpEntry(dir)).toEqual(dir);
    for (const kind of ["symlink", "other"] as const) {
      const row = entry({ name: "x", path: "/x", kind });
      expect(parseSftpEntry(row)).toEqual(row);
    }
  });

  it("refuses an entry whose name is not a single child name", () => {
    const names = ["", "a/b", ".", "..", "x\0y"];
    for (const name of names) {
      expect(() =>
        parseSftpEntry({ ...VALID_FILE, name, path: `/docs/${name}` }),
      ).toThrow();
    }
  });

  it("refuses an entry whose path is relative or does not end in its name", () => {
    expect(() =>
      parseSftpEntry({ ...VALID_FILE, path: "docs/report.pdf" }),
    ).toThrow();
    expect(() =>
      parseSftpEntry({ ...VALID_FILE, path: "/docs/other.pdf" }),
    ).toThrow();
    expect(() =>
      parseSftpEntry({ ...VALID_FILE, name: "docs", path: "/" }),
    ).toThrow();
  });

  it("refuses unknown kinds and fractional, negative, or stringly numbers", () => {
    const malformed: Array<Record<string, unknown>> = [
      { ...VALID_FILE, kind: "directory" },
      { ...VALID_FILE, kind: "FILE" },
      { ...VALID_FILE, size: -1 },
      { ...VALID_FILE, size: 1.5 },
      { ...VALID_FILE, size: "10" },
      { ...VALID_FILE, size: undefined },
      { ...VALID_FILE, mtime: "1700000000" },
      { ...VALID_FILE, mtime: -5 },
      { ...VALID_FILE, permissions: 4294967296 },
      { ...VALID_FILE, uid: -1 },
      { ...VALID_FILE, gid: 1.5 },
      { ...VALID_FILE, owner: 5 },
      { ...VALID_FILE, group: undefined },
      { ...VALID_FILE, name_lossy: "false" },
      { ...VALID_FILE, name_lossy: undefined },
    ];
    for (const value of malformed) {
      expect(() => parseSftpEntry(value)).toThrow();
    }
  });

  it("refuses a listing with a malformed entry, a bad path, or a bad truncated flag", () => {
    const listing = { path: "/docs", entries: [VALID_FILE], truncated: false };
    expect(parseSftpListResponse(listing)).toEqual(listing);
    const malformed: Array<Record<string, unknown>> = [
      { ...listing, path: "docs" },
      { ...listing, truncated: "no" },
      { ...listing, entries: "report.pdf" },
      { ...listing, entries: [VALID_FILE, { ...VALID_FILE, name: "a/b" }] },
    ];
    for (const value of malformed) {
      expect(() => parseSftpListResponse(value)).toThrow();
    }
  });

  it("accepts delete results and refuses malformed failure rows", () => {
    const result = {
      deleted: ["/a", "/b"],
      failed: [{ path: "/c", error: "denied" }],
    };
    expect(parseSftpDeleteResult(result)).toEqual(result);
    expect(parseSftpDeleteResult({ deleted: [], failed: [] })).toEqual({
      deleted: [],
      failed: [],
    });
    const malformed: Array<Record<string, unknown>> = [
      { deleted: [], failed: [{ path: "/c" }] },
      { deleted: [7], failed: [] },
      { deleted: ["a"], failed: [] },
      { deleted: [], failed: "denied" },
    ];
    for (const value of malformed) {
      expect(() => parseSftpDeleteResult(value)).toThrow();
    }
  });

  it("accepts only a boolean from exists and only null from a unit command", () => {
    expect(parseSftpExists(true)).toBe(true);
    expect(parseSftpExists(false)).toBe(false);
    for (const value of ["true", 1, null, undefined]) {
      expect(() => parseSftpExists(value)).toThrow();
    }
    expect(parseSftpVoid(null)).toBeUndefined();
    expect(parseSftpVoid(undefined)).toBeUndefined();
    for (const value of [{}, false, ""]) {
      expect(() => parseSftpVoid(value)).toThrow();
    }
  });

  it("treats only the native refusal prefix as an existing target", () => {
    expect(isSftpAlreadyExists(`${SFTP_ALREADY_EXISTS}/docs/a.txt`)).toBe(true);
    expect(
      isSftpAlreadyExists(
        "Permission denied: /home/u/folder already exists here/file.txt",
      ),
    ).toBe(false);
    expect(isSftpAlreadyExists("The destination already exists.")).toBe(false);
    expect(isSftpAlreadyExists("")).toBe(false);
    // The Rust side builds the refusal from the same text.
    const rust = readFileSync("src-tauri/src/sftp/fs.rs", "utf8");
    expect(rust).toContain(
      `ALREADY_EXISTS_PREFIX: &str = "${SFTP_ALREADY_EXISTS}";`,
    );
  });

  it("reads an upload outcome and its optional cleanup warning", () => {
    expect(parseSftpUploadOutcome({ bytes_written: 5, warning: null })).toEqual(
      { bytesWritten: 5, warning: null },
    );
    expect(
      parseSftpUploadOutcome({ bytes_written: 0, warning: "left /x.part" }),
    ).toEqual({ bytesWritten: 0, warning: "left /x.part" });
    for (const value of [
      2048,
      null,
      { bytes_written: -1, warning: null },
      { bytes_written: "5", warning: null },
      { bytes_written: 5, warning: "" },
      { bytes_written: 5, warning: 7 },
    ]) {
      expect(() => parseSftpUploadOutcome(value)).toThrow();
    }
  });

  it("reads a rename outcome as its cleanup warning or null", () => {
    expect(parseSftpRenameOutcome({ warning: null })).toBeNull();
    expect(parseSftpRenameOutcome({})).toBeNull();
    expect(parseSftpRenameOutcome({ warning: "kept at /.b.s3sk-bak-1" })).toBe(
      "kept at /.b.s3sk-bak-1",
    );
    for (const value of [null, undefined, "x", { warning: false }]) {
      expect(() => parseSftpRenameOutcome(value)).toThrow();
    }
  });

  it("accepts a preview response and refuses malformed sizes or flags", () => {
    const preview = {
      content_type: "text/plain",
      data: "hi",
      is_text: true,
      truncated: false,
      total_size: 2,
    };
    expect(parseSftpPreviewResponse(preview)).toEqual(preview);
    const malformed: Array<Record<string, unknown>> = [
      { ...preview, is_text: "yes" },
      { ...preview, total_size: 1.5 },
      { ...preview, total_size: -1 },
      { ...preview, data: undefined },
      { ...preview, content_type: null },
    ];
    for (const value of malformed) {
      expect(() => parseSftpPreviewResponse(value)).toThrow();
    }
  });

  it("returns null for a cancelled picker and refuses a malformed key", () => {
    expect(parseSshPrivateKeyInfo(null)).toBeNull();
    const info = {
      key_text: "-----BEGIN OPENSSH PRIVATE KEY-----",
      algorithm: "ssh-ed25519",
      encrypted: true,
      file_name: "id_ed25519",
    };
    expect(parseSshPrivateKeyInfo(info)).toEqual(info);
    for (const value of [undefined, "key", { ...info, algorithm: undefined }]) {
      expect(() => parseSshPrivateKeyInfo(value)).toThrow();
    }
    let message = "";
    try {
      parseSshPrivateKeyInfo({ ...info, encrypted: "yes", key_text: "SECRET" });
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("SECRET");
  });
});

describe("SFTP saved settings guard", () => {
  it("accepts each auth method and the key-material boundaries", () => {
    expect(isSftpSettings({ auth: "password" })).toBe(true);
    expect(isSftpSettings({ auth: "keyboard-interactive" })).toBe(true);
    expect(
      isSftpSettings({
        auth: "key",
        private_key: "x".repeat(MAX_SFTP_PRIVATE_KEY_LENGTH),
        host_key: "y".repeat(MAX_SFTP_HOST_KEY_LENGTH),
      }),
    ).toBe(true);
  });

  it("refuses an unknown auth method, a wrong type, or oversized key material", () => {
    expect(isSftpSettings({ auth: "agent" })).toBe(false);
    expect(isSftpSettings({})).toBe(false);
    expect(isSftpSettings(null)).toBe(false);
    expect(isSftpSettings([])).toBe(false);
    expect(isSftpSettings({ auth: "password", private_key: 5 })).toBe(false);
    expect(
      isSftpSettings({
        auth: "key",
        private_key: "x".repeat(MAX_SFTP_PRIVATE_KEY_LENGTH + 1),
      }),
    ).toBe(false);
    expect(
      isSftpSettings({
        auth: "key",
        host_key: "y".repeat(MAX_SFTP_HOST_KEY_LENGTH + 1),
      }),
    ).toBe(false);
  });
});

describe("SFTP listing mapping", () => {
  const LISTING: SftpListResponse = {
    path: "/docs",
    truncated: false,
    entries: [
      entry({ name: "photos", path: "/docs/photos", kind: "dir" }),
      entry({
        name: "a b+c.txt",
        path: "/docs/a b+c.txt",
        size: 12,
        mtime: 0,
      }),
      entry({ name: "note.txt", path: "/docs/note.txt" }),
      entry({
        name: "link",
        path: "/docs/link",
        kind: "symlink",
        size: 3,
        mtime: 1700000000,
      }),
      entry({ name: "fifo", path: "/docs/fifo", kind: "other" }),
      entry({
        name: "bad�.bin",
        path: "/docs/bad�.bin",
        name_lossy: true,
      }),
    ],
  };

  it("turns directories into prefixes and every other entry into an object", () => {
    const mapped = sftpListingToObjects(LISTING, "docs/");
    expect(mapped.prefixes).toEqual(["docs/photos/"]);
    expect(mapped.objects).toEqual([
      {
        key: "docs/a b+c.txt",
        size: 12,
        last_modified: "1970-01-01T00:00:00.000Z",
        is_folder: false,
        sftp_kind: "file",
        name_lossy: false,
      },
      {
        key: "docs/note.txt",
        size: 0,
        last_modified: "",
        is_folder: false,
        sftp_kind: "file",
        name_lossy: false,
      },
      {
        key: "docs/link",
        size: 3,
        last_modified: "2023-11-14T22:13:20.000Z",
        is_folder: false,
        sftp_kind: "symlink",
        name_lossy: false,
      },
      {
        key: "docs/fifo",
        size: 0,
        last_modified: "",
        is_folder: false,
        sftp_kind: "other",
        name_lossy: false,
      },
      {
        key: "docs/bad�.bin",
        size: 0,
        last_modified: "",
        is_folder: false,
        sftp_kind: "file",
        name_lossy: true,
      },
    ]);
  });

  it("maps the root with an empty prefix and keeps keys relative to it", () => {
    const mapped = sftpListingToObjects(
      {
        path: "/",
        truncated: false,
        entries: [
          entry({ name: "docs", path: "/docs", kind: "dir" }),
          entry({ name: "top.txt", path: "/top.txt" }),
        ],
      },
      "",
    );
    expect(mapped.prefixes).toEqual(["docs/"]);
    expect(mapped.objects.map((object) => object.key)).toEqual(["top.txt"]);
  });

  it("does not throw for a timestamp that is out of the Date range", () => {
    const mapped = sftpListingToObjects(
      {
        path: "/",
        truncated: false,
        entries: [
          entry({
            name: "far.txt",
            path: "/far.txt",
            mtime: Number.MAX_SAFE_INTEGER,
          }),
        ],
      },
      "",
    );
    expect(mapped.objects[0].last_modified).toBe("");
  });
});

describe("SFTP capability and connection-lost mapping", () => {
  it("maps create-only support onto the write capabilities", () => {
    expect(sftpCreateOnlyCapabilities(true)).toEqual({
      put_object: true,
      complete_multipart: true,
      copy_object: false,
    });
    expect(sftpCreateOnlyCapabilities(false)).toEqual(
      NO_CREATE_ONLY_CAPABILITIES,
    );
  });

  it("returns a fresh capability object so callers cannot mutate the shared default", () => {
    const caps = sftpCreateOnlyCapabilities(false);
    caps.put_object = true;
    expect(NO_CREATE_ONLY_CAPABILITIES.put_object).toBe(false);
  });

  it("recognizes only errors that start with the lost-connection text", () => {
    expect(
      isSftpConnectionLost(`${SFTP_CONNECTION_LOST}: the server closed`),
    ).toBe(true);
    expect(isSftpConnectionLost(new Error(SFTP_CONNECTION_LOST))).toBe(true);
    expect(isSftpConnectionLost("Connection lost")).toBe(false);
    expect(isSftpConnectionLost("Not connected")).toBe(false);
    expect(isSftpConnectionLost(new Error("disk full"))).toBe(false);
    expect(isSftpConnectionLost(undefined)).toBe(false);
    expect(isSftpConnectionLost(null)).toBe(false);
  });
});

describe("SFTP wire types match the Rust structs", () => {
  const rustTypes = readFileSync("src-tauri/src/sftp/types.rs", "utf8");
  const tsSource = readFileSync("src/sftp.ts", "utf8");

  function rustBody(source: string, header: RegExp): string {
    const match = header.exec(source);
    if (!match) throw new Error(`Rust item not found: ${header.source}`);
    const start = match.index + match[0].length;
    const end = source.indexOf("\n}", start);
    if (end < 0) throw new Error(`Rust item has no closing brace`);
    return source.slice(start, end);
  }

  function fieldNames(body: string): string[] {
    return body
      .split("\n")
      .map((line) =>
        /^\s*(?:pub\(crate\)\s+)?([a-z_][a-z0-9_]*)\s*:/.exec(line),
      )
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => match[1]);
  }

  function tsBody(source: string, name: string): string {
    const match = new RegExp(`export interface ${name}\\s*\\{`).exec(source);
    if (!match) throw new Error(`TypeScript interface ${name} not found`);
    const start = match.index + match[0].length;
    const end = source.indexOf("\n}", start);
    return source.slice(start, end);
  }

  function tsFieldNames(body: string): string[] {
    return body
      .split("\n")
      .map((line) => /^\s*([a-z_][a-z0-9_]*)\??\s*:/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => match[1]);
  }

  it.each([
    ["SftpEntry", "SftpEntry"],
    ["SftpListResponse", "SftpListResponse"],
    ["SftpDeleteFailure", "SftpDeleteFailure"],
    ["SftpDeleteResult", "SftpDeleteResult"],
    ["SshPrivateKeyInfo", "SshPrivateKeyInfo"],
    ["SftpPrompt", "SftpPrompt"],
  ])("%s has the same fields on both sides", (rustName, tsName) => {
    const rust = fieldNames(
      rustBody(rustTypes, new RegExp(`struct\\s+${rustName}\\s*\\{`)),
    );
    const ts = tsFieldNames(tsBody(tsSource, tsName));
    expect([...ts].sort()).toEqual([...rust].sort());
  });

  it("lists the entry kinds the Rust enum serializes in lowercase", () => {
    const variants = rustBody(rustTypes, /enum\s+SftpEntryKind\s*\{/)
      .split("\n")
      .map((line) => /^\s+([A-Z][A-Za-z]*),?\s*$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => match[1].toLowerCase());
    expect(variants).toEqual(["file", "dir", "symlink", "other"]);
    expect(tsSource).toContain(
      'export type SftpEntryKind = "file" | "dir" | "symlink" | "other";',
    );
  });

  it("matches the connect step tag and the fields of each variant", () => {
    expect(rustTypes).toContain(
      '#[serde(tag = "step", rename_all = "snake_case")]',
    );
    const variantFields = (variant: string): string[] => {
      const start = rustTypes.indexOf(`    ${variant} {`);
      if (start < 0) throw new Error(`Rust variant ${variant} not found`);
      const end = rustTypes.indexOf("\n    }", start);
      return fieldNames(rustTypes.slice(start, end));
    };
    const tsStep = (name: string, step: string): string[] => {
      const fields = tsFieldNames(tsBody(tsSource, name)).filter(
        (field) => field !== "step",
      );
      expect(tsBody(tsSource, name)).toContain(`step: "${step}"`);
      return fields;
    };
    expect([...tsStep("SftpConnectedStep", "connected")].sort()).toEqual(
      [...variantFields("Connected")].sort(),
    );
    expect(
      [...tsStep("SftpHostKeyUnknownStep", "host_key_unknown")].sort(),
    ).toEqual([...variantFields("HostKeyUnknown")].sort());
    expect([...tsStep("SftpPromptStep", "prompt")].sort()).toEqual(
      [...variantFields("Prompt")].sort(),
    );
  });
});

describe("SFTP focus after a failed connect", () => {
  const changed =
    "The SSH host key for files.example.test:22 changed. The server presented SHA256:new, which does not match the saved host key. Reset it only if the server changed.";

  it("focuses the passphrase for an encrypted key, whatever the method", () => {
    expect(
      sftpFailureFocusTarget(
        "The private key is encrypted and needs a passphrase.",
        "key",
      ),
    ).toBe("conn-sftp-passphrase");
    expect(sftpFailureFocusTarget("Private key is encrypted", "password")).toBe(
      "conn-sftp-passphrase",
    );
  });

  it("focuses the credential of the chosen method after a refused sign-in", () => {
    const refused = "Authentication failed. This server does not accept.";
    expect(sftpFailureFocusTarget(refused, "password")).toBe(
      "conn-sftp-password",
    );
    expect(sftpFailureFocusTarget(refused, "key")).toBe("conn-sftp-key-choose");
    expect(sftpFailureFocusTarget(refused, "keyboard-interactive")).toBe(
      "conn-sftp-auth",
    );
  });

  it("only matches Authentication failed. at the start of the message", () => {
    expect(
      sftpFailureFocusTarget("Connect: Authentication failed.", "password"),
    ).toBe("conn-sftp-host");
  });

  it("focuses Reset host key for a changed key only when that control is shown", () => {
    expect(sftpFailureFocusTarget(changed, "password", true)).toBe(
      "conn-sftp-reset-hostkey",
    );
    expect(sftpFailureFocusTarget(changed, "password", false)).toBe(
      "conn-sftp-host",
    );
    expect(sftpFailureFocusTarget(changed, "password")).toBe("conn-sftp-host");
  });

  it("focuses the host for every other failure", () => {
    expect(sftpFailureFocusTarget("SFTP host unreachable", "password")).toBe(
      "conn-sftp-host",
    );
    expect(sftpFailureFocusTarget("", "keyboard-interactive")).toBe(
      "conn-sftp-host",
    );
  });
});

describe("SFTP home fallback notice", () => {
  it("names the remembered folder as a remote path and says home opened", () => {
    expect(sftpHomeFallbackMessage("var/log/")).toBe(
      "/var/log is no longer available. Opened your home folder.",
    );
  });

  it("names the root for the empty key", () => {
    expect(sftpHomeFallbackMessage("")).toBe(
      "/ is no longer available. Opened your home folder.",
    );
  });

  it("falls back to a generic name for a key that is not a valid path", () => {
    expect(sftpHomeFallbackMessage("a/../../b/")).toBe(
      "The remembered folder is no longer available. Opened your home folder.",
    );
  });
});
