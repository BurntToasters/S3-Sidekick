import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import zlib from "node:zlib";

import { REQUIRED_IOS_ICONS, verifyIosIcons } from "./normalize-iconsets.js";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("reports every missing required iOS icon", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-ios-icons-"),
  );
  temporaryDirectories.push(directory);

  const errors = [];
  verifyIosIcons(errors, directory);

  assert.equal(Object.keys(REQUIRED_IOS_ICONS).length, 18);
  for (const fileName of Object.keys(REQUIRED_IOS_ICONS)) {
    assert.ok(
      errors.some(
        (error) => error.includes(`Missing icon:`) && error.includes(fileName),
      ),
      `${fileName} was not reported missing`,
    );
  }
});

const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const payload = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, checksum]);
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function rgbHeader(size = 20) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return header;
}

function indexedHeader(bitDepth = 8, size = 20) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = bitDepth;
  header[9] = 3;
  return header;
}

test("rejects a header-only RGB icon with no image data", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-ios-icons-truncated-"),
  );
  temporaryDirectories.push(directory);

  const malformed = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", rgbHeader()),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(path.join(directory, "AppIcon-20x20@1x.png"), malformed);

  const errors = [];
  verifyIosIcons(errors, directory);

  assert.ok(
    errors.some((error) => error.includes("is missing PNG image data")),
    `malformed RGB icon was accepted: ${errors.join("; ")}`,
  );
});

test("rejects an RGB icon without an IEND chunk", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-ios-icons-no-end-"),
  );
  temporaryDirectories.push(directory);

  const imageData = zlib.deflateSync(Buffer.alloc(20 * (1 + 20 * 3)));
  const malformed = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", rgbHeader()),
    pngChunk("IDAT", imageData),
  ]);
  fs.writeFileSync(path.join(directory, "AppIcon-20x20@1x.png"), malformed);

  const errors = [];
  verifyIosIcons(errors, directory);

  assert.ok(
    errors.some((error) => error.includes("is missing a PNG end chunk")),
    `missing IEND was accepted: ${errors.join("; ")}`,
  );
});

test("rejects an RGB icon with a corrupted chunk CRC", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-ios-icons-bad-crc-"),
  );
  temporaryDirectories.push(directory);

  const imageData = zlib.deflateSync(Buffer.alloc(20 * (1 + 20 * 3)));
  const corruptedIdat = pngChunk("IDAT", imageData);
  corruptedIdat[corruptedIdat.length - 1] ^= 0xff;
  const malformed = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", rgbHeader()),
    corruptedIdat,
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(path.join(directory, "AppIcon-20x20@1x.png"), malformed);

  const errors = [];
  verifyIosIcons(errors, directory);

  assert.ok(
    errors.some((error) => error.includes("invalid CRC for its IDAT chunk")),
    `corrupt CRC was accepted: ${errors.join("; ")}`,
  );
});

test("rejects an indexed icon without a palette", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-ios-icons-no-palette-"),
  );
  temporaryDirectories.push(directory);

  const imageData = zlib.deflateSync(Buffer.alloc(20 * (1 + 20)));
  const malformed = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", indexedHeader()),
    pngChunk("IDAT", imageData),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(path.join(directory, "AppIcon-20x20@1x.png"), malformed);

  const errors = [];
  verifyIosIcons(errors, directory);

  assert.ok(
    errors.some((error) =>
      error.includes("is missing a PNG palette before image data"),
    ),
    `missing PLTE was accepted: ${errors.join("; ")}`,
  );
});

test("rejects an indexed icon whose pixels exceed its palette", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-ios-icons-bad-palette-index-"),
  );
  temporaryDirectories.push(directory);

  const rows = Buffer.alloc(20 * (1 + 5));
  rows[1] = 0b01000000;
  const malformed = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", indexedHeader(2)),
    pngChunk("PLTE", Buffer.from([0, 0, 0])),
    pngChunk("IDAT", zlib.deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(path.join(directory, "AppIcon-20x20@1x.png"), malformed);

  const errors = [];
  verifyIosIcons(errors, directory);

  assert.ok(
    errors.some((error) =>
      error.includes(
        "references PNG palette index 1, but only 1 entries exist",
      ),
    ),
    `out-of-range palette index was accepted: ${errors.join("; ")}`,
  );
});

