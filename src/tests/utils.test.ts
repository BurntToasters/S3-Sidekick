import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  safeHref,
  formatSize,
  formatDate,
  basename,
  splitNameExt,
  joinPath,
  pathSeparator,
  friendlyError,
} from "../utils.ts";

describe("escapeHtml", () => {
  it("escapes ampersands", () => {
    expect(escapeHtml("foo & bar")).toBe("foo &amp; bar");
  });

  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes quotes", () => {
    expect(escapeHtml(`"it's"`)).toBe("&quot;it&#39;s&quot;");
  });

  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("handles already-escaped entities", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
});

describe("safeHref", () => {
  it("passes through http URLs", () => {
    expect(safeHref("http://example.com")).toBe("http://example.com");
  });

  it("passes through https URLs", () => {
    expect(safeHref("https://example.com/path?q=1")).toBe(
      "https://example.com/path?q=1",
    );
  });

  it("blocks javascript: URLs", () => {
    expect(safeHref("javascript:alert(1)")).toBe("#");
  });

  it("blocks data: URLs", () => {
    expect(safeHref("data:text/html,<h1>hi</h1>")).toBe("#");
  });

  it("blocks empty string", () => {
    expect(safeHref("")).toBe("#");
  });

  it("escapes HTML entities in the URL", () => {
    expect(safeHref("https://example.com/?a=1&b=2")).toBe(
      "https://example.com/?a=1&amp;b=2",
    );
  });
});

describe("formatSize", () => {
  it("formats zero bytes", () => {
    expect(formatSize(0)).toBe("0 B");
  });

  it("formats negative as dash", () => {
    expect(formatSize(-1)).toBe("—");
  });

  it("formats bytes under 1 KB", () => {
    expect(formatSize(512)).toBe("512 B");
  });

  it("formats exact 1 KB", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
  });

  it("formats megabytes", () => {
    expect(formatSize(1048576)).toBe("1.0 MB");
  });

  it("formats gigabytes", () => {
    expect(formatSize(1073741824)).toBe("1.0 GB");
  });

  it("formats terabytes", () => {
    expect(formatSize(1099511627776)).toBe("1.0 TB");
  });

  it("formats fractional sizes", () => {
    expect(formatSize(1536)).toBe("1.5 KB");
  });
});

describe("formatDate", () => {
  it("returns dash for empty string", () => {
    expect(formatDate("")).toBe("—");
  });

  it("returns the original string for garbage input", () => {
    expect(formatDate("not-a-date")).toBe("not-a-date");
  });

  it("formats a valid ISO date", () => {
    const result = formatDate("2024-01-15T10:30:00Z");
    expect(result).not.toBe("—");
    expect(result).not.toBe("2024-01-15T10:30:00Z");
    expect(result).toContain("2024");
  });
});

describe("basename", () => {
  it("extracts filename from a path", () => {
    expect(basename("folder/subfolder/file.txt")).toBe("file.txt");
  });

  it("returns the key when no slashes", () => {
    expect(basename("file.txt")).toBe("file.txt");
  });

  it("handles folder keys with trailing slash", () => {
    expect(basename("folder/subfolder/")).toBe("subfolder/");
  });

  it("handles root-level folder", () => {
    expect(basename("myfolder/")).toBe("myfolder/");
  });

  it("handles deeply nested path", () => {
    expect(basename("a/b/c/d/e/f.txt")).toBe("f.txt");
  });

  it("handles empty string", () => {
    expect(basename("")).toBe("");
  });
});

