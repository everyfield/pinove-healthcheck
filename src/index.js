import { DurableObject } from "cloudflare:workers";
import { applyPing, evaluate, initialState, status } from "./monitor.js";
import { renderStatusPage } from "./page.js";

const HOUR = 60 * 60 * 1000;

function graceMs(env) {
  const h = Number(env.GRACE_HOURS ?? 26);
  return (Number.isFinite(h) && h > 0 ? h : 26) * HOUR;
}

// One Durable Object holds the monitor state, so concurrent pings and the
// cron check are serialized and never lose an update.
export class Monitor extends DurableObject {
  async load() {
    return (await this.ctx.storage.get("state")) ?? initialState();
  }

  async ping(kind, now) {
    const { state, alert } = applyPing(await this.load(), kind, now);
    await this.ctx.storage.put("state", state);
    return { state, alert };
  }

  async check(now, grace) {
    const { state, alert } = evaluate(await this.load(), now, grace);
    if (alert) await this.ctx.storage.put("state", state);
    return { state, alert };
  }

  async read() {
    return this.load();
  }
}

function monitor(env) {
  return env.MONITOR.get(env.MONITOR.idFromName("backup"));
}

// Constant-time token comparison over SHA-256 digests (equal length).
async function tokenMatches(given, expected) {
  if (!expected || !given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function sendAlert(env, alert, state) {
  if (!env.RESEND_API_KEY || !env.ALERT_TO || !env.ALERT_FROM) {
    console.log(JSON.stringify({ msg: "alert not sent: email not configured", alert }));
    return;
  }
  const name = env.MONITOR_NAME || "Pinove backup";
  const subject = {
    failure: `${name} failed`,
    overdue: `${name} is overdue`,
    recovered: `${name} recovered`,
  }[alert];
  const last = state.lastSuccess != null ? new Date(state.lastSuccess).toISOString() : "never";
  const text = `${subject}.\n\nLast successful run: ${last}\nStatus page: ${env.PUBLIC_URL || ""}\n`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.ALERT_FROM, to: env.ALERT_TO.split(",").map((s) => s.trim()), subject, text }),
  });
  console.log(JSON.stringify({ msg: "alert sent", alert, status: res.status }));
}

const securityHeaders = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "ping" && (parts.length === 2 || (parts.length === 3 && parts[2] === "fail"))) {
      if (request.method !== "GET" && request.method !== "POST" && request.method !== "HEAD") {
        return new Response("method not allowed\n", { status: 405 });
      }
      if (!(await tokenMatches(parts[1], env.PING_TOKEN))) {
        return new Response("not found\n", { status: 404 });
      }
      const kind = parts.length === 3 ? "fail" : "success";
      const { state, alert } = await monitor(env).ping(kind, Date.now());
      if (alert) ctx.waitUntil(sendAlert(env, alert, state));
      return new Response("ok\n", { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/status.json") {
      const state = await monitor(env).read();
      const now = Date.now();
      return Response.json({
        name: env.MONITOR_NAME || "Pinove backup",
        status: status(state, now, graceMs(env)),
        last_success: state.lastSuccess != null ? new Date(state.lastSuccess).toISOString() : null,
        last_failure: state.lastFailure != null ? new Date(state.lastFailure).toISOString() : null,
        grace_hours: graceMs(env) / HOUR,
      }, { headers: { ...securityHeaders, "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/") {
      const state = await monitor(env).read();
      const html = renderStatusPage(state, Date.now(), graceMs(env), env.MONITOR_NAME || "Pinove backup");
      return new Response(html, { headers: { ...securityHeaders, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }

    return new Response("not found\n", { status: 404 });
  },

  async scheduled(_event, env, ctx) {
    const { state, alert } = await monitor(env).check(Date.now(), graceMs(env));
    if (alert) ctx.waitUntil(sendAlert(env, alert, state));
  },
};
