import { $, escapeHtml, safeHref } from "./utils.ts";

export interface LicenseEntry {
  licenses: string;
  repository?: string;
  licenseUrl?: string;
  parents?: string;
}

export function openLicensesModal() {
  $("licenses-overlay").classList.add("active");
  void renderLicenses();
}

export function closeLicensesModal() {
  $("licenses-overlay").classList.remove("active");
}

async function loadLicenseFile(
  path: string,
  required: boolean,
): Promise<Record<string, LicenseEntry>> {
  const response = await fetch(path);
  if (!response.ok) {
    if (!required && response.status === 404) {
      return {};
    }
    throw new Error(`HTTP ${response.status}`);
  }

  const parsed = (await response.json()) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }

  return parsed as Record<string, LicenseEntry>;
}

async function renderLicenses() {
  const container = $("licenses-list");
  container.innerHTML = `<div class="metadata-loading"><span class="spinner"></span>Loading&#8230;</div>`;

  try {
    const [npmLicenses, cargoLicenses] = await Promise.all([
      loadLicenseFile("/licenses.json", true),
      loadLicenseFile("/licenses-cargo.json", false),
    ]);
    const data = { ...npmLicenses, ...cargoLicenses };
    container.innerHTML = "";

    for (const [key, entry] of Object.entries(data)) {
      const card = document.createElement("details");
      card.className = "license-card";

      const href = entry.repository ? safeHref(entry.repository) : "";
      const repoLink =
        href && href !== "#"
          ? `<a href="${href}" target="_blank" rel="noopener">${escapeHtml(entry.repository!)}</a>`
          : "N/A";

      card.innerHTML =
        `<summary class="license-card__header">` +
        `<strong>${escapeHtml(key)}</strong><span class="license-card__tag">${escapeHtml(entry.licenses)}</span>` +
        `</summary>` +
        `<div class="license-card__body">${repoLink}</div>`;
      container.appendChild(card);
    }
  } catch {
    container.textContent = "Failed to load licenses.";
  }
}
