// Pure status-page logic: component states, debouncing, daily uptime and
// incidents. No I/O, so it is unit-tested in plain Node.

export const COMPONENTS = [
  { id: "website", name: "Website" },
  { id: "console", name: "Console" },
  { id: "api", name: "API" },
  { id: "database", name: "Database" },
  { id: "build_workers", name: "Build workers" },
];

// States from best to worst; "unknown" means no data yet.
export const RANK = { operational: 0, maintenance: 1, degraded: 2, outage: 3, unknown: -1 };
export const DAYS_KEPT = 90;
export const INCIDENTS_KEPT = 30;
// A component must fail this many checks in a row before it is shown as down,
// so a single slow probe does not open an incident.
export const FAILURES_TO_CONFIRM = 2;

export function initialStatusState() {
  return { components: {}, pending: {}, days: {}, incidents: [] };
}

export function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Applies one round of raw observations ({componentId: state}) taken at
 * `now`. Returns the new state and the alerts to send: {component, kind}
 * with kind "down" or "recovered".
 */
export function applyObservations(prev, observed, now) {
  const state = {
    components: { ...prev.components },
    pending: { ...prev.pending },
    days: { ...prev.days },
    incidents: prev.incidents.slice(),
  };
  const alerts = [];
  const day = dayKey(now);
  const today = { ...(state.days[day] ?? {}) };

  for (const { id } of COMPONENTS) {
    const raw = observed[id] ?? "unknown";
    const current = state.components[id] ?? { status: "unknown", since: now };
    let shown = current.status;

    if (raw === "outage" || raw === "degraded") {
      const streak = (state.pending[id] ?? 0) + 1;
      state.pending[id] = streak;
      if (streak >= FAILURES_TO_CONFIRM || current.status === "outage" || current.status === "degraded") shown = raw;
    } else {
      state.pending[id] = 0;
      shown = raw;
    }

    if (shown !== current.status) {
      const wasBad = current.status === "outage" || current.status === "degraded";
      const isBad = shown === "outage" || shown === "degraded";
      if (isBad && !wasBad) {
        state.incidents.unshift({ component: id, status: shown, start: now, end: null });
        alerts.push({ component: id, kind: "down", status: shown });
      } else if (!isBad && wasBad) {
        const open = state.incidents.find((i) => i.component === id && i.end === null);
        if (open) open.end = now;
        alerts.push({ component: id, kind: "recovered", status: shown });
      } else if (isBad && wasBad) {
        const open = state.incidents.find((i) => i.component === id && i.end === null);
        if (open) open.status = RANK[shown] > RANK[open.status] ? shown : open.status;
      }
      state.components[id] = { status: shown, since: now };
    }

    // Daily uptime: maintenance and unknown are excluded from the denominator.
    if (shown !== "unknown" && shown !== "maintenance") {
      const [up, total] = today[id] ?? [0, 0];
      today[id] = [up + (shown === "operational" ? 1 : 0), total + 1];
    }
  }

  state.days[day] = today;
  const keep = Object.keys(state.days).sort().slice(-DAYS_KEPT);
  state.days = Object.fromEntries(keep.map((k) => [k, state.days[k]]));
  state.incidents = state.incidents.slice(0, INCIDENTS_KEPT);
  return { state, alerts };
}

/** Worst current component state; "unknown" before any data. */
export function overall(state) {
  let worst = null;
  for (const { id } of COMPONENTS) {
    const s = state.components[id]?.status ?? "unknown";
    if (s === "unknown") continue;
    if (worst === null || RANK[s] > RANK[worst]) worst = s;
  }
  return worst ?? "unknown";
}

/** Uptime percentage over the kept days, or null without data. */
export function uptime(state, id) {
  let up = 0;
  let total = 0;
  for (const d of Object.values(state.days)) {
    const [u, t] = d[id] ?? [0, 0];
    up += u;
    total += t;
  }
  return total ? (100 * up) / total : null;
}

/**
 * Turns probe results into observations. `apiStatus` is the parsed JSON of
 * GET /v1/status, or null when the API could not be reached.
 */
export function observationsFrom({ websiteOk, consoleOk, apiStatus }) {
  const obs = {
    website: websiteOk ? "operational" : "outage",
    console: consoleOk ? "operational" : "outage",
  };
  if (!apiStatus || typeof apiStatus.components !== "object") {
    obs.api = "outage";
    obs.database = "unknown";
    obs.build_workers = "unknown";
  } else {
    for (const id of ["api", "database", "build_workers"]) {
      const v = apiStatus.components[id];
      obs[id] = v in RANK && v !== "unknown" ? v : "unknown";
    }
  }
  return obs;
}
