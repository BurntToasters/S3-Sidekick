#!/usr/bin/env node
// Full-stack E2E: the real app (webview, IPC access control, Rust backend)
// through tauri-driver against throwaway MinIO. Linux only (WebKitWebDriver).
// Rerun: npm run tauri -- build --debug --no-bundle, then
//   xvfb-run npm run test:e2e:fullstack
// Writes test-results/fullstack/report.json and final.png.
//
// Failure modes checked before implementation: capabilities deny a command
// the UI needs (only the real runtime shows it); first-run setup cannot
// finish; the real client cannot list buckets; a folder create never reaches
// the server; a silent step still passes (every check recorded, incomplete
// sets fail); the run touches real app data or leaves MinIO running.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Builder, By, until } from "selenium-webdriver";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "test-results", "fullstack");
const application = path.join(
  root,
  "src-tauri",
  "target",
  "debug",
  "s3-sidekick",
);
const image =
  process.env.S3_SIDEKICK_E2E_MINIO_IMAGE ??
  "bitnamilegacy/minio:2025.5.24-debian-12-r5@sha256:451fe6858cb770cc9d0e77ba811ce287420f781c7c1b806a386f6896471a349c";
const container = `s3sk-fullstack-minio-${process.pid}`;
const endpoint = "http://127.0.0.1:9000";
const accessKey = "e2eadmin";
const secretKey = "e2eadmin-secret";
const bucket = "s3sk-fullstack";
const folder = "smoke-folder";
const EXPECTED_CHECKS = 5;
const STEP_TIMEOUT_MS = 30_000;
const checks = [];

function check(name, passed, observed = undefined) {
  checks.push({
    name,
    passed,
    ...(observed === undefined ? {} : { observed }),
  });
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${name}\n`);
  if (!passed) throw new Error(`check failed: ${name}`);
}

function docker(...args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`docker ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${url} did not become ready`);
}

async function click(driver, id) {
  const element = await driver.wait(
    until.elementLocated(By.id(id)),
    STEP_TIMEOUT_MS,
  );
  await driver.wait(until.elementIsVisible(element), STEP_TIMEOUT_MS);
  await element.click();
}

async function type(driver, id, text) {
  const element = await driver.wait(
    until.elementLocated(By.id(id)),
    STEP_TIMEOUT_MS,
  );
  await element.clear();
  await element.sendKeys(text);
}

async function run(driver) {
  // First run: skip encryption and automatic update checks.
  await click(driver, "setup-welcome-next");
  await click(driver, "setup-theme-next");
  await click(driver, "setup-enc-skip");
  const autoUpdates = await driver.wait(
    until.elementLocated(By.id("setup-auto-updates")),
    STEP_TIMEOUT_MS,
  );
  if (await autoUpdates.isSelected()) await autoUpdates.click();
  await click(driver, "setup-updates-next");
  await click(driver, "setup-done-btn");
  const overlay = await driver.findElement(By.id("setup-wizard-overlay"));
  await driver.wait(until.elementIsNotVisible(overlay), STEP_TIMEOUT_MS);
  check("first-run setup completes", true);

  await type(driver, "conn-endpoint", endpoint);
  await type(driver, "conn-access-key", accessKey);
  await type(driver, "conn-secret-key", secretKey);
  await click(driver, "connect-btn");
  const layout = await driver.wait(
    until.elementLocated(By.id("main-layout")),
    STEP_TIMEOUT_MS,
  );
  await driver.wait(until.elementIsVisible(layout), STEP_TIMEOUT_MS);
  check("connects to MinIO through the real backend", true);

  const bucketButton = await driver.wait(
    until.elementLocated(
      By.xpath(
        `//*[@id="bucket-list"]//*[contains(@class,"list__item-btn")][contains(normalize-space(.),"${bucket}")]`,
      ),
    ),
    STEP_TIMEOUT_MS,
  );
  check("lists the seeded bucket", true, bucket);
  await bucketButton.click();

  await click(driver, "btn-new-folder");
  await type(driver, "dialog-input", folder);
  await click(driver, "dialog-ok");
  await driver.wait(
    until.elementLocated(By.css(`tr[data-prefix="${folder}/"]`)),
    STEP_TIMEOUT_MS,
  );
  check("created folder appears in the listing", true, `${folder}/`);

  const stored = spawnSync(
    "docker",
    ["exec", container, "sh", "-c", `ls /bitnami/minio/data/${bucket}`],
    { encoding: "utf8" },
  );
  check(
    "folder marker reached the server",
    stored.status === 0 && stored.stdout.includes(folder),
    stored.stdout.trim() || stored.stderr.trim(),
  );
}

async function main() {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  if (process.platform !== "linux") {
    throw new Error(
      "The full-stack E2E needs Linux (tauri-driver + WebKitWebDriver).",
    );
  }
  if (!fs.existsSync(application)) {
    throw new Error(
      `App binary missing: ${application}. Run: npm run tauri -- build --debug --no-bundle`,
    );
  }
  // Isolated app data: the run never touches the developer's own profile.
  const xdgHome = fs.mkdtempSync(path.join(os.tmpdir(), "s3sk-fullstack-"));
  let driverProcess;
  let driver;
  let failure = null;
  let started = false;
  try {
    docker(
      "run",
      "-d",
      "--rm",
      "--name",
      container,
      "-p",
      "127.0.0.1:9000:9000",
      "-e",
      `MINIO_ROOT_USER=${accessKey}`,
      "-e",
      `MINIO_ROOT_PASSWORD=${secretKey}`,
      "-e",
      `MINIO_DEFAULT_BUCKETS=${bucket}`,
      image,
    );
    started = true;
    await waitFor(`${endpoint}/minio/health/live`, 60_000);

    driverProcess = spawn("tauri-driver", [], {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        XDG_DATA_HOME: path.join(xdgHome, "data"),
        XDG_CONFIG_HOME: path.join(xdgHome, "config"),
      },
    });
    await waitFor("http://127.0.0.1:4444/status", 30_000);

    driver = await new Builder()
      .usingServer("http://127.0.0.1:4444/")
      .withCapabilities({
        browserName: "wry",
        "tauri:options": { application },
      })
      .build();
    await run(driver);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (driver) {
      try {
        const png = await driver.takeScreenshot();
        fs.writeFileSync(path.join(outDir, "final.png"), png, "base64");
      } catch {
        // screenshot is diagnostic only
      }
      await driver.quit().catch(() => undefined);
    }
    driverProcess?.kill();
    if (started) spawnSync("docker", ["rm", "-f", container]);
    fs.rmSync(xdgHome, { recursive: true, force: true });
  }

  const passed =
    failure === null &&
    checks.length === EXPECTED_CHECKS &&
    checks.every((entry) => entry.passed);
  fs.writeFileSync(
    path.join(outDir, "report.json"),
    `${JSON.stringify(
      {
        suite: "fullstack-real-app",
        passed,
        failure,
        image,
        checkCount: checks.length,
        checks,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(
    `\nFull-stack E2E: ${passed ? "PASS" : "FAIL"} (${checks.filter((c) => c.passed).length}/${EXPECTED_CHECKS})${failure ? `: ${failure}` : ""}\n`,
  );
  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
