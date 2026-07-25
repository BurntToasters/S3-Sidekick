import { describe, expect, it } from "vitest";

describe("transfers UI shell", () => {
  it("expects summary and overflow elements used by the queue header", () => {
    document.body.innerHTML = `
      <div id="transfer-queue-summary" class="transfer-queue-summary"></div>
      <button id="transfer-more" type="button"></button>
      <button id="transfer-pause-all"></button>
      <button id="transfer-resume-all"></button>
      <div id="transfer-list" class="transfer-list"></div>
      <span id="transfer-badge"></span>
      <span id="drawer-transfer-badge"></span>
    `;
    expect(document.getElementById("transfer-queue-summary")).not.toBeNull();
    expect(document.getElementById("transfer-more")).not.toBeNull();
    expect(document.getElementById("transfer-pause-all")).not.toBeNull();
  });
});
