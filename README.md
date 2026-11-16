# red-blue-button-map

Red Button, Blue Button: a map of how people answer the red button / blue button dilemma, by US county and state.

Live at **https://pressredorblue.com**.

```
site/      Static front end (HTML, CSS, JS). No build step. Served by Cloudflare (static assets).
worker/    Cloudflare Worker API + D1 database schema.
```

The site runs on mock data if `API_BASE` in `site/config.js` is empty.

## Run locally

Requires Node 18+.

```bash
# Front end
cd site
python3 -m http.server 8080          # open http://localhost:8080

# Backend (in another terminal)
cd worker
printf 'SALT="any-local-secret"\nALLOWED_ORIGIN="*"\n' > .dev.vars   # local only, git-ignored
npx wrangler d1 execute red-blue --local --file=schema.sql
npx wrangler dev --local --test-scheduled --port 8787
```

For local testing, set `API_BASE: "http://localhost:8787"` in `site/config.js` (and switch it back
before deploying). `.dev.vars` overrides `wrangler.toml` during local dev, so the local API accepts
requests from localhost while the live one only accepts pressredorblue.com. Trigger a totals rebuild locally with:

```bash
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

## Deploy

Both parts deploy with wrangler (`npx wrangler login` once).

```bash
cd worker && npx wrangler deploy     # API:  red-blue-api.<subdomain>.workers.dev
cd site   && npx wrangler deploy     # Site: pressredorblue.com (custom domain in site/wrangler.jsonc)
```

Before deploying `site/`, make sure `site/config.js` points at the live API (not localhost).

### First-time setup (already done for the live site)

1. `cd worker && npx wrangler d1 create red-blue`, then put the `database_id` in `wrangler.toml`.
2. `npx wrangler d1 execute red-blue --remote --file=schema.sql`
3. `openssl rand -hex 32 | npx wrangler secret put SALT`
4. `npx wrangler deploy` (the Worker), then set `API_BASE` in `site/config.js` to its URL.
5. Add the domain to Cloudflare, list it under `routes` in `site/wrangler.jsonc`, and set
   `SITE_URL` in `site/config.js` and the `og:` tags in `site/index.html` to it.
6. Set `ALLOWED_ORIGIN` in `worker/wrangler.toml` to the site address(es), comma-separated.

## How it works

- `POST /vote` checks the input, accepts requests only from `ALLOWED_ORIGIN`, rate-limits per
  network (20/hour by default), rejects repeat votes from the same browser, records the vote,
  and bumps that county's running total.
- A cron trigger copies the totals into a single cached JSON row every 5 minutes.
- `GET /results` returns that one row, so page views barely touch the database.
- State totals are summed in the browser from county totals.

## What's stored

- `votes`: county FIPS, choice, timestamp, and a salted hash of a random browser token.
- `tallies`: red and blue counts per county.
- `ip_hits`: salted hash of the voter's IP, kept for one hour for rate limiting, then deleted.

No names, emails, raw IPs, or exact locations. "Use my location" runs in the browser and only
the matched county is sent.

## Free tier capacity

Each vote writes about 9 rows (counting index entries and the rate-limit cleanup). On the
Cloudflare free plan (100,000 row writes per day) that is roughly 11,000 votes per day; past the
limit the API errors until midnight UTC rather than billing. The $5/month Workers Paid plan
covers about 5 million votes a month. Reads stay low because of the cached results row, and
static files are free.

## Ideas for later

- Cloudflare Turnstile on the vote button if bots show up
- A "why did you choose?" free-text field
- Share image: "My county is 47% red"
- Analytics and visualizations on GitHub Pages
- Raise `MIN_VOTES` once traffic grows
