# pinove-healthcheck

Dead-man's switch and public status page for Pinove's daily encrypted backup.
It runs as a Cloudflare Worker with one Durable Object (no database to
create) and deploys from this repository.

- `GET /`: public status page (Operational, Last run failed, Overdue).
- `GET /status.json`: the same as JSON.
- `GET|POST /ping/<token>`: record a successful backup.
- `GET|POST /ping/<token>/fail`: record a failed backup.
- Every 15 minutes a cron check alerts when no success has arrived for
  `GRACE_HOURS` (26 by default). Alerts and recoveries go out by email through
  Resend, one per incident.

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
   `status.pinove.com` (it matches `PUBLIC_URL` in `wrangler.jsonc`).
4. On the Pinove host, add this line to `/etc/pinove/restic.env`:

   ```sh
   PINOVE_BACKUP_PING_URL=https://status.pinove.com/ping/<PING_TOKEN>
   ```

   `deploy/scripts/backup.sh` pings it on success and calls `<url>/fail` on failure.

## Test

```sh
npm test
```
