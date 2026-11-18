// Keshi wallet counter — a Cloudflare Worker that receives the anonymous signal sent by Keshi wallets whose
// user ticked "Count my wallet" (Keshi 1.0.6, src/core/stats.ts), and adds it to totals per day.
//
// What it keeps: totals per UTC day (see METRICS below), in a D1 database. Nothing else.
// What it never reads or keeps: the IP address, the user agent, any identifier, any time more precise than the day.
// A signal holds no address, no balance and no identifier, so there is nothing here to link to a wallet.
//
// Bindings (Cloudflare dashboard > Workers > keshi-stats > Settings):
//   DB          D1 database (any name, bound as "DB")
//   STATS_KEY   secret: the password to read the totals (GET /v1/stats)
//   ALLOW_FIREFOX_ORIGIN   optional, "1" to accept the Firefox add-on
//   EXTRA_ORIGINS          optional, comma-separated origins to accept as well (the phone app's, for example)

const ALLOWED_ORIGINS = new Set([
  "chrome-extension://mmjkdbdkgikbhbgcmpaaahhjhmdknpnb", // Keshi on the Chrome Web Store
]);
const BROWSERS = new Set(["chrome", "firefox", "android", "web"]);

const json = (body, status, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const today = () => new Date().toISOString().slice(0, 10);
const bit = (x) => (x === 1 ? 1 : 0);
const upTo = (x, max) => (Number.isInteger(x) && x > 0 ? Math.min(x, max) : 0);

/** A signal as Keshi sends it, or null: anything else is dropped, never stored. */
function readSignal(text) {
  if (typeof text !== "string" || text.length > 300) return null;
  let s;
  try {
    s = JSON.parse(text);
  } catch {
    return null;
  }
  if (!s || typeof s !== "object" || s.s !== 1 || s.d !== 1) return null;
  if (typeof s.v !== "string" || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s.v) || !BROWSERS.has(s.b)) return null;
  return { v: s.v, b: s.b, w: bit(s.w), m: bit(s.m), n: bit(s.n), wallets: upTo(s.wallets, 50), created: upTo(s.created, 20), restored: upTo(s.restored, 20) };
}

/** The totals one signal adds to, for its day. */
function METRICS(s) {
  return [
    ["active", 1], // wallets (Keshi installs) seen that day
    ["week_first", s.w], // of which: first time that ISO week  -> summed over a week = weekly active
    ["month_first", s.m], // of which: first time that month     -> summed over a month = monthly active
    ["new", s.n], // of which: first signal ever                 -> summed over all days = installs that agreed to be counted
    ["wallets", s.wallets], // wallets held by those seen that day
    ["created", s.created], // wallets created since each one's previous signal
    ["restored", s.restored], // wallets restored since each one's previous signal
    [`version:${s.v}`, 1],
    [`browser:${s.b}`, 1],
  ].filter(([, n]) => n > 0);
}

const SCHEMA = "CREATE TABLE IF NOT EXISTS counts (day TEXT NOT NULL, metric TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, metric))";

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") ?? "";
    const extra = new Set(String(env.EXTRA_ORIGINS ?? "").split(",").map((x) => x.trim()).filter(Boolean));
    const originOk = ALLOWED_ORIGINS.has(origin) || extra.has(origin) || (!!env.ALLOW_FIREFOX_ORIGIN && /^moz-extension:\/\/[a-f0-9-]+$/.test(origin));
    const cors = { "access-control-allow-origin": originOk ? origin : "null", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600" };

    if (url.pathname === "/v1/signal") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (request.method !== "POST") return json({ message: "Method not allowed" }, 405, cors);
      if (!originOk) return json({ message: "Forbidden" }, 403, cors);
      // A signal is under 150 bytes. A larger body is refused on its announced size, and otherwise read no further than 1 kB.
      if (Number(request.headers.get("content-length") ?? "0") > 1024) return json({ message: "Too large" }, 413, cors);
      const text = await readUpTo(request, 1024);
      if (text === null) return json({ message: "Too large" }, 413, cors);
      const signal = readSignal(text);
      if (!signal) return json({ message: "Not a Keshi signal" }, 400, cors);
      const day = today();
      await env.DB.prepare(SCHEMA).run();
      const add = env.DB.prepare("INSERT INTO counts (day, metric, n) VALUES (?1, ?2, ?3) ON CONFLICT (day, metric) DO UPDATE SET n = n + ?3");
      await env.DB.batch(METRICS(signal).map(([metric, n]) => add.bind(day, metric, n)));
      return json({ ok: true }, 200, cors);
    }

    // The totals, for Keshi's own dashboard (the Keshi Revenue tool): GET /v1/stats?days=30 with
    // "authorization: Bearer <STATS_KEY>". The key is the only gate; a browser extension may ask (its page must be
    // allowed to read the answer), a website may not.
    if (url.pathname === "/v1/stats" && (request.method === "GET" || request.method === "OPTIONS")) {
      const reader = /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ? { "access-control-allow-origin": origin, "access-control-allow-headers": "authorization", "access-control-allow-methods": "GET, OPTIONS", "access-control-max-age": "600", vary: "origin" } : {};
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: reader });
      const key = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (!env.STATS_KEY || key.length !== env.STATS_KEY.length || !sameText(key, env.STATS_KEY)) return json({ message: "Forbidden" }, 403, reader);
      const days = Math.min(400, Math.max(1, Number(url.searchParams.get("days")) || 30));
      await env.DB.prepare(SCHEMA).run();
      const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
      const rows = (await env.DB.prepare("SELECT day, metric, n FROM counts WHERE day >= ?1 ORDER BY day").bind(since).all()).results ?? [];
      const totals = (await env.DB.prepare("SELECT metric, SUM(n) AS n FROM counts WHERE metric IN ('new', 'created', 'restored') GROUP BY metric").all()).results ?? [];
      const byDay = {};
      for (const r of rows) (byDay[r.day] ??= {})[r.metric] = r.n;
      const all = Object.fromEntries(totals.map((r) => [r.metric, r.n]));
      const month = today().slice(0, 7);
      const sum = (metric, keep) => rows.filter((r) => r.metric === metric && keep(r.day)).reduce((a, r) => a + r.n, 0);
      const weekStart = mondayOf(today());
      return json(
        {
          today: byDay[today()] ?? {},
          activeThisWeek: sum("week_first", (d) => d >= weekStart),
          activeThisMonth: sum("month_first", (d) => d.startsWith(month)),
          installsCountedEver: all.new ?? 0,
          walletsCreatedEver: all.created ?? 0,
          walletsRestoredEver: all.restored ?? 0,
          days: byDay,
        },
        200,
        reader,
      );
    }
    return json({ message: "Not found" }, 404, cors);
  },
};

/** The body as text, or null as soon as it passes `max` bytes: the rest is never read. */
async function readUpTo(request, max) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) (all.set(p, at), (at += p.byteLength));
  return new TextDecoder().decode(all);
}

/** The Monday (UTC) of the ISO week a day is in. */
function mondayOf(day) {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() || 7) - 1));
  return d.toISOString().slice(0, 10);
}

/** Compares two texts of the same length without stopping at the first difference. */
function sameText(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Cloudflare reads only `fetch`; the three helpers ride along on the same object for Keshi's tests.
worker.readSignal = readSignal;
worker.METRICS = METRICS;
worker.mondayOf = mondayOf;
export default worker;
