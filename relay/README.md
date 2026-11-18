# Keshi LI.FI relay (Cloudflare Worker)

Keeps the LI.FI API key out of the extension. The extension calls
`https://lifi.keshiwallet.com/v1/quote` and `/v1/status`; this worker adds the
key and forwards to `li.quest`. It is read-only: quotes and statuses only.

## Deploy (Cloudflare dashboard, no command line)

1. Workers & Pages → Create → Create Worker → name it `keshi-lifi-relay` → Deploy.
2. Edit code → replace everything with `worker.js` → Deploy.
3. Settings → Variables and Secrets → add:
   - `LIFI_API_KEY` (type **Secret**): the key from portal.li.fi
   - `INTEGRATOR` (text): `keshi`
   - `FEE` (text): `0.005`  (0.5 %)
4. Settings → Domains & Routes → Add → Custom domain → `lifi.keshiwallet.com`.
5. `npm run release` builds for the relay by default (`lifi.keshiwallet.com`); `KESHI_LIFI_DIRECT=1` builds a
   variant that talks to li.quest itself with a key from `lifi.key`.

After the key is in Cloudflare, revoke the old key in portal.li.fi and create a new one for the worker only.

## Where the key lives

Only in the Worker's secrets. The default (relay) build embeds nothing. A direct
build (`KESHI_LIFI_DIRECT=1`) reads it from `lifi.key` (ignored by git) or
`KESHI_LIFI_KEY`. `npm run release` refuses a key in `fees.config.json`.


# Keshi wallet counter (Cloudflare Worker) — since 1.0.6

`stats-worker.js` receives the anonymous signal of wallets whose user ticked "Count my wallet", and keeps
totals per day. It stores no address, no IP, no identifier. The extension works the same whether this
worker exists or not: until it is deployed, signals simply go nowhere.

## Deploy (Cloudflare dashboard, no command line)

1. Storage & Databases → D1 → Create database → name it `keshi-stats`.
2. Workers & Pages → Create → Create Worker → name it `keshi-stats` → Deploy.
3. Edit code → replace everything with `stats-worker.js` → Deploy.
4. Settings → Bindings → Add → D1 database → variable name `DB` → database `keshi-stats`.
5. Settings → Variables and Secrets → add `STATS_KEY` (type **Secret**): a long password of your choice.
6. Settings → Domains & Routes → Add → Custom domain → `stats.keshiwallet.com`.
7. Settings → Observability: leave Workers Logs **off**, so that no request (and no IP address) is kept.
8. On the `keshiwallet.com` zone: Security → WAF → Rate limiting rules → Create: hostname equals `stats.keshiwallet.com`,
   more than 5 requests per 10 seconds from one IP → Block (on the Free plan the window is 10 seconds and there is one
   rule only: if it already protects lifi.keshiwallet.com, add `stats.keshiwallet.com` to that rule's hostnames).
   The worker checks the extension's Origin, but a script can forge it and inflate the totals: this rule bounds that.

The totals are statistics, not a security control: someone determined can still add false signals within that limit.
Read them as an order of magnitude, next to the Chrome Web Store's own install figures.

Optional variables: `ALLOW_FIREFOX_ORIGIN` = `1` once the Firefox add-on is published; `EXTRA_ORIGINS` for the phone app's origin.

## Read the totals

`GET https://stats.keshiwallet.com/v1/stats?days=30` with the header `authorization: Bearer <STATS_KEY>`:

- `today.active`: wallets (installs) seen today
- `activeThisWeek`, `activeThisMonth`
- `installsCountedEver`: installs that agreed to be counted
- `walletsCreatedEver`, `walletsRestoredEver`
- `days`: every total per day, with `version:<x>` and `browser:<x>` splits

These count only the users who ticked the box: they are a floor, not the number of installs.
