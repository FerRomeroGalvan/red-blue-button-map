// Red Button, Blue Button API
//   POST /vote     { county_fips, choice: "red" | "blue", token }
//   GET  /results  cached county totals: { updated, counties: { fips: [red, blue] } }
// A cron trigger rebuilds the cached totals every few minutes, so page views
// read one row instead of the whole tally table.

const CHOICES = new Set(["red", "blue"]);
const HOUR = 3600 * 1000;

export default {
  async fetch(req, env) {
    // ALLOWED_ORIGIN is "*" or a comma-separated list of site addresses.
    const allowed = (env.ALLOWED_ORIGIN || "*").split(",").map((o) => o.trim());
    const origin = req.headers.get("Origin");
    const originOk = allowed.includes("*") || allowed.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes("*") ? "*" : originOk ? origin : allowed[0],
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      Vary: "Origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    const { pathname } = new URL(req.url);
    // Votes only from our own pages (browsers always send Origin on these requests).
    if (req.method === "POST" && !originOk) return json({ error: "Forbidden" }, 403, cors);
    try {
      if (pathname === "/results" && req.method === "GET") return await results(env, cors);
      if (pathname === "/vote" && req.method === "POST") return await vote(req, env, cors);
      return json({ error: "Not found" }, 404, cors);
    } catch (err) {
      console.error(err);
      return json({ error: "Server error" }, 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(rebuild(env));
  },
};

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json" },
  });
}

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function vote(req, env, cors) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Bad request" }, 400, cors);
  }
  const { county_fips, choice, token } = body || {};
  if (
    typeof county_fips !== "string" || !/^\d{5}$/.test(county_fips) ||
    !CHOICES.has(choice) ||
    typeof token !== "string" || token.length < 16 || token.length > 100
  ) {
    return json({ error: "Bad request" }, 400, cors);
  }

  const now = Date.now();
  const salt = env.SALT || "";
  const ipHash = await sha256(`${salt}|ip|${req.headers.get("CF-Connecting-IP") || ""}`);
  const voterHash = await sha256(`${salt}|voter|${token}`);

  // Loose rate limit per network. Shared networks (campuses, offices) may need a higher value.
  const limit = Number(env.MAX_VOTES_PER_IP_HOUR || 20);
  const { n } = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM ip_hits WHERE ip_hash = ? AND created_at > ?")
    .bind(ipHash, now - HOUR)
    .first();
  if (n >= limit) {
    return json({ error: "Too many votes from this network. Try again later." }, 429, cors);
  }

  const inserted = await env.DB
    .prepare("INSERT OR IGNORE INTO votes (county_fips, choice, voter_hash, created_at) VALUES (?, ?, ?, ?)")
    .bind(county_fips, choice, voterHash, now)
    .run();
  if (inserted.meta.changes === 0) {
    return json({ error: "You've already voted from this browser." }, 409, cors);
  }

  const red = choice === "red" ? 1 : 0;
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO tallies (county_fips, red, blue) VALUES (?, ?, ?)
         ON CONFLICT(county_fips) DO UPDATE SET red = red + excluded.red, blue = blue + excluded.blue`
      )
      .bind(county_fips, red, 1 - red),
    env.DB.prepare("INSERT INTO ip_hits (ip_hash, created_at) VALUES (?, ?)").bind(ipHash, now),
  ]);

  return json({ ok: true }, 200, cors);
}

async function results(env, cors) {
  const row = await env.DB.prepare("SELECT json FROM results_cache WHERE id = 1").first();
  const body = row ? row.json : JSON.stringify({ updated: null, counties: {} });
  return new Response(body, {
    headers: { ...cors, "content-type": "application/json", "cache-control": "public, max-age=60" },
  });
}

async function rebuild(env) {
  const { results: rows } = await env.DB.prepare("SELECT county_fips, red, blue FROM tallies").all();
  const counties = {};
  for (const r of rows) counties[r.county_fips] = [r.red, r.blue];
  const payload = JSON.stringify({ updated: new Date().toISOString(), counties });

  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO results_cache (id, json, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`
      )
      .bind(payload, Date.now()),
    // Rate-limit records are only needed for an hour. Drop them after that.
    env.DB.prepare("DELETE FROM ip_hits WHERE created_at < ?").bind(Date.now() - HOUR),
  ]);
}
