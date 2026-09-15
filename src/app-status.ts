import { state, dom } from "./state.ts";

export function setStatus(text: string, autoResetMs?: number): void {
  if (state.statusTimeout !== undefined) {
    clearTimeout(state.statusTimeout);
    state.statusTimeout = undefined;
  }
  dom.statusEl.textContent = text;
  if (autoResetMs && autoResetMs > 0) {
    state.statusTimeout = setTimeout(() => {
      state.statusTimeout = undefined;
      if (typeof document === "undefined") return;
      const el = document.getElementById("status");
      if (el) el.textContent = "";
    }, autoResetMs);
  }
}
