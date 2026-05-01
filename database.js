// Postgres connection — works locally with any Postgres + on Neon/Railway/Vercel
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('⚠  DATABASE_URL not set — set it in .env or your hosting dashboard.');
}

// Detect local Postgres (no SSL) vs hosted (SSL required)
const isLocal = process.env.DATABASE_URL && /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
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
// Other queries await this promise to avoid race conditions on cold starts.
const ready = pool.query(SCHEMA).catch(err => {
  console.error('Schema init failed:', err.message);
  throw err;
});

async function query(text, params) {
  await ready;
  return pool.query(text, params);
}

module.exports = { pool, query, ready };
