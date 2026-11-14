import { DurableObject } from "cloudflare:workers";
import { applyPing, evaluate, initialState, status as backupStatus } from "./monitor.js";
import { COMPONENTS, applyObservations, initialStatusState, observationsFrom, overall } from "./status.js";
import { renderStatusPage } from "./page.js";

const HOUR = 60 * 60 * 1000;

function graceMs(env) {
  const h = Number(env.GRACE_HOURS ?? 26);
  return (Number.isFinite(h) && h > 0 ? h : 26) * HOUR;
}

// One Durable Object holds all state, so pings, checks and page reads are
// serialized and never lose an update.
export class Monitor extends DurableObject {
  async backup() {
    return (await this.ctx.storage.get("state")) ?? initialState();
  }

  async statusState() {
    return (await this.ctx.storage.get("status")) ?? initialStatusState();
  }

  async ping(kind, now) {
    const { state, alert } = applyPing(await this.backup(), kind, now);
    await this.ctx.storage.put("state", state);
    return { state, alert };
  }

  /** Records one check round; returns backup and component alerts. */
  async check(probes, now, grace) {
    const b = evaluate(await this.backup(), now, grace);
    if (b.alert) await this.ctx.storage.put("state", b.state);
    const obs = observationsFrom({ ...probes, backupStatus: backupStatus(b.state, now, grace) });
    const r = applyObservations(await this.statusState(), obs, now);
    r.state.lastCheck = now;
    await this.ctx.storage.put("status", r.state);
    return { backupAlert: b.alert, backupState: b.state, componentAlerts: r.alerts };
  }

  async read() {
    return { backup: await this.backup(), status: await this.statusState() };
  }
}

function monitor(env) {
  return env.MONITOR.get(env.MONITOR.idFromName("backup"));
}

async function tokenMatches(given, expected) {
  if (!expected || !given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function probeOK(url) {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10000), headers: { "User-Agent": "pinove-healthcheck" } });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function probeAPI(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { "User-Agent": "pinove-healthcheck" } });
    if (res.status !== 200) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function sendEmail(env, subject, text) {
  if (!env.RESEND_API_KEY || !env.ALERT_TO || !env.ALERT_FROM) {
    console.log(JSON.stringify({ msg: "alert not sent: email not configured", subject }));
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.ALERT_FROM, to: env.ALERT_TO.split(",").map((s) => s.trim()), subject, text }),
  });
  console.log(JSON.stringify({ msg: "alert sent", subject, status: res.status }));
}

function backupAlertEmail(env, alert, state) {
  const subject = { failure: "Pinove backup failed", overdue: "Pinove backup is overdue", recovered: "Pinove backup recovered" }[alert];
  const last = state.lastSuccess != null ? new Date(state.lastSuccess).toISOString() : "never";
  return sendEmail(env, subject, `${subject}.\n\nLast successful run: ${last}\nStatus page: ${env.PUBLIC_URL || ""}\n`);
}

function componentAlertEmail(env, a) {
  const name = COMPONENTS.find((c) => c.id === a.component)?.name ?? a.component;
  const subject = a.kind === "down" ? `Pinove ${name}: ${a.status}` : `Pinove ${name} recovered`;
  return sendEmail(env, subject, `${subject}.\n\nStatus page: ${env.PUBLIC_URL || ""}\n`);
}

const securityHeaders = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

async function runChecks(env) {
  const [websiteOk, consoleOk, apiStatus] = await Promise.all([
    probeOK(env.WEBSITE_URL || "https://pinove.com/"),
    probeOK(env.CONSOLE_URL || "https://console.pinove.com/login"),
    probeAPI(env.API_STATUS_URL || "https://api.pinove.com/v1/status"),
  ]);
  return monitor(env).check({ websiteOk, consoleOk, apiStatus }, Date.now(), graceMs(env));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "ping" && (parts.length === 2 || (parts.length === 3 && parts[2] === "fail"))) {
      if (!["GET", "POST", "HEAD"].includes(request.method)) return new Response("method not allowed\n", { status: 405 });
      if (!(await tokenMatches(parts[1], env.PING_TOKEN))) return new Response("not found\n", { status: 404 });
      const { state, alert } = await monitor(env).ping(parts.length === 3 ? "fail" : "success", Date.now());
      if (alert) ctx.waitUntil(backupAlertEmail(env, alert, state));
      return new Response("ok\n", { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/status.json") {
      const { backup, status } = await monitor(env).read();
      const now = Date.now();
      const components = Object.fromEntries(COMPONENTS.map(({ id }) => [id, status.components[id]?.status ?? "unknown"]));
      return Response.json({
        status: overall(status),
        components,
        backup: {
          status: backupStatus(backup, now, graceMs(env)),
          last_success: backup.lastSuccess != null ? new Date(backup.lastSuccess).toISOString() : null,
          last_failure: backup.lastFailure != null ? new Date(backup.lastFailure).toISOString() : null,
        },
        last_check: status.lastCheck ? new Date(status.lastCheck).toISOString() : null,
      }, { headers: { ...securityHeaders, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
    }

    if (url.pathname === "/") {
      let { backup, status } = await monitor(env).read();
      // First visit after deploy: run a check so the page is not empty.
      if (!status.lastCheck) {
        await runChecks(env);
        ({ backup, status } = await monitor(env).read());
      }
      return new Response(renderStatusPage(status, backup, Date.now()), {
        headers: { ...securityHeaders, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    return new Response("not found\n", { status: 404 });
  },

  async scheduled(_event, env, ctx) {
    const r = await runChecks(env);
    if (r.backupAlert) ctx.waitUntil(backupAlertEmail(env, r.backupAlert, r.backupState));
    for (const a of r.componentAlerts) ctx.waitUntil(componentAlertEmail(env, a));
  },
};
