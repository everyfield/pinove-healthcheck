import { DurableObject } from "cloudflare:workers";
import { COMPONENTS, applyObservations, initialStatusState, observationsFrom, overall } from "./status.js";
import { renderStatusPage } from "./page.js";

// One Durable Object holds all state, so checks and page reads are
// serialized and never lose an update.
export class Monitor extends DurableObject {
  async statusState() {
    return (await this.ctx.storage.get("status")) ?? initialStatusState();
  }

  /** Records one check round; returns the component alerts. */
  async check(probes, now) {
    const r = applyObservations(await this.statusState(), observationsFrom(probes), now);
    r.state.lastCheck = now;
    await this.ctx.storage.put("status", r.state);
    // Drop state left over from the removed backup monitor.
    await this.ctx.storage.delete("state");
    return r.alerts;
  }

  async read() {
    return await this.statusState();
  }
}

// The object keeps its original name so the uptime history is preserved.
function monitor(env) {
  return env.MONITOR.get(env.MONITOR.idFromName("backup"));
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

// Only outages are emailed; recoveries show on the status page only.
function componentAlertEmail(env, a) {
  const name = COMPONENTS.find((c) => c.id === a.component)?.name ?? a.component;
  if (a.kind !== "down") return Promise.resolve();
  const subject = `Pinove ${name}: ${a.status}`;
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
  return monitor(env).check({ websiteOk, consoleOk, apiStatus }, Date.now());
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/status.json") {
      const status = await monitor(env).read();
      const components = Object.fromEntries(COMPONENTS.map(({ id }) => [id, status.components[id]?.status ?? "unknown"]));
      return Response.json({
        status: overall(status),
        components,
        last_check: status.lastCheck ? new Date(status.lastCheck).toISOString() : null,
      }, { headers: { ...securityHeaders, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
    }

    if (url.pathname === "/") {
      let status = await monitor(env).read();
      // First visit after deploy: run a check so the page is not empty.
      if (!status.lastCheck) {
        await runChecks(env);
        status = await monitor(env).read();
      }
      return new Response(renderStatusPage(status, Date.now()), {
        headers: { ...securityHeaders, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    return new Response("not found\n", { status: 404 });
  },

  async scheduled(_event, env, ctx) {
    for (const a of await runChecks(env)) ctx.waitUntil(componentAlertEmail(env, a));
  },
};
