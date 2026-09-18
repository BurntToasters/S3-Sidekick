#!/usr/bin/env node

import fs from "fs";
import path from "path";
import zlib from "zlib";

import { isDirectExecution } from "./direct-execution.js";

const ICONS_ROOT = path.join(process.cwd(), "src-tauri", "icons");
const CHECK_ONLY = process.argv.includes("--check");
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
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

const FALLBACK_PATTERNS = [
  // Matches exports like Icon-macOS-Default-16x16@1x.png,
  // macOS-macOS-Default-16x16@1x.png, or macOS-Default-16x16@1x.png.
  /^(?:icon-)?(?:macOS(?:-macOS)?-Default-)(\d+x\d+)(?:@([12])x)?\.png$/i,
  // Matches exports like Icon-16x16@1x.png.
  /^(?:icon-)(\d+x\d+)(?:@([12])x)?\.png$/i,
];

export const REQUIRED_IOS_ICONS = Object.freeze({
  "AppIcon-20x20@1x.png": 20,
  "AppIcon-20x20@2x-1.png": 40,
  "AppIcon-20x20@2x.png": 40,
  "AppIcon-20x20@3x.png": 60,
  "AppIcon-29x29@1x.png": 29,
  "AppIcon-29x29@2x-1.png": 58,
  "AppIcon-29x29@2x.png": 58,
  "AppIcon-29x29@3x.png": 87,
  "AppIcon-40x40@1x.png": 40,
  "AppIcon-40x40@2x-1.png": 80,
  "AppIcon-40x40@2x.png": 80,
  "AppIcon-40x40@3x.png": 120,
  "AppIcon-60x60@2x.png": 120,
  "AppIcon-60x60@3x.png": 180,
  "AppIcon-76x76@1x.png": 76,
  "AppIcon-76x76@2x.png": 152,
  "AppIcon-83.5x83.5@2x.png": 167,
  "AppIcon-512@2x.png": 1024,
});

function toCanonicalIconName(fileName) {
  if (
    !fileName.toLowerCase().endsWith(".png") ||
    fileName.startsWith("icon_")
  ) {
    return null;
  }

  for (const pattern of FALLBACK_PATTERNS) {
    const match = fileName.match(pattern);
    if (match) {
      return `icon_${match[1]}@${match[2] ?? "1"}x.png`;
    }
  }

  return null;
}

function getIconsetDirs(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(".iconset"))
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

function normalizeIconset(iconsetDir) {
  const entries = fs.readdirSync(iconsetDir, { withFileTypes: true });
  let renamedCount = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".png")) {
      continue;
    }

    const targetName = toCanonicalIconName(entry.name);
    if (!targetName) {
      continue;
    }

    if (CHECK_ONLY) {
      throw new Error(
        `${path.relative(process.cwd(), path.join(iconsetDir, entry.name))} is not canonically named; expected ${targetName}`,
      );
    }

    const sourcePath = path.join(iconsetDir, entry.name);
    const targetPath = path.join(iconsetDir, targetName);

    if (fs.existsSync(targetPath)) {
      throw new Error(
        `Cannot normalize ${entry.name} in ${path.basename(iconsetDir)} because ${targetName} already exists`,
      );
    }

    fs.renameSync(sourcePath, targetPath);
    renamedCount += 1;
  }

  return renamedCount;
}

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);

  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

function unfilterByte(filter, raw, index, current, previous, bytesPerPixel) {
  const left = index >= bytesPerPixel ? current[index - bytesPerPixel] : 0;
  const up = previous[index] ?? 0;
  const upperLeft =
    index >= bytesPerPixel ? (previous[index - bytesPerPixel] ?? 0) : 0;

  switch (filter) {
    case 0:
      return raw;
    case 1:
      return (raw + left) & 0xff;
    case 2:
      return (raw + up) & 0xff;
    case 3:
      return (raw + Math.floor((left + up) / 2)) & 0xff;
    case 4:
      return (raw + paeth(left, up, upperLeft)) & 0xff;
    default:
      throw new Error(`Unsupported PNG filter ${filter}`);
  }
}

function validPngBitDepth(colorType, bitDepth) {
  const allowed = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  return allowed[colorType]?.includes(bitDepth) ?? false;
}

