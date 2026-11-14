// Pure monitor logic: no I/O, so it can be unit-tested in plain Node.
//
// A monitor expects a "success" ping at least once per grace period. It is
// "up" after a success, "failing" after an explicit failure ping, "overdue"
// when no success arrived within the grace period, and "waiting" before the
// first ping. Exactly one alert is sent per incident, and one recovery
// message when it ends.

export const HISTORY_LIMIT = 30;

export function initialState() {
  return { lastSuccess: null, lastFailure: null, lastEvent: null, alerted: false, history: [] };
}

function remember(state, kind, now) {
  const history = [{ kind, at: now }, ...state.history].slice(0, HISTORY_LIMIT);
  return { ...state, history, lastEvent: kind };
}

/**
 * Applies a ping. Returns the new state and the alert to send, if any:
 * "failure" for a new failure, "recovered" for a success after an incident.
 */
export function applyPing(state, kind, now) {
  if (kind !== "success" && kind !== "fail") throw new Error("unknown ping kind");
  let next = remember(state, kind, now);
  if (kind === "success") {
    next = { ...next, lastSuccess: now };
    if (state.alerted) return { state: { ...next, alerted: false }, alert: "recovered" };
    return { state: next, alert: null };
  }
  next = { ...next, lastFailure: now };
  if (state.alerted) return { state: next, alert: null };
  return { state: { ...next, alerted: true }, alert: "failure" };
}

/** Checks for a missing success ping (run from the cron trigger). */
export function evaluate(state, now, graceMs) {
  if (status(state, now, graceMs) === "overdue" && !state.alerted) {
    return { state: { ...state, alerted: true }, alert: "overdue" };
  }
  return { state, alert: null };
}

export function status(state, now, graceMs) {
  if (state.lastSuccess == null && state.lastFailure == null) return "waiting";
  if (state.lastEvent === "fail") return "failing";
  if (state.lastSuccess == null || now - state.lastSuccess > graceMs) return "overdue";
  return "up";
}
