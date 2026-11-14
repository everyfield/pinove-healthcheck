import { COMPONENTS, DAYS_KEPT, dayKey, overall, uptime } from "./status.js";

const STATE_LABEL = {
  operational: "Operational",
  maintenance: "Maintenance",
  degraded: "Degraded",
  outage: "Outage",
  unknown: "No data",
};

const HEADLINE = {
  operational: "All systems operational",
  maintenance: "Scheduled maintenance",
  degraded: "Degraded performance",
  outage: "Service disruption",
  unknown: "Collecting data",
};

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function when(ms) {
  return ms != null ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "Never";
}

function duration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} days`;
}

// One bar per day for the last 90 days. Opacity encodes uptime so the page
// stays black and white; days without data are outlined only.
function bars(state, id, now) {
  const out = [];
  for (let i = DAYS_KEPT - 1; i >= 0; i--) {
    const key = dayKey(now - i * 86400000);
    const [up, total] = state.days[key]?.[id] ?? [0, 0];
    if (!total) {
      out.push(`<i class="none" title="${key}: no data"></i>`);
      continue;
    }
    const pct = (100 * up) / total;
    const opacity = pct >= 99.9 ? 1 : pct >= 99 ? 0.7 : pct >= 95 ? 0.45 : 0.2;
    out.push(`<i style="opacity:${opacity}" title="${key}: ${pct.toFixed(2)}%"></i>`);
  }
  return out.join("");
}

/** Public status page: black and white, no client-side script. */
export function renderStatusPage(state, backup, now) {
  const head = overall(state);
  const rows = COMPONENTS.map(({ id, name }) => {
    const c = state.components[id] ?? { status: "unknown" };
    const u = uptime(state, id);
    return `<section class="component">
      <div class="row"><h2>${escapeHTML(name)}</h2><span class="st ${c.status}">${STATE_LABEL[c.status]}</span></div>
      <div class="bars" aria-label="${escapeHTML(name)} uptime, last ${DAYS_KEPT} days">${bars(state, id, now)}</div>
      <div class="row small"><span>${DAYS_KEPT} days ago</span><span>${u == null ? "No data" : u.toFixed(2) + "% uptime"}</span><span>Today</span></div>
    </section>`;
  }).join("");
  const incidents = state.incidents.slice(0, 10).map((i) => {
    const name = COMPONENTS.find((c) => c.id === i.component)?.name ?? i.component;
    const end = i.end ?? now;
    return `<tr><td>${escapeHTML(name)}</td><td>${STATE_LABEL[i.status]}</td><td>${when(i.start)}</td><td>${i.end ? duration(end - i.start) : "Ongoing"}</td></tr>`;
  }).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>Pinove status</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #000; color: #fff; font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: min(100% - 32px, 760px); margin: 0 auto; padding: 56px 0 80px; }
  h1 { margin: 0; font-size: 34px; font-weight: 400; letter-spacing: -.03em; }
  .headline { margin: 20px 0 40px; padding: 18px 20px; border: 1px solid rgba(255,255,255,.3); border-radius: 12px; font-size: 18px; }
  .headline.bad { background: #fff; color: #000; }
  .component { padding: 18px 0; border-top: 1px solid rgba(255,255,255,.14); }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  h2 { margin: 0; font-size: 16px; font-weight: 500; }
  .st { font-size: 14px; color: rgba(255,255,255,.72); }
  .st.outage, .st.degraded { color: #fff; text-decoration: underline; text-underline-offset: 4px; }
  .bars { display: grid; grid-template-columns: repeat(${DAYS_KEPT}, 1fr); gap: 2px; height: 28px; margin: 12px 0 6px; }
  .bars i { display: block; background: #fff; border-radius: 2px; }
  .bars i.none { background: transparent; border: 1px solid rgba(255,255,255,.18); }
  .small { font-size: 12px; color: rgba(255,255,255,.5); }
  h3 { margin: 48px 0 8px; font-size: 18px; font-weight: 500; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 8px 8px 8px 0; border-top: 1px solid rgba(255,255,255,.14); color: rgba(255,255,255,.78); font-size: 14px; }
  dl { display: grid; grid-template-columns: 160px 1fr; gap: 6px 16px; margin: 8px 0; font-size: 14px; }
  dt { color: rgba(255,255,255,.55); } dd { margin: 0; }
  @media (max-width: 560px) { .bars { gap: 1px; } dl { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
  <h1>Pinove status</h1>
  <p class="headline${head === "outage" || head === "degraded" ? " bad" : ""}">${HEADLINE[head]}</p>
  ${rows}
  <h3>Backups</h3>
  <dl>
    <dt>Last success</dt><dd>${when(backup.lastSuccess)}</dd>
    <dt>Last failure</dt><dd>${when(backup.lastFailure)}</dd>
  </dl>
  <h3>Recent incidents</h3>
  ${incidents ? `<table>${incidents}</table>` : `<p class="small">No incidents recorded.</p>`}
  <p class="small" style="margin-top:40px">Checked every 5 minutes. Last check ${when(state.lastCheck ?? null)}.</p>
</main>
</body>
</html>`;
}
