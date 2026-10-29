import { describe, expect, it } from "vitest";
import {
  compareListingNames,
  parseSortPreference,
  serializeSortPreference,
} from "../browser.ts";

describe("listing name order", () => {
  it("orders numbered names by number, not by digit text", () => {
    const names = ["img10.png", "img2.png", "img1.png"];
    expect([...names].sort(compareListingNames)).toEqual([
      "img1.png",
      "img2.png",
      "img10.png",
    ]);
  });

  it("ignores letter case so B and a sort as a and b", () => {
    const names = ["B.txt", "a.txt", "C.txt"];
    expect([...names].sort(compareListingNames)).toEqual([
      "a.txt",
      "B.txt",
      "C.txt",
    ]);
  });

  it("returns zero for identical names", () => {
    expect(compareListingNames("report.csv", "report.csv")).toBe(0);
  });
});

describe("persisted sort preference", () => {
  it("round-trips a valid column and direction", () => {
    const raw = serializeSortPreference({ column: "size", asc: false });
    expect(parseSortPreference(raw)).toEqual({ column: "size", asc: false });
  });

  it("returns null for a missing, malformed or unknown stored value", () => {
    expect(parseSortPreference(null)).toBeNull();
    expect(parseSortPreference("not json")).toBeNull();
    expect(parseSortPreference('{"column":"owner","asc":true}')).toBeNull();
    expect(parseSortPreference('{"column":"name","asc":"yes"}')).toBeNull();
    expect(parseSortPreference("[]")).toBeNull();
  });
});
