import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import type { MockCall } from "./tauri-layout";

/** Provider capabilities that support every create-only write. */
export const FULL_CREATE_ONLY = {
  put_object: true,
  complete_multipart: true,
  copy_object: true,
};

function artifactDir(suite: string, testInfo: TestInfo, name: string): string {
  const dir = path.join("test-results", suite, testInfo.project.name, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function redactValue(value: unknown, key = ""): unknown {
  if (/(?:access|secret|session|password|token)/i.test(key)) {
    return "<redacted>";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }
  if (!value || typeof value !== "object") {
    if (key === "json" && typeof value === "string") {
      try {
        return JSON.stringify(redactValue(JSON.parse(value)));
      } catch {
        return "<redacted>";
      }
    }
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      redactValue(childValue, childKey),
    ]),
  );
}

/**
 * Write the repeatable artifact for one test: a full-page screenshot and the
 * IPC log with credentials redacted, under test-results/<suite>/.
 */
export async function saveArtifact(
  page: Page,
  testInfo: TestInfo,
  suite: string,
  name: string,
  calls: MockCall[],
): Promise<void> {
  const dir = artifactDir(suite, testInfo, name);
  await page.screenshot({ path: path.join(dir, "final.png"), fullPage: true });
  const redacted = calls.map((call) => ({
    command: call.command,
    args: redactValue(call.args),
  }));
  writeFileSync(
    path.join(dir, "ipc-log.json"),
    `${JSON.stringify(redacted, null, 2)}\n`,
  );
}

export function commandCalls(calls: MockCall[], command: string): MockCall[] {
  return calls.filter((call) => call.command === command);
}

export function countOf(calls: MockCall[], command: string): number {
  return commandCalls(calls, command).length;
}

export async function openCopyMoveFromRow(
  page: Page,
  row: Locator,
): Promise<void> {
  await row.click({ button: "right" });
  await page
    .locator('.context-menu [role="menuitem"]', {
      hasText: "Copy / Move to...",
    })
    .click();
  await expect(page.locator("#copy-move-overlay")).toHaveClass(/active/);
}
