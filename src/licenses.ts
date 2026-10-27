import { $, escapeHtml, safeHref } from "./utils.ts";
import { invoke } from "./ipc.ts";
import { logActivity } from "./activity-log.ts";

export interface LicenseEntry {
  licenses: string;
  repository?: string;
  licenseUrl?: string;
  licenseText?: string;
  parents?: string;
}

/** The overlay element the delegated listener is attached to (re-wired if replaced). */
let wiredOverlay: HTMLElement | null = null;

export function openLicensesModal() {
  $("licenses-overlay").classList.add("active");
  wireLicensesModal();
  void renderLicenses();
}

/**
 * Repository links open in the system browser through the same native
 * command as the rest of the app. Retry re-fetches after a failed load.
 */
function wireLicensesModal(): void {
  const overlay = $("licenses-overlay");
  if (wiredOverlay === overlay) return;
  wiredOverlay = overlay;
  overlay.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const link = target.closest<HTMLAnchorElement>("a[data-external-url]");
    if (link) {
      event.preventDefault();
      const url = link.getAttribute("href") ?? "";
      invoke("open_external_url", { url }).catch((err: unknown) => {
        logActivity(`Failed to open ${url}: ${String(err)}`, "warning");
      });
      return;
    }
    if (target.closest("[data-retry]")) {
      void renderLicenses();
    }
  });
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
          ? `<a href="${href}" data-external-url rel="noopener">${escapeHtml(entry.repository!)}</a>`
          : "N/A";
      const licenseText =
        typeof entry.licenseText === "string" && entry.licenseText.trim()
          ? `<pre class="license-card__text">${escapeHtml(entry.licenseText)}</pre>`
          : "";

      card.innerHTML =
        `<summary class="license-card__header">` +
        `<strong>${escapeHtml(key)}</strong><span class="license-card__tag">${escapeHtml(entry.licenses)}</span>` +
        `</summary>` +
        `<div class="license-card__body">${repoLink}${licenseText}</div>`;
      container.appendChild(card);
    }
  } catch {
    container.innerHTML =
      `<div class="license-load-error">` +
      `<p>Failed to load licenses.</p>` +
      `<button type="button" class="btn btn--sm" data-retry>Retry</button>` +
      `</div>`;
  }
}
