import { beforeEach, describe, expect, it, vi } from "vitest";

import { closeLicensesModal, openLicensesModal } from "../licenses.ts";

async function flushMicrotasks(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve();
  }
}

describe("licenses modal", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="licenses-overlay" class="modal-overlay"></div>
      <div id="licenses-list"></div>
    `;
    vi.unstubAllGlobals();
  });

  it("opens, fetches licenses, and renders cards", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/licenses.json")) {
          return {
            ok: true,
            json: async () => ({
              "pkg-a": {
                licenses: "MIT",
                repository: "https://example.com/pkg-a",
              },
              "pkg-b": {
                licenses: "Apache-2.0",
                repository: "javascript:alert('xss')",
              },
              "pkg-c": {
                licenses: "BSD-3-Clause",
              },
            }),
          };
        }
        if (url.endsWith("/licenses-cargo.json")) {
          return {
            ok: true,
            json: async () => ({
              "cargo:pkg-rs@1.2.3": {
                licenses: "MIT OR Apache-2.0",
                repository: "https://github.com/example/pkg-rs",
              },
            }),
          };
        }
        return { ok: false, status: 404 };
      });
    vi.stubGlobal("fetch", fetchMock);

    openLicensesModal();
    await flushMicrotasks();

    const overlay = document.getElementById(
      "licenses-overlay",
    ) as HTMLDivElement;
    const list = document.getElementById("licenses-list") as HTMLDivElement;
    expect(overlay.classList.contains("active")).toBe(true);

    const cards = list.querySelectorAll("details.license-card");
    expect(cards).toHaveLength(4);
    expect(cards[0].textContent).toContain("pkg-a");
    expect(cards[0].textContent).toContain("MIT");
    expect(cards[0].querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/pkg-a",
    );
    expect(cards[1].textContent).toContain("N/A");
    expect(cards[2].textContent).toContain("N/A");
    expect(cards[3].textContent).toContain("cargo:pkg-rs@1.2.3");
    expect(cards[3].textContent).toContain("MIT OR Apache-2.0");
    expect(cards[3].querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/example/pkg-rs",
    );
    expect(fetchMock).toHaveBeenCalledWith("/licenses.json");
    expect(fetchMock).toHaveBeenCalledWith("/licenses-cargo.json");
  });

  it("keeps rendering when cargo licenses file is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/licenses.json")) {
          return {
            ok: true,
            json: async () => ({
              "pkg-a": {
                licenses: "MIT",
                repository: "https://example.com/pkg-a",
              },
            }),
          };
        }
        if (url.endsWith("/licenses-cargo.json")) {
          return {
            ok: false,
            status: 404,
          };
        }
        return { ok: false, status: 404 };
      }),
    );

    openLicensesModal();
    await flushMicrotasks();

    const list = document.getElementById("licenses-list") as HTMLDivElement;
    const cards = list.querySelectorAll("details.license-card");
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain("pkg-a");
  });

  it("shows failure message when request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/licenses.json")) {
          return {
            ok: false,
            status: 500,
          };
        }
        if (url.endsWith("/licenses-cargo.json")) {
          return {
            ok: false,
            status: 404,
          };
        }
        return { ok: false, status: 404 };
      }),
    );

    openLicensesModal();
    await flushMicrotasks();

    const list = document.getElementById("licenses-list") as HTMLDivElement;
    expect(list.textContent).toContain("Failed to load licenses.");
  });

  it("closes the modal", () => {
    const overlay = document.getElementById(
      "licenses-overlay",
    ) as HTMLDivElement;
    overlay.classList.add("active");
    closeLicensesModal();
    expect(overlay.classList.contains("active")).toBe(false);
  });
});