function parsePng(filePath) {
  const file = fs.readFileSync(filePath);
  if (!file.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`${filePath} is not a PNG file`);
  }

  let offset = PNG_SIGNATURE.length;
  let header;
  let palette;
  let transparency;
  let sawImageData = false;
  let sawImageEnd = false;
  const imageData = [];

  while (offset + 12 <= file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > file.length) {
      throw new Error(`${filePath} contains a truncated PNG chunk`);
    }

    const storedCrc = file.readUInt32BE(dataEnd);
    const calculatedCrc = crc32(file.subarray(offset + 4, dataEnd));
    if (storedCrc !== calculatedCrc) {
      throw new Error(
        `${filePath} contains an invalid CRC for its ${type} chunk`,
      );
    }

    const data = file.subarray(dataStart, dataEnd);
    if (!header && type !== "IHDR") {
      throw new Error(`${filePath} must begin with a PNG IHDR chunk`);
    }
    if (type === "IHDR") {
      if (header) {
        throw new Error(`${filePath} contains more than one PNG IHDR chunk`);
      }
      if (offset !== PNG_SIGNATURE.length) {
        throw new Error(`${filePath} must begin with a PNG IHDR chunk`);
      }
      if (length !== 13) {
        throw new Error(`${filePath} has an invalid PNG header length`);
      }
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      if (width === 0 || height === 0) {
        throw new Error(`${filePath} has zero PNG dimensions`);
      }
      if (!validPngBitDepth(colorType, bitDepth)) {
        throw new Error(
          `${filePath} has invalid PNG bit depth ${bitDepth} for color type ${colorType}`,
        );
      }
      if (data[10] !== 0 || data[11] !== 0) {
        throw new Error(
          `${filePath} uses an unsupported PNG compression or filter method`,
        );
      }
      if (data[12] !== 0 && data[12] !== 1) {
        throw new Error(`${filePath} uses an invalid PNG interlace method`);
      }
      header = {
        width,
        height,
        bitDepth,
        colorType,
        interlace: data[12],
      };
    } else if (type === "PLTE") {
      if (palette) {
        throw new Error(`${filePath} contains more than one PNG palette`);
      }
      if (sawImageData) {
        throw new Error(`${filePath} has a PNG palette after image data`);
      }
      if (header.colorType === 0 || header.colorType === 4) {
        throw new Error(
          `${filePath} has a PNG palette that is invalid for color type ${header.colorType}`,
        );
      }
      if (length === 0 || length % 3 !== 0 || length > 256 * 3) {
        throw new Error(`${filePath} has an invalid PNG palette size`);
      }
      const entryCount = length / 3;
      if (header.colorType === 3 && entryCount > 2 ** header.bitDepth) {
        throw new Error(
          `${filePath} has too many PNG palette entries for bit depth ${header.bitDepth}`,
        );
      }
      palette = data;
    } else if (type === "IDAT") {
      if (header.colorType === 3 && !palette) {
        throw new Error(
          `${filePath} is missing a PNG palette before image data`,
        );
      }
      sawImageData = true;
      imageData.push(data);
    } else if (type === "tRNS") {
      if (transparency) {
        throw new Error(
          `${filePath} contains more than one PNG transparency chunk`,
        );
      }
      if (sawImageData) {
        throw new Error(`${filePath} has PNG transparency after image data`);
      }
      if (header.colorType === 4 || header.colorType === 6) {
        throw new Error(
          `${filePath} has PNG transparency that is prohibited for color type ${header.colorType}`,
        );
      }
      if (header.colorType === 3 && !palette) {
        throw new Error(`${filePath} has PNG transparency before its palette`);
      }
      const expectedTransparencyLength = { 0: 2, 2: 6 }[header.colorType];
      if (
        expectedTransparencyLength !== undefined &&
        length !== expectedTransparencyLength
      ) {
        throw new Error(
          `${filePath} has an invalid PNG transparency length for color type ${header.colorType}`,
        );
      }
      if (header.colorType === 3 && (length === 0 || length > 256)) {
        throw new Error(
          `${filePath} has an invalid PNG transparency length for its palette`,
        );
      }
      transparency = data;
    } else if (type === "IEND") {
      if (length !== 0) {
        throw new Error(`${filePath} has an invalid PNG end chunk`);
      }
      sawImageEnd = true;
    }

    offset = dataEnd + 4;
    if (type === "IEND") {
      break;
    }
  }

  if (!header) {
    throw new Error(`${filePath} is missing a PNG header`);
  }
  if (header.colorType === 3 && !palette) {
    throw new Error(`${filePath} is missing a PNG palette`);
  }
  if (imageData.length === 0) {
    throw new Error(`${filePath} is missing PNG image data`);
  }
  if (!sawImageEnd) {
    throw new Error(`${filePath} is missing a PNG end chunk`);
  }
  if (offset !== file.length) {
    throw new Error(
      `${filePath} contains trailing data after its PNG end chunk`,
    );
  }

  const paletteEntryCount = palette ? palette.length / 3 : undefined;
  if (
    header.colorType === 3 &&
    transparency &&
    transparency.length > paletteEntryCount
  ) {
    throw new Error(
      `${filePath} has more PNG transparency entries than palette entries`,
    );
  }

  return {
    ...header,
    opaque: pngIsOpaque(
      filePath,
      header,
      imageData,
      transparency,
      paletteEntryCount,
    ),
  };
}