function writeIcon(label, chunks) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), `s3-sidekick-${label}-`),
  );
  temporaryDirectories.push(directory);
  fs.writeFileSync(
    path.join(directory, "AppIcon-20x20@1x.png"),
    Buffer.concat([PNG_SIGNATURE, ...chunks]),
  );
  return directory;
}

/// An RGB icon may declare a transparent colour that no pixel uses; that icon is
/// still fully opaque and must pass.
test("accepts an RGB icon whose declared transparent colour is unused", () => {
  const rows = Buffer.alloc(20 * (1 + 20 * 3)).fill(0x10);
  for (let row = 0; row < 20; row += 1) {
    rows[row * (1 + 20 * 3)] = 0;
  }
  const transparentColour = Buffer.alloc(6);
  transparentColour.writeUInt16BE(0x00ff, 0);
  transparentColour.writeUInt16BE(0x00ff, 2);
  transparentColour.writeUInt16BE(0x00ff, 4);

  const directory = writeIcon("icons-unused-trns", [
    pngChunk("IHDR", rgbHeader()),
    pngChunk("tRNS", transparentColour),
    pngChunk("IDAT", zlib.deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);

  const errors = [];
  verifyIosIcons(errors, directory);

  assert.deepEqual(
    errors.filter((error) => error.includes("transparent pixels")),
    [],
    `unused transparent colour was treated as transparency: ${errors.join("; ")}`,
  );
});

test("rejects an RGB icon that uses its declared transparent colour", () => {
  const rows = Buffer.alloc(20 * (1 + 20 * 3)).fill(0x10);
  for (let row = 0; row < 20; row += 1) {
    const start = row * (1 + 20 * 3);
    rows[start] = 0;
    rows[start + 1] = 0x20;
    rows[start + 2] = 0x20;
    rows[start + 3] = 0x20;
  }
  const transparentColour = Buffer.alloc(6);
  transparentColour.writeUInt16BE(0x0020, 0);
  transparentColour.writeUInt16BE(0x0020, 2);
  transparentColour.writeUInt16BE(0x0020, 4);

  const directory = writeIcon("icons-used-trns", [
    pngChunk("IHDR", rgbHeader()),
    pngChunk("tRNS", transparentColour),
    pngChunk("IDAT", zlib.deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);

  const errors = [];
  verifyIosIcons(errors, directory);

  assert.ok(
    errors.some((error) => error.includes("contains transparent pixels")),
    `used transparent colour was accepted: ${errors.join("; ")}`,
  );
});

test("bounds PNG decompression instead of expanding without limit", () => {
  const oversized = zlib.deflateSync(Buffer.alloc(20 * (1 + 20 * 3) + 4096));
  const directory = writeIcon("icons-inflate-bomb", [
    pngChunk("IHDR", rgbHeader()),
    pngChunk("IDAT", oversized),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);

  const errors = [];
  verifyIosIcons(errors, directory);

  assert.ok(errors.length > 0, "an oversized IDAT stream must be rejected");
});

test("rejects malformed PNG transparency chunks", async (t) => {
  const rgbImageData = zlib.deflateSync(Buffer.alloc(20 * (1 + 20 * 3)));
  const rgbaImageData = zlib.deflateSync(
    Buffer.alloc(20 * (1 + 20 * 4)).fill(0xff),
  );

  function rgbaHeader(size = 20) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;
    header[9] = 6;
    return header;
  }

  const cases = [
    {
      name: "duplicate tRNS",
      chunks: [
        pngChunk("IHDR", rgbHeader()),
        pngChunk("tRNS", Buffer.alloc(6)),
        pngChunk("tRNS", Buffer.alloc(6)),
        pngChunk("IDAT", rgbImageData),
        pngChunk("IEND", Buffer.alloc(0)),
      ],
      expected: "contains more than one PNG transparency chunk",
    },
    {
      name: "tRNS after IDAT",
      chunks: [
        pngChunk("IHDR", rgbHeader()),
        pngChunk("IDAT", rgbImageData),
        pngChunk("tRNS", Buffer.alloc(6)),
        pngChunk("IEND", Buffer.alloc(0)),
      ],
      expected: "has PNG transparency after image data",
    },
    {
      name: "tRNS on an alpha color type",
      chunks: [
        pngChunk("IHDR", rgbaHeader()),
        pngChunk("tRNS", Buffer.alloc(6)),
        pngChunk("IDAT", rgbaImageData),
        pngChunk("IEND", Buffer.alloc(0)),
      ],
      expected: "prohibited for color type 6",
    },
    {
      name: "wrong tRNS length for truecolor",
      chunks: [
        pngChunk("IHDR", rgbHeader()),
        pngChunk("tRNS", Buffer.alloc(4)),
        pngChunk("IDAT", rgbImageData),
        pngChunk("IEND", Buffer.alloc(0)),
      ],
      expected: "invalid PNG transparency length for color type 2",
    },
    {
      name: "tRNS longer than the palette",
      chunks: [
        pngChunk("IHDR", indexedHeader()),
        pngChunk("PLTE", Buffer.alloc(3)),
        pngChunk("tRNS", Buffer.alloc(2)),
        pngChunk("IDAT", zlib.deflateSync(Buffer.alloc(20 * (1 + 20)))),
        pngChunk("IEND", Buffer.alloc(0)),
      ],
      expected: "more PNG transparency entries than palette entries",
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "s3-sidekick-ios-icons-bad-trns-"),
      );
      temporaryDirectories.push(directory);
      fs.writeFileSync(
        path.join(directory, "AppIcon-20x20@1x.png"),
        Buffer.concat([PNG_SIGNATURE, ...testCase.chunks]),
      );

      const errors = [];
      verifyIosIcons(errors, directory);
      assert.ok(
        errors.some((error) => error.includes(testCase.expected)),
        `${testCase.name} was accepted: ${errors.join("; ")}`,
      );
    });
  }
});

test("rejects malformed PNG header structure and methods", async (t) => {
  const imageData = zlib.deflateSync(Buffer.alloc(20 * (1 + 20 * 3)));
  const invalidMethodHeader = rgbHeader();
  invalidMethodHeader[10] = 1;
  const cases = [
    {
      name: "non-leading IHDR",
      chunks: [
        pngChunk("tEXt", Buffer.from("x")),
        pngChunk("IHDR", rgbHeader()),
        pngChunk("IDAT", imageData),
        pngChunk("IEND", Buffer.alloc(0)),
      ],
      expected: "must begin with a PNG IHDR chunk",
    },
    {
      name: "duplicate IHDR",
      chunks: [
        pngChunk("IHDR", rgbHeader()),
        pngChunk("IHDR", rgbHeader()),
        pngChunk("IDAT", imageData),
        pngChunk("IEND", Buffer.alloc(0)),
      ],
      expected: "contains more than one PNG IHDR chunk",
    },
    {
      name: "nonzero compression method",
      chunks: [
        pngChunk("IHDR", invalidMethodHeader),
        pngChunk("IDAT", imageData),
        pngChunk("IEND", Buffer.alloc(0)),
      ],
      expected: "unsupported PNG compression or filter method",
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "s3-sidekick-ios-icons-bad-header-"),
      );
      temporaryDirectories.push(directory);
      fs.writeFileSync(
        path.join(directory, "AppIcon-20x20@1x.png"),
        Buffer.concat([PNG_SIGNATURE, ...testCase.chunks]),
      );

      const errors = [];
      verifyIosIcons(errors, directory);
      assert.ok(
        errors.some((error) => error.includes(testCase.expected)),
        `${testCase.name} was accepted: ${errors.join("; ")}`,
      );
    });
  }
});