describe("splitNameExt", () => {
  it("splits a normal filename", () => {
    expect(splitNameExt("photo.jpg")).toEqual({ stem: "photo", ext: ".jpg" });
  });

  it("splits a filename with multiple dots", () => {
    expect(splitNameExt("archive.tar.gz")).toEqual({
      stem: "archive.tar",
      ext: ".gz",
    });
  });

  it("returns no extension for dotfiles", () => {
    expect(splitNameExt(".gitignore")).toEqual({
      stem: ".gitignore",
      ext: "",
    });
  });

  it("returns no extension for files without one", () => {
    expect(splitNameExt("Makefile")).toEqual({ stem: "Makefile", ext: "" });
  });

  it("returns no extension for trailing dot", () => {
    expect(splitNameExt("file.")).toEqual({ stem: "file.", ext: "" });
  });

  it("handles empty string", () => {
    expect(splitNameExt("")).toEqual({ stem: "", ext: "" });
  });
});

describe("pathSeparator", () => {
  it("returns backslash for windows", () => {
    expect(pathSeparator("windows")).toBe("\\");
  });

  it("returns forward slash for macos", () => {
    expect(pathSeparator("macos")).toBe("/");
  });

  it("returns forward slash for linux", () => {
    expect(pathSeparator("linux")).toBe("/");
  });

  it("returns forward slash for unknown platform", () => {
    expect(pathSeparator("")).toBe("/");
  });
});

describe("joinPath", () => {
  it("joins with forward slash on macOS", () => {
    expect(joinPath("/Users/test/Downloads", "file.txt", "macos")).toBe(
      "/Users/test/Downloads/file.txt",
    );
  });

  it("joins with backslash on Windows", () => {
    expect(joinPath("C:\\Users\\test\\Downloads", "file.txt", "windows")).toBe(
      "C:\\Users\\test\\Downloads\\file.txt",
    );
  });

  it("strips trailing forward slash from base", () => {
    expect(joinPath("/Users/test/Downloads/", "file.txt", "macos")).toBe(
      "/Users/test/Downloads/file.txt",
    );
  });

  it("strips trailing backslash from base", () => {
    expect(joinPath("C:\\Users\\test\\", "file.txt", "windows")).toBe(
      "C:\\Users\\test\\file.txt",
    );
  });

  it("strips multiple trailing slashes", () => {
    expect(joinPath("/Users/test///", "file.txt", "linux")).toBe(
      "/Users/test/file.txt",
    );
  });

  it("handles base with mixed separators on Windows", () => {
    expect(joinPath("C:/Users/test/", "file.txt", "windows")).toBe(
      "C:/Users/test\\file.txt",
    );
  });
});

describe("friendlyError", () => {
  it("maps 403 errors", () => {
    expect(friendlyError("403 Forbidden")).toBe(
      "Access denied. Check your credentials and permissions.",
    );
  });

  it("maps 404 errors", () => {
    expect(friendlyError("NoSuchBucket: bucket-name")).toBe(
      "Resource not found. It may have been deleted or moved.",
    );
  });

  it("maps timeout errors", () => {
    expect(friendlyError("ETIMEDOUT")).toBe(
      "Request timed out. Check your network connection and endpoint.",
    );
  });

  it("maps network errors", () => {
    expect(friendlyError("ECONNREFUSED")).toBe(
      "Network error. Verify the endpoint URL and your internet connection.",
    );
  });

  it("maps 401 authentication errors", () => {
    expect(friendlyError("InvalidAccessKeyId")).toBe(
      "Authentication failed. Verify your access key and secret key.",
    );
  });

  it("maps 500 server errors", () => {
    expect(friendlyError("500 InternalError")).toBe(
      "Server error. The storage service may be experiencing issues.",
    );
  });

  it("maps rate limiting errors", () => {
    expect(friendlyError("429 TooManyRequests")).toBe(
      "Rate limited. Too many requests \u2014 wait a moment and try again.",
    );
  });

  it("passes through unknown errors unchanged", () => {
    expect(friendlyError("something unexpected happened")).toBe(
      "something unexpected happened",
    );
  });

  it("converts non-string errors to string", () => {
    expect(friendlyError(new Error("403 Forbidden"))).toBe(
      "Access denied. Check your credentials and permissions.",
    );
  });
});
