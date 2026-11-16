-- One row per vote. voter_hash is a salted hash of a random browser token.
CREATE TABLE IF NOT EXISTS votes (
  id          INTEGER PRIMARY KEY,
  county_fips TEXT    NOT NULL,
  choice      TEXT    NOT NULL CHECK (choice IN ('red', 'blue')),
  voter_hash  TEXT    NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

-- Running totals per county, updated on each vote.
CREATE TABLE IF NOT EXISTS tallies (
  county_fips TEXT PRIMARY KEY,
  red         INTEGER NOT NULL DEFAULT 0,
  blue        INTEGER NOT NULL DEFAULT 0
);

-- Short-lived records for rate limiting. Deleted after an hour.
CREATE TABLE IF NOT EXISTS ip_hits (
  ip_hash    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ip_hits_hash_time ON ip_hits (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_ip_hits_time ON ip_hits (created_at);

-- The JSON served by GET /results, rebuilt by the cron trigger.
CREATE TABLE IF NOT EXISTS results_cache (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  json       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
