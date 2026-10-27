// Keshi LI.FI relay — a Cloudflare Worker that forwards quote and status
// requests from the Keshi extension to LI.FI, adding Keshi's API key on the
// way. The key never leaves Cloudflare. It signs nothing and moves no money.
//
// Only two read-only paths are allowed. The Origin check keeps browsers other
// than the Keshi extension out; a script can still forge it, so the relay is
// best seen as a public, read-only, rate-limited door to two LI.FI endpoints.
// For a hard quota, add a Cloudflare Rate Limiting rule on this route.

const ALLOWED_PATHS = new Set(["/v1/quote", "/v1/status"]);
const ALLOWED_ORIGINS = new Set([
  "chrome-extension://mmjkdbdkgikbhbgcmpaaahhjhmdknpnb", // Keshi on the Chrome Web Store
]);
const PER_MINUTE = 30; // requests per minute from one IP

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") ?? "";
    const originOk = ALLOWED_ORIGINS.has(origin) || (!!env.ALLOW_FIREFOX_ORIGIN && /^moz-extension:\/\/[a-f0-9-]+$/.test(origin));
    const cors = {
      "access-control-allow-origin": originOk ? origin : "null",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "accept, content-type",
      "access-control-max-age": "600",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return json({ message: "Method not allowed" }, 405, cors);
    if (!originOk) return json({ message: "Forbidden" }, 403, cors);
    if (!ALLOWED_PATHS.has(url.pathname)) return json({ message: "Not found" }, 404, cors);

    // A gentle per-IP allowance, kept in Cloudflare's cache: no database needed.
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const bucket = `https://ratelimit.keshi.invalid/${ip}/${Math.floor(Date.now() / 60_000)}`;
    const cache = caches.default;
    const seen = Number((await (await cache.match(bucket))?.text()) ?? "0") + 1;
    await cache.put(bucket, new Response(String(seen), { headers: { "cache-control": "max-age=60" } }));
    if (seen > PER_MINUTE) return json({ message: "Too many requests. Try again in a minute." }, 429, cors);

    // Forward exactly the query the extension sent, nothing more.
    const target = new URL("https://li.quest" + url.pathname);
    for (const [k, v] of url.searchParams) target.searchParams.set(k, v);
    if (url.pathname === "/v1/quote") {
      // Keshi's integrator name and fee are fixed here, so a copied request cannot redirect the fee.
      // The fee applies to wPRL purchases only, as in the extension; the small ETH-for-fees leg carries none.
      target.searchParams.set("integrator", env.INTEGRATOR ?? "keshi");
      target.searchParams.delete("fee");
      const wprl = (url.searchParams.get("toToken") ?? "").toLowerCase() === "0x07696dcab55e62cfef953666b29fe1970518cb00";
      if (env.FEE && wprl) target.searchParams.set("fee", env.FEE);
    }
    const upstream = await fetch(target.toString(), {
      headers: { accept: "application/json", "x-lifi-api-key": env.LIFI_API_KEY },
      redirect: "error", // the key must never follow a redirect elsewhere
      cf: { cacheTtl: 0 },
    });
    const body = await upstream.text();
    return new Response(body, { status: upstream.status, headers: { ...cors, "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
  },
};

const json = (o, status, headers) => new Response(JSON.stringify(o), { status, headers: { ...headers, "content-type": "application/json" } });
