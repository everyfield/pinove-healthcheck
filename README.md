# pinove-healthcheck

Public status page for Pinove (health.pinove.com) and the dead-man's switch
for its daily encrypted backup. It runs as a Cloudflare Worker with one
Durable Object (no database to create) and deploys from this repository.

Every 5 minutes it checks the website, the console, and the API's
`GET /v1/status` (API, database and build workers), plus the backup. A
component must fail two checks in a row before it is shown as down. The page
shows each component's state, 90 days of daily uptime and recent incidents.
Outages are emailed through Resend, once per incident. Recoveries are shown
on the page only; no email is sent.

- `GET /`: public status page.
- `GET /status.json`: the same as JSON.
- `GET|POST /ping/<token>`: record a successful backup.
- `GET|POST /ping/<token>/fail`: record a failed backup.
- The backup counts as down when no success has arrived for
  `GRACE_HOURS` (26 by default). Failures go out by email through Resend, one
  per incident.

The token in the ping URL is a secret; the status page and JSON never show it.

## Deploy (once)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository**,
   then choose `everyfield/pinove-healthcheck`. Build command: none. Deploy
   command: `npx wrangler deploy`. Every push to `main` redeploys.
2. In the Worker's **Settings → Variables and Secrets**, add these as
   **Secret** values:
   - `PING_TOKEN`: output of `openssl rand -hex 32`
   - `RESEND_API_KEY`: a Resend API key with sending access
   - `ALERT_TO`: where alerts go (comma-separated)
3. Optional: **Settings → Domains & Routes** → add the custom domain
   `health.pinove.com` (it matches `PUBLIC_URL` in `wrangler.jsonc`).
4. On the Pinove host, add this line to `/etc/pinove/restic.env`:

   ```sh
   PINOVE_BACKUP_PING_URL=https://health.pinove.com/ping/<PING_TOKEN>
   ```

   `deploy/scripts/backup.sh` pings it on success and calls `<url>/fail` on failure.

## Test

```sh
npm test
```
