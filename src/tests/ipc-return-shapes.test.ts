import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Return shapes the IPC contract generator does not cover: commands that
 * return a serialized struct are typed `unknown` in the generated argument
 * contract, so the webview keeps a hand-written interface. These tests fail
 * when the Rust struct and the hand-written interface drift.
 */

function rustStruct(
  source: string,
  name: string,
): { fields: string[]; camelCase: boolean } {
  const match = new RegExp(
    `(?:pub(?:\\(crate\\))?\\s+)?struct\\s+${name}\\s*\\{`,
  ).exec(source);
  if (!match) throw new Error(`Rust struct ${name} not found`);
  const start = match.index + match[0].length;
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`Rust struct ${name} has no closing brace`);
  const attributes = source.slice(Math.max(0, match.index - 400), match.index);
  const camelCase = /rename_all\s*=\s*"camelCase"/.test(attributes);
  const fields = source
    .slice(start, end)
    .split("\n")
    .map((line) =>
      /^\s*(?:pub(?:\(crate\))?\s+)?([a-z_][a-z0-9_]*)\s*:/.exec(line),
    )
    .filter((field): field is RegExpExecArray => field !== null)
    .map((field) => field[1]);
  return {
    fields: fields.map((field) => (camelCase ? camelCaseName(field) : field)),
    camelCase,
  };
}

function camelCaseName(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

function tsInterface(
  source: string,
  name: string,
): Array<{ name: string; optional: boolean }> {
  const match = new RegExp(`(?:export\\s+)?interface\\s+${name}\\s*\\{`).exec(
    source,
  );
  if (!match) throw new Error(`TypeScript interface ${name} not found`);
  const start = match.index + match[0].length;
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`TypeScript interface ${name} has no end`);
  return source
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .map((line) => /^\s*([A-Za-z_][A-Za-z0-9_]*)(\?)?\s*:/.exec(line))
    .filter((field): field is RegExpExecArray => field !== null)
    .map((field) => ({ name: field[1], optional: field[2] === "?" }));
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function tsNames(fields: Array<{ name: string; optional: boolean }>): string[] {
  return fields.map((field) => field.name);
}

function expectSameKeys(rustKeys: string[], tsKeys: string[]): void {
  expect([...new Set(tsKeys)].sort()).toEqual([...new Set(rustKeys)].sort());
}

function expectRustKeysPresent(
  rustKeys: string[],
  tsFields: Array<{ name: string; optional: boolean }>,
): void {
  for (const field of rustKeys) {
    expect(tsNames(tsFields)).toContain(field);
  }
  for (const field of tsFields) {
    if (!field.optional) expect(rustKeys).toContain(field.name);
  }
}

describe("hand-written IPC return shapes", () => {
  const mainSource = read("src-tauri/src/main.rs");
  const pathAuthoritySource = read("src-tauri/src/path_authority.rs");
  const filesSource = read("src-tauri/src/files.rs");
  const pathGrantsSource = read("src/path-grants.ts");
  const bookmarksSource = read("src/bookmarks.ts");
  const transfersSource = read("src/transfers.ts");
  const appUploadSource = read("src/app-upload.ts");

  it("NativePathGrant matches the camelCase PickedPath response", () => {
    const rust = rustStruct(mainSource, "PickedPath");
    expect(rust.camelCase).toBe(true);
    expectRustKeysPresent(
      rust.fields,
      tsInterface(pathGrantsSource, "NativePathGrant"),
    );
  });

  it("DroppedPathGrant stays assignable to NativePathGrant", () => {
    const rust = rustStruct(pathAuthoritySource, "DroppedPathGrant");
    expect(rust.camelCase).toBe(true);
    expectRustKeysPresent(
      rust.fields,
      tsInterface(pathGrantsSource, "NativePathGrant"),
    );
  });

  it("BookmarksState and BookmarkFileState match the webview interfaces", () => {
    expectSameKeys(
      rustStruct(mainSource, "BookmarksState").fields,
      tsNames(tsInterface(bookmarksSource, "BookmarksState")),
    );
    expectSameKeys(
      rustStruct(mainSource, "BookmarkFileState").fields,
      tsNames(tsInterface(bookmarksSource, "BookmarkFileState")),
    );
  });

  it("TransferManifestHydration matches the snake_case webview interface", () => {
    const rust = rustStruct(mainSource, "TransferManifestHydration");
    expect(rust.camelCase).toBe(false);
    expectSameKeys(
      rust.fields,
      tsNames(tsInterface(transfersSource, "TransferManifestHydration")),
    );
  });

  it("folder scan warnings stay visible to the upload path", () => {
    expectSameKeys(
      rustStruct(filesSource, "LocalFolderScanResult").fields,
      tsNames(tsInterface(appUploadSource, "LocalFolderScanResult")),
    );
    expectSameKeys(
      rustStruct(filesSource, "LocalFileEntry").fields,
      tsNames(tsInterface(appUploadSource, "LocalFolderFileEntry")),
    );
  });
});
