// Postgres-backed store. Selected automatically when DATABASE_URL is set
// (see db.js). Same insert/find/update/filter/readAll/writeAll interface as
// db.file.js so nothing outside this file needs to know which backend is
// active — the routes just `await db.insert(...)` either way.
//
// Design: rather than a hand-rolled schema per collection (applications,
// conversations, admins), records are stored as JSONB blobs in one generic
// `store` table, keyed by collection name. find/filter run the same JS
// predicate functions the file backend uses, against rows already pulled
// from Postgres for that collection. This keeps 100% behavioural parity
// with the file backend at MVP scale; if a collection grows large enough
// that "SELECT everything in this collection" stops being fine, that's the
// signal to give it a real dedicated table and indexed columns.

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Most managed Postgres providers (Render, Railway, RDS) require SSL but
  // use certs that Node's default chain won't validate. Set PGSSL=strict
  // once you've got proper certs configured; defaults to permissive so this
  // works out of the box against Render/Railway managed Postgres.
  ssl: process.env.PGSSL === 'strict' ? true : { rejectUnauthorized: false },
});

let schemaReady = null;

function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS store (
        row_id SERIAL PRIMARY KEY,
        collection TEXT NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS store_collection_idx ON store (collection);
    `);
  }
  return schemaReady;
}

async function selectRows(collection) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT row_id, data FROM store WHERE collection = $1 ORDER BY row_id', [collection]);
  return rows;
}

async function readAll(collection) {
  const rows = await selectRows(collection);
  return rows.map((r) => r.data);
}

async function writeAll(collection, records) {
  await ensureSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM store WHERE collection = $1', [collection]);
    for (const record of records) {
      await client.query('INSERT INTO store (collection, data) VALUES ($1, $2)', [collection, record]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function insert(collection, record) {
  await ensureSchema();
  await pool.query('INSERT INTO store (collection, data) VALUES ($1, $2)', [collection, record]);
  return record;
}

async function find(collection, predicate) {
  const rows = await selectRows(collection);
  const match = rows.find((r) => predicate(r.data));
  return match ? match.data : null;
}

async function filter(collection, predicate) {
  const rows = await selectRows(collection);
  return rows.filter((r) => predicate(r.data)).map((r) => r.data);
}

async function update(collection, predicate, updater) {
  const rows = await selectRows(collection);
  const match = rows.find((r) => predicate(r.data));
  if (!match) return null;
  const updated = updater({ ...match.data });
  await pool.query('UPDATE store SET data = $1 WHERE row_id = $2', [updated, match.row_id]);
  return updated;
}

module.exports = { readAll, writeAll, insert, update, find, filter };