function decodePngRows(
  filePath,
  header,
  imageData,
  inspectAlpha,
  paletteEntryCount,
  usedPaletteIndexes,
  transparentKey,
) {
  const channelsByColorType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByColorType[header.colorType];
  if (!channels) {
    throw new Error(
      `${filePath} uses unsupported PNG color type ${header.colorType}`,
    );
  }
  if (header.interlace !== 0) {
    throw new Error(`${filePath} must use non-interlaced PNG data`);
  }
  if (inspectAlpha && header.bitDepth !== 8) {
    throw new Error(`${filePath} must use 8-bit PNG data for alpha validation`);
  }

  const bitsPerPixel = channels * header.bitDepth;
  const rowLength = Math.ceil((header.width * bitsPerPixel) / 8);
  const bytesPerPixel = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const expectedLength = header.height * (rowLength + 1);
  // Bound decompression to the size the header describes. Without a limit, a
  // small malicious IDAT stream can expand until the checker exhausts memory.
  const inflated = zlib.inflateSync(Buffer.concat(imageData), {
    maxOutputLength: expectedLength + 1,
  });
  if (inflated.length !== expectedLength) {
    throw new Error(`${filePath} has an unexpected decompressed PNG size`);
  }

  let inputOffset = 0;
  let previous = Buffer.alloc(rowLength);
  let opaque = true;
  for (let row = 0; row < header.height; row += 1) {
    const filter = inflated[inputOffset];
    inputOffset += 1;
    const current = Buffer.allocUnsafe(rowLength);

    for (let index = 0; index < rowLength; index += 1) {
      current[index] = unfilterByte(
        filter,
        inflated[inputOffset + index],
        index,
        current,
        previous,
        bytesPerPixel,
      );
    }
    inputOffset += rowLength;

    if (header.colorType === 3) {
      for (let pixel = 0; pixel < header.width; pixel += 1) {
        const bitOffset = pixel * header.bitDepth;
        const byte = current[Math.floor(bitOffset / 8)];
        const shift = 8 - header.bitDepth - (bitOffset % 8);
        const paletteIndex = (byte >>> shift) & ((1 << header.bitDepth) - 1);
        if (paletteIndex >= paletteEntryCount) {
          throw new Error(
            `${filePath} references PNG palette index ${paletteIndex}, but only ${paletteEntryCount} entries exist`,
          );
        }
        usedPaletteIndexes?.add(paletteIndex);
      }
    }

    if (transparentKey) {
      for (let index = 0; index + channels <= rowLength; index += channels) {
        let matches = true;
        for (let channel = 0; channel < channels; channel += 1) {
          if (current[index + channel] !== transparentKey[channel]) {
            matches = false;
            break;
          }
        }
        if (matches) {
          opaque = false;
        }
      }
    }

    if (inspectAlpha) {
      for (
        let alphaIndex = channels - 1;
        alphaIndex < rowLength;
        alphaIndex += channels
      ) {
        if (current[alphaIndex] !== 0xff) {
          opaque = false;
        }
      }
    }
    previous = current;
  }

  return opaque;
}

