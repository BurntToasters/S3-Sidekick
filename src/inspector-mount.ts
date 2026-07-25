import { $ } from "./utils.ts";

export function shouldUseInspectorMount(): boolean {
  const panel = document.getElementById("inspector-panel");
  return !!panel && !panel.hidden;
}

export function getPreviewTitleEl(): HTMLElement {
  return shouldUseInspectorMount()
    ? $<HTMLElement>("inspector-preview-title")
    : $("preview-title");
}

export function getPreviewBodyEl(): HTMLElement {
  return shouldUseInspectorMount()
    ? $<HTMLElement>("inspector-preview-body")
    : $("preview-body");
}

export function showPreviewOverlay(active: boolean): void {
  if (shouldUseInspectorMount()) return;
  $("preview-overlay").classList.toggle("active", active);
}

export function hidePreviewOverlay(): void {
  if (!shouldUseInspectorMount()) {
    $("preview-overlay").classList.remove("active");
  }
}

export function getInfoTitleEl(): HTMLElement {
  return shouldUseInspectorMount()
    ? $<HTMLElement>("inspector-info-title")
    : $("info-title");
}

export function getInfoBodyEl(): HTMLElement {
  return shouldUseInspectorMount()
    ? $<HTMLElement>("inspector-info-body")
    : $("info-body");
}

export function getInfoSaveBtn(): HTMLButtonElement {
  return shouldUseInspectorMount()
    ? $<HTMLButtonElement>("inspector-info-save")
    : $<HTMLButtonElement>("info-save");
}

export function setInfoOverlayActive(active: boolean): void {
  if (shouldUseInspectorMount()) return;
  $("info-overlay").classList.toggle("active", active);
}

export function clearInfoOverlayActive(): void {
  if (!shouldUseInspectorMount()) {
    $("info-overlay").classList.remove("active");
  }
}
