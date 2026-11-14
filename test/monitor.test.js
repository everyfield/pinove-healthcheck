import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPing, evaluate, initialState, status, HISTORY_LIMIT } from "../src/monitor.js";

const H = 3600000;
const GRACE = 26 * H;

test("first success is up without an alert", () => {
  const { state, alert } = applyPing(initialState(), "success", 1000);
  assert.equal(alert, null);
  assert.equal(status(state, 2000, GRACE), "up");
});

test("failure alerts once, success recovers once", () => {
  let s = applyPing(initialState(), "success", 0).state;
  let r = applyPing(s, "fail", H);
  assert.equal(r.alert, "failure");
  assert.equal(status(r.state, H, GRACE), "failing");
  r = applyPing(r.state, "fail", 2 * H);
  assert.equal(r.alert, null, "repeated failure must not alert again");
  r = applyPing(r.state, "success", 3 * H);
  assert.equal(r.alert, "recovered");
  assert.equal(status(r.state, 3 * H, GRACE), "up");
  r = applyPing(r.state, "success", 4 * H);
  assert.equal(r.alert, null);
});

test("missing success becomes overdue and alerts once", () => {
  const s = applyPing(initialState(), "success", 0).state;
  assert.equal(evaluate(s, 25 * H, GRACE).alert, null);
  const e = evaluate(s, 27 * H, GRACE);
  assert.equal(e.alert, "overdue");
  assert.equal(evaluate(e.state, 28 * H, GRACE).alert, null);
  assert.equal(applyPing(e.state, "success", 29 * H).alert, "recovered");
});

test("waiting before the first ping never alerts", () => {
  assert.equal(status(initialState(), 100 * H, GRACE), "waiting");
  assert.equal(evaluate(initialState(), 100 * H, GRACE).alert, null);
});

test("history is bounded", () => {
  let s = initialState();
  for (let i = 0; i < HISTORY_LIMIT + 10; i++) s = applyPing(s, "success", i).state;
  assert.equal(s.history.length, HISTORY_LIMIT);
  assert.equal(s.history[0].at, HISTORY_LIMIT + 9);
});

test("unknown ping kind is rejected", () => {
  assert.throws(() => applyPing(initialState(), "maybe", 0));
});