function pngIsOpaque(
  filePath,
  header,
  imageData,
  transparency,
  paletteEntryCount,
) {
  if (header.colorType === 0 || header.colorType === 2) {
    if (!transparency) {
      decodePngRows(filePath, header, imageData, false);
      return true;
    }
    // tRNS on these color types nominates one colour as transparent. The icon is
    // only actually transparent if some pixel uses that colour, so compare the
    // decoded pixels instead of treating the chunk's presence as proof.
    const channels = header.colorType === 0 ? 1 : 3;
    const samples = [];
    let representable = header.bitDepth === 8;
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = transparency.readUInt16BE(channel * 2);
      if (sample > 0xff) {
        representable = false;
      }
      samples.push(sample & 0xff);
    }
    if (!representable) {
      // The pixel comparison below works on whole bytes, so it only applies to
      // 8-bit samples. For 1/2/4-bit packed rows and for 16-bit samples that no
      // 8-bit row can equal, stay strict and treat the declared transparent
      // colour as used. App icons are 8-bit, so this is a conservative fallback
      // rather than the normal path.
      decodePngRows(filePath, header, imageData, false);
      return false;
    }
    return decodePngRows(
      filePath,
      header,
      imageData,
      false,
      undefined,
      undefined,
      samples,
    );
  }
  if (header.colorType === 3) {
    // Judge opacity by the palette entries the image actually references. A
    // transparent entry that no pixel uses does not make the icon transparent,
    // and failing on it would reject a valid asset.
    const usedPaletteIndexes = new Set();
    decodePngRows(
      filePath,
      header,
      imageData,
      false,
      paletteEntryCount,
      usedPaletteIndexes,
    );
    if (!transparency) {
      return true;
    }
    for (const index of usedPaletteIndexes) {
      if (index < transparency.length && transparency[index] !== 0xff) {
        return false;
      }
    }
    return true;
  }
  if (header.colorType === 4 || header.colorType === 6) {
    return decodePngRows(filePath, header, imageData, true);
  }
  throw new Error(
    `${filePath} uses unsupported PNG color type ${header.colorType}`,
  );
}

function verifyDimensions(filePath, expectedSize, errors) {
  if (!fs.existsSync(filePath)) {
    errors.push(`Missing icon: ${path.relative(process.cwd(), filePath)}`);
    return;
  }

  try {
    const png = parsePng(filePath);
    if (png.width !== expectedSize || png.height !== expectedSize) {
      errors.push(
        `${path.relative(process.cwd(), filePath)} is ${png.width}x${png.height}; expected ${expectedSize}x${expectedSize}`,
      );
    }
    return png;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
}

function verifyAndroidIcons(errors) {
  const densitySizes = {
    mdpi: [48, 108],
    hdpi: [72, 162],
    xhdpi: [96, 216],
    xxhdpi: [144, 324],
    xxxhdpi: [192, 432],
  };

  for (const [density, [launcherSize, foregroundSize]] of Object.entries(
    densitySizes,
  )) {
    const directory = path.join(ICONS_ROOT, "android", `mipmap-${density}`);
    verifyDimensions(
      path.join(directory, "ic_launcher.png"),
      launcherSize,
      errors,
    );
    verifyDimensions(
      path.join(directory, "ic_launcher_round.png"),
      launcherSize,
      errors,
    );
    verifyDimensions(
      path.join(directory, "ic_launcher_foreground.png"),
      foregroundSize,
      errors,
    );
  }
}

export function verifyIosIcons(
  errors,
  directory = path.join(ICONS_ROOT, "ios"),
) {
  for (const [fileName, expectedSize] of Object.entries(REQUIRED_IOS_ICONS)) {
    const filePath = path.join(directory, fileName);
    const png = verifyDimensions(filePath, expectedSize, errors);
    if (png && !png.opaque) {
      errors.push(
        `${path.relative(process.cwd(), filePath)} contains transparent pixels`,
      );
    }
  }

  if (!fs.existsSync(directory)) {
    return;
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      entry.name.endsWith(".png") &&
      !Object.hasOwn(REQUIRED_IOS_ICONS, entry.name)
    ) {
      errors.push(`Unexpected iOS icon filename: ${entry.name}`);
    }
  }
}

function verifyAssetInvariants() {
  const errors = [];
  verifyAndroidIcons(errors);
  verifyIosIcons(errors);
  if (errors.length > 0) {
    throw new Error(`Icon validation failed:\n- ${errors.join("\n- ")}`);
  }
}

function main() {
  const iconsetDirs = getIconsetDirs(ICONS_ROOT);
  let totalRenamed = 0;

  for (const iconsetDir of iconsetDirs) {
    const renamed = normalizeIconset(iconsetDir);
    totalRenamed += renamed;
    if (renamed > 0) {
      console.log(
        `Normalized ${renamed} file(s) in ${path.relative(process.cwd(), iconsetDir)}.`,
      );
    }
  }

  verifyAssetInvariants();

  if (CHECK_ONLY) {
    console.log("Icon filenames, dimensions, and opacity are valid.");
  } else if (totalRenamed === 0) {
    console.log("Iconsets are already normalized; icon assets are valid.");
  }
}

if (isDirectExecution(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
