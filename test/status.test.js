import { test } from "node:test";
import assert from "node:assert/strict";
import { applyObservations, initialStatusState, observationsFrom, overall, uptime, DAYS_KEPT } from "../src/status.js";
import { renderStatusPage } from "../src/page.js";
import { initialState } from "../src/monitor.js";

const MIN = 60000;
const allUp = { website: "operational", console: "operational", api: "operational", database: "operational", build_workers: "operational", backups: "operational" };

test("a single failed check does not open an incident; two do", () => {
  let s = applyObservations(initialStatusState(), allUp, 0).state;
  let r = applyObservations(s, { ...allUp, api: "outage" }, 5 * MIN);
  assert.equal(r.state.components.api.status, "operational");
  assert.deepEqual(r.alerts, []);
  r = applyObservations(r.state, { ...allUp, api: "outage" }, 10 * MIN);
  assert.equal(r.state.components.api.status, "outage");
  assert.deepEqual(r.alerts, [{ component: "api", kind: "down", status: "outage" }]);
  assert.equal(r.state.incidents[0].end, null);
  r = applyObservations(r.state, allUp, 15 * MIN);
  assert.deepEqual(r.alerts, [{ component: "api", kind: "recovered", status: "operational" }]);
  assert.equal(r.state.incidents[0].end, 15 * MIN);
  assert.equal(overall(r.state), "operational");
});

test("maintenance is shown at once and excluded from uptime", () => {
  let s = applyObservations(initialStatusState(), allUp, 0).state;
  const r = applyObservations(s, { ...allUp, build_workers: "maintenance" }, MIN);
  assert.equal(r.state.components.build_workers.status, "maintenance");
  assert.deepEqual(r.alerts, []);
  assert.equal(uptime(r.state, "build_workers"), 100);
  assert.equal(overall(r.state), "maintenance");
});

test("uptime counts operational checks per day and keeps 90 days", () => {
  let s = initialStatusState();
  for (let d = 0; d < DAYS_KEPT + 5; d++) s = applyObservations(s, allUp, d * 86400000).state;
  assert.equal(Object.keys(s.days).length, DAYS_KEPT);
  assert.equal(uptime(s, "website"), 100);
});

test("unreachable API marks dependent components unknown, not down", () => {
  const obs = observationsFrom({ websiteOk: true, consoleOk: true, apiStatus: null, backupStatus: "waiting" });
  assert.deepEqual(obs, { website: "operational", console: "operational", backups: "unknown", api: "outage", database: "unknown", build_workers: "unknown" });
  const ok = observationsFrom({ websiteOk: true, consoleOk: false, apiStatus: { components: { api: "operational", database: "operational", build_workers: "degraded" } }, backupStatus: "overdue" });
  assert.equal(ok.console, "outage");
  assert.equal(ok.build_workers, "degraded");
  assert.equal(ok.backups, "outage");
});

test("unexpected API values are treated as unknown", () => {
  const obs = observationsFrom({ websiteOk: true, consoleOk: true, apiStatus: { components: { api: "<b>", database: 1 } }, backupStatus: "up" });
  assert.equal(obs.api, "unknown");
  assert.equal(obs.database, "unknown");
});

test("status page renders components, headline and incidents", () => {
  let s = applyObservations(initialStatusState(), allUp, Date.UTC(2026, 10, 14)).state;
  s = applyObservations(s, { ...allUp, console: "outage" }, Date.UTC(2026, 10, 14, 0, 5)).state;
  s = applyObservations(s, { ...allUp, console: "outage" }, Date.UTC(2026, 10, 14, 0, 10)).state;
  const html = renderStatusPage(s, initialState(), Date.UTC(2026, 10, 14, 0, 15));
  assert.ok(html.includes("Service disruption"));
  assert.ok(html.includes("Console"));
  assert.ok(html.includes("Ongoing"));
  assert.ok(!html.includes("<script"));
});
