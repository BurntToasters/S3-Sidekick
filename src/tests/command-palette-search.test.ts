import { describe, expect, it } from "vitest";
import { rankCommands, type PaletteCommand } from "../command-palette.ts";

function command(
  id: string,
  label: string,
  extra: Partial<PaletteCommand> = {},
): PaletteCommand {
  return { id, label, icon: "search", action: () => undefined, ...extra };
}

const COMMANDS: PaletteCommand[] = [
  command("upload-files", "Upload Files"),
  command("upload-folder", "Upload Folder"),
  command("create-folder", "Create Folder", {
    keywords: ["mkdir", "new folder"],
  }),
  command("refresh", "Refresh"),
  command("delete", "Delete Selected", { keywords: ["trash", "remove"] }),
  command("download", "Download Selected"),
  command("copy-move", "Copy / Move to..."),
];

function labels(query: string, list = COMMANDS): string[] {
  return rankCommands(list, query).map((cmd) => cmd.label);
}

describe("rankCommands", () => {
  it("keeps registration order for an empty query", () => {
    expect(labels("")).toEqual(COMMANDS.map((cmd) => cmd.label));
    expect(labels("   ")).toEqual(COMMANDS.map((cmd) => cmd.label));
  });

  it("matches word initials so 'uf' finds Upload Files first", () => {
    expect(labels("uf")[0]).toBe("Upload Files");
  });

  it("matches declared keywords such as mkdir and trash", () => {
    expect(labels("mkdir")).toEqual(["Create Folder"]);
    expect(labels("trash")).toEqual(["Delete Selected"]);
  });

  it("ranks prefix matches above matches inside a word", () => {
    const ranked = labels("re");
    expect(ranked[0]).toBe("Refresh");
    expect(ranked).toContain("Create Folder");
    expect(ranked.indexOf("Create Folder")).toBeGreaterThan(0);
  });

  it("requires every word of a multi-word query to match", () => {
    expect(labels("copy move")).toEqual(["Copy / Move to..."]);
    expect(labels("copy urls")).toEqual([]);
  });

  it("excludes commands that match no word and no keyword", () => {
    expect(labels("zzqq")).toEqual([]);
  });

  it("matches a subsequence of the label as a last resort", () => {
    expect(labels("dl")).toContain("Download Selected");
  });

  it("does not rank commands whose availability is false", () => {
    const available = [
      command("hidden", "Hidden Refresh", { available: () => false }),
      ...COMMANDS,
    ];
    expect(labels("refresh", available)).toEqual(["Refresh"]);
  });
});
