import { init } from "./app-init.ts";
import { installAsyncErrorReporter } from "./async-errors.ts";

installAsyncErrorReporter();

init().catch((err) => {
  console.error("Init error:", err);
  const el = document.getElementById("status");
  if (el) el.textContent = `Initialization error: ${String(err)}`;
});
