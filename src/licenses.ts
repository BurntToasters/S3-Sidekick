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

async function renderLicenses() {
  const container = $("licenses-list");
  container.innerHTML = `<div class="metadata-loading"><span class="spinner"></span>Loading&#8230;</div>`;

  try {
    const resp = await fetch("/licenses.json");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as Record<string, LicenseEntry>;
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
