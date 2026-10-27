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
