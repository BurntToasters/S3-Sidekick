#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import console from "node:console";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "./direct-execution.js";

const TOOLCHAIN_FILE = "rust-toolchain.toml";
const EXACT_RUST_VERSION = /^\d+\.\d+\.\d+$/u;
const SAFE_NAME = /^[A-Za-z0-9_-]+$/u;
const TARGET_TRIPLE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const USAGE =
  "Usage: node scripts/rust-toolchain.mjs [--print | --install [--default] | --default | --target <triple...>]";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function toolchainError(filePath, message, cause) {
  return new Error(
    `${TOOLCHAIN_FILE} ${message}: ${filePath}`,
    cause === undefined ? undefined : { cause },
  );
}

function parseQuotedValue(rawValue, filePath, key) {
  const match = rawValue.trim().match(/^(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/u);
  if (!match) {
    throw toolchainError(
      filePath,
      `has a malformed ${key}; expected a quoted string`,
    );
  }
  return match[1] ?? match[2];
}

function parseComponents(rawValue, lines, startIndex, filePath) {
  const parts = [rawValue];
  let index = startIndex;
  while (!parts.at(-1).includes("]")) {
    index += 1;
    if (index >= lines.length) {
      throw toolchainError(filePath, "has an unterminated components array");
    }
    parts.push(lines[index]);
  }

  const text = parts.map((part) => part.replace(/#[^\n]*/gu, "")).join("\n");
  const body = text.slice(text.indexOf("[") + 1, text.indexOf("]"));
  const entries = body
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw toolchainError(filePath, "has an empty components array");
  }
  const components = entries.map((entry) =>
    parseQuotedValue(entry, filePath, "components"),
  );
  for (const component of components) {
    if (!SAFE_NAME.test(component)) {
      throw toolchainError(
        filePath,
        `has a malformed component name: ${component}`,
      );
    }
  }
  return { components, index };
}

export function readRustToolchainConfig(root = repositoryRoot) {
  const filePath = path.join(root, TOOLCHAIN_FILE);
  let contents;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Rust toolchain pin is missing: ${filePath}`, {
        cause: error,
      });
    }
    throw error;
  }

  const lines = contents.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  let section = "";
  let channel;
  let profile;
  let components = [];
  let componentsSeen = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]\s*(?:#.*)?$/u);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    if (section !== "toolchain") continue;

    const keyValue = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/u);
    if (!keyValue) {
      throw toolchainError(filePath, `has a malformed line: ${line}`);
    }
    const [, key, rawValue] = keyValue;

    if (key === "channel") {
      if (channel !== undefined) {
        throw toolchainError(filePath, "defines channel more than once");
      }
      channel = parseQuotedValue(rawValue, filePath, "channel");
      continue;
    }
    if (key === "profile") {
      if (profile !== undefined) {
        throw toolchainError(filePath, "defines profile more than once");
      }
      profile = parseQuotedValue(rawValue, filePath, "profile");
      if (!profile || !SAFE_NAME.test(profile)) {
        throw toolchainError(
          filePath,
          `has a malformed profile: ${profile || "no value"}`,
        );
      }
      continue;
    }
    if (key === "components") {
      if (componentsSeen) {
        throw toolchainError(filePath, "defines components more than once");
      }
      const parsed = parseComponents(rawValue, lines, index, filePath);
      components = parsed.components;
      componentsSeen = true;
      index = parsed.index;
    }
  }

  if (!channel) {
    throw toolchainError(
      filePath,
      "must pin an exact Rust version; found no channel",
    );
  }
  if (!EXACT_RUST_VERSION.test(channel)) {
    throw toolchainError(
      filePath,
      `must pin an exact Rust version; found ${channel}`,
    );
  }

  return { channel, profile, components };
}

export function readPinnedRustToolchain(root = repositoryRoot) {
  return readRustToolchainConfig(root).channel;
}

export function rustupInstallArgs(toolchain) {
  const config =
    typeof toolchain === "string"
      ? { channel: toolchain, profile: null, components: [] }
      : toolchain;
  if (!EXACT_RUST_VERSION.test(String(config.channel))) {
    throw new Error(`Invalid Rust toolchain: ${config.channel}`);
  }

  const args = [
    "toolchain",
    "install",
    config.channel,
    "--profile",
    config.profile || "minimal",
  ];
  if (config.components?.length) {
    args.push("--component", config.components.join(","));
  }
  return args;
}

export function rustupTargetArgs(toolchain, targets) {
  const channel =
    typeof toolchain === "string" ? toolchain : toolchain?.channel;
  if (!EXACT_RUST_VERSION.test(String(channel))) {
    throw new Error(`Invalid Rust toolchain: ${channel}`);
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("--target requires at least one target triple");
  }
  for (const target of targets) {
    if (typeof target !== "string" || !TARGET_TRIPLE.test(target)) {
      throw new Error(`Invalid target triple: ${target}`);
    }
  }
  return ["target", "add", "--toolchain", channel, ...targets];
}

function parseArguments(argv) {
  const options = {
    print: false,
    install: false,
    defaultToolchain: false,
    targets: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--print") {
      options.print = true;
      continue;
    }
    if (argument === "--install") {
      options.install = true;
      continue;
    }
    if (argument === "--default") {
      options.defaultToolchain = true;
      continue;
    }
    if (argument === "--target") {
      const targets = [];
      while (argv[index + 1] && !argv[index + 1].startsWith("--")) {
        targets.push(argv[(index += 1)]);
      }
      if (targets.length === 0) {
        throw new Error("--target requires at least one target triple");
      }
      options.targets.push(...targets);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}\n${USAGE}`);
  }

  const hasTargets = options.targets.length > 0;
  if (
    options.print &&
    (options.install || options.defaultToolchain || hasTargets)
  ) {
    throw new Error(`--print cannot be combined with an action\n${USAGE}`);
  }
  if (hasTargets && (options.install || options.defaultToolchain)) {
    throw new Error(
      `--target cannot be combined with --install or --default\n${USAGE}`,
    );
  }

  return options;
}

function runRustup(args) {
  const result = spawnSync("rustup", args, {
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error("rustup was not found on PATH", {
        cause: result.error,
      });
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `rustup ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`,
    );
  }
}

function main() {
  const config = readRustToolchainConfig(repositoryRoot);
  const options = parseArguments(process.argv.slice(2));

  if (options.install) {
    runRustup(rustupInstallArgs(config));
  }
  if (options.defaultToolchain) {
    runRustup(["default", config.channel]);
  }
  if (options.targets.length > 0) {
    runRustup(rustupTargetArgs(config.channel, options.targets));
  }
  if (
    options.print ||
    (!options.install && !options.defaultToolchain && !options.targets.length)
  ) {
    console.log(config.channel);
  }
}

if (isDirectExecution(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`rust-toolchain: ${error.message}`);
    process.exitCode = 1;
  }
}
