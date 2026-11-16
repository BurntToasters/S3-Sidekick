import { beforeEach, describe, expect, it } from "vitest";

describe("state dom getters", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="app"></div>
      <ul id="bucket-list"></ul>
      <table><tbody id="object-tbody"></tbody></table>
      <nav id="breadcrumb"></nav>
      <span id="status"></span>
      <span id="version-label"></span>
      <button id="connect-btn"></button>
      <div id="empty-state"></div>
      <div id="object-panel"></div>
      <aside id="bucket-panel"></aside>
    `;
  });

  it("returns expected elements through dom getters", async () => {
    const { dom } = await import("../state.ts");
    expect(dom.app.id).toBe("app");
    expect(dom.bucketList.id).toBe("bucket-list");
    expect(dom.objectTbody.id).toBe("object-tbody");
    expect(dom.breadcrumb.id).toBe("breadcrumb");
    expect(dom.statusEl.id).toBe("status");
    expect(dom.versionLabel.id).toBe("version-label");
    expect(dom.connectBtn.id).toBe("connect-btn");
    expect(dom.emptyState.id).toBe("empty-state");
    expect(dom.objectPanel.id).toBe("object-panel");
    expect(dom.bucketPanel.id).toBe("bucket-panel");
  });
});

describe("protocol state defaults", () => {
  it("starts on the S3 protocol with no SFTP home path", async () => {
    const { state } = await import("../state.ts");
    expect(state.protocol).toBe("s3");
    expect(state.sftpHomePath).toBe("");
  });
});
