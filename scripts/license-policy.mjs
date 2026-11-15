// Dependency license policy for bundled files.
//
// The allowlist is deliberately explicit. A new dependency with a license not
// listed here fails the build until a human decides it is acceptable, and an
// UNKNOWN/UNLICENSED third-party entry always fails (M14).

export const ALLOWED_LICENSES = Object.freeze([
  "0BSD",
  "Apache-2.0",
  "Apache-2.0 WITH LLVM-exception",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSL-1.0",
  "CC0-1.0",
  "CDLA-Permissive-2.0",
  "ISC",
  "LGPL-2.1-or-later",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "Unicode-3.0",
  "Unlicense",
  "Zlib",
]);

const ALLOWED = new Set(ALLOWED_LICENSES);

function operands(expression) {
  // Cargo also emits dual-license shorthand (`MIT/Apache-2.0`); treat the
  // slash as OR. SPDX `WITH` stays part of a single operand.
  return String(expression)
    .replace(/[()]/g, " ")
    .split(/\s+(?:AND|OR)\s+|\s*\/\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Problems for one license feed; empty means the feed passes. */
export function licenseProblems(entries, { ownPackagePrefix = "" } = {}) {
  const problems = [];
  for (const [key, entry] of Object.entries(entries ?? {})) {
    if (ownPackagePrefix && key.startsWith(ownPackagePrefix)) continue;
    const license =
      entry && typeof entry.licenses === "string" ? entry.licenses.trim() : "";
    if (!license || license.toUpperCase() === "UNKNOWN") {
      problems.push(`${key}: license is UNKNOWN`);
      continue;
    }
    if (license.toUpperCase() === "UNLICENSED") {
      problems.push(`${key}: license is UNLICENSED`);
      continue;
    }
    const parts = operands(license);
    const denied = parts.filter((part) => !ALLOWED.has(part));
    if (parts.length === 0 || denied.length > 0) {
      problems.push(
        `${key}: license '${license}' is not on the allowlist${
          denied.length > 0 ? ` (${denied.join(", ")})` : ""
        }`,
      );
    }
  }
  return problems;
}

/** Read the workspace package name so its own UNLICENSED entry is exempt. */
export function ownPackagePrefix(packageJson) {
  const name =
    packageJson && typeof packageJson.name === "string"
      ? packageJson.name.trim()
      : "";
  return name ? `${name}@` : "";
}
