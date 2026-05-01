// Postgres connection — works locally with any Postgres + on Neon/Railway/Vercel.
// On Vercel (serverless), we auto-rewrite Neon's direct URL to use its pooler
// host so per-invocation connections survive cold starts and brief idle gaps.

const { Pool } = require('pg');

const HAS_URL = !!process.env.DATABASE_URL;
if (!HAS_URL) {
  console.warn('⚠  DATABASE_URL not set — set it in .env or your hosting dashboard.');
}

const IS_SERVERLESS = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

// Detect local Postgres (no SSL) vs hosted (SSL required)
const isLocal = HAS_URL && /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);

// If we're on a serverless host and the URL is a Neon direct URL (no -pooler),
// rewrite the host to point at the pooler. This avoids new TCP handshakes
// every cold start and the "Connection terminated due to connection timeout"
// errors that come with auto-suspended Neon computes.
function ensurePooled(url) {
  if (!url) return url;
  if (!/neon\.tech/.test(url)) return url;          // not Neon, leave alone
  if (/-pooler\./.test(url)) return url;            // already pooled
  return url.replace(/@(ep-[^.]+)\./, '@$1-pooler.');
}

const connectionString = IS_SERVERLESS ? ensurePooled(process.env.DATABASE_URL) : process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  // Serverless: 1 conn per Lambda is fine and avoids exhausting Neon limits.
  // Long-running (Railway/local): allow a small pool.
  max: IS_SERVERLESS ? 1 : 10,
  idleTimeoutMillis: IS_SERVERLESS ? 0 : 30_000,
  connectionTimeoutMillis: 15_000,
  allowExitOnIdle: true,
});

// Surface pool errors instead of crashing the process (important for serverless)
pool.on('error', (err) => {
  console.error('PG pool error:', err.message);
});

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS projects (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS phases (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    budget REAL NOT NULL,
    lots INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS change_orders (
    id SERIAL PRIMARY KEY,
    phase_id INTEGER NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    scope TEXT,
    vendor TEXT,
    cost REAL NOT NULL,
    status TEXT DEFAULT 'draft',
    submitted_by TEXT,
    date TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS co_history (
    id SERIAL PRIMARY KEY,
    category TEXT NOT NULL,
    description TEXT,
    total_cost REAL,
    lots INTEGER,
    year INTEGER
  );
`;

// Run the schema once on module load. Idempotent (CREATE TABLE IF NOT EXISTS).
// If DATABASE_URL is missing, we don't even try — fail clearly per request.
const ready = HAS_URL
  ? pool.query(SCHEMA).catch(err => {
      console.error('Schema init failed:', err.message);
      throw err;
    })
  : Promise.reject(new Error('DATABASE_URL is not configured on this server'));

// Suppress "unhandled rejection" if no one awaits ready before a route fires
ready.catch(() => {});

// Retry once on transient connection failures (common on Neon cold start
// while compute is waking up from auto-suspend).
async function query(text, params) {
  try {
    await ready;
    return await pool.query(text, params);
  } catch (e) {
    const transient = /timeout|terminat|ECONN|EAI_AGAIN|reset/i.test(e.message);
    if (!transient) throw e;
    console.warn('Retrying after transient DB error:', e.message);
    return pool.query(text, params);
  }
}

module.exports = { pool, query, ready };
