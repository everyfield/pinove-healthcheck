import { status } from "./monitor.js";

const LABELS = {
  up: "Operational",
  failing: "Last run failed",
  overdue: "Overdue",
  waiting: "Waiting for the first run",
};

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function when(ms) {
  return ms != null ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "Never";
}

/** Public status page: black and white, no client-side script. */
export function renderStatusPage(state, now, graceMs, name) {
  const st = status(state, now, graceMs);
  const rows = state.history
    .map((h) => `<tr><td>${h.kind === "success" ? "Succeeded" : "Failed"}</td><td>${when(h.at)}</td></tr>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="300">
<title>${escapeHTML(name)} status</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #000; color: #fff; font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: min(100% - 32px, 640px); margin: 0 auto; padding: 64px 0; }
  h1 { margin: 0; font-size: 32px; font-weight: 400; letter-spacing: -.03em; }
  .state { margin: 24px 0 8px; font-size: 22px; }
  .state.bad { text-decoration: underline; text-underline-offset: 6px; }
  dl { display: grid; grid-template-columns: 160px 1fr; gap: 6px 16px; margin: 24px 0; }
  dt { color: rgba(255,255,255,.55); }
  dd { margin: 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 32px; }
  td { padding: 8px 0; border-top: 1px solid rgba(255,255,255,.14); color: rgba(255,255,255,.78); }
  td:last-child { text-align: right; }
</style>
</head>
<body>
<main>
  <h1>${escapeHTML(name)}</h1>
  <p class="state${st === "up" ? "" : " bad"}">${LABELS[st]}</p>
  <dl>
    <dt>Last success</dt><dd>${when(state.lastSuccess)}</dd>
    <dt>Last failure</dt><dd>${when(state.lastFailure)}</dd>
    <dt>Expected every</dt><dd>${Math.round(graceMs / 3600000)} hours</dd>
  </dl>
  ${rows ? `<table>${rows}</table>` : ""}
</main>
</body>
</html>`;
}
