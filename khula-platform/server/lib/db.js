// Data layer facade. Every function here is async and returns a Promise,
// regardless of which backend is active — `await`ing a plain (non-Promise)
// value just returns it immediately, so this works whether the underlying
// implementation is synchronous (db.file.js) or genuinely async (db.postgres.js).
//
// Backend selection: set DATABASE_URL in .env to switch to Postgres. Leave
// it unset for the zero-setup JSON file store. Nothing outside this file
// needs to know or care which one is active.

const usingPostgres = Boolean(process.env.DATABASE_URL);
const impl = usingPostgres ? require('./db.postgres') : require('./db.file');

if (usingPostgres) {
  console.log('[db] Using Postgres backend (DATABASE_URL is set).');
} else {
  console.log('[db] Using local JSON file backend (set DATABASE_URL to switch to Postgres).');
}

async function readAll(collection) {
  return impl.readAll(collection);
}

async function writeAll(collection, records) {
  return impl.writeAll(collection, records);
}

async function insert(collection, record) {
  return impl.insert(collection, record);
}

async function find(collection, predicate) {
  return impl.find(collection, predicate);
}

async function filter(collection, predicate) {
  return impl.filter(collection, predicate);
}

async function update(collection, predicate, updater) {
  return impl.update(collection, predicate, updater);
}

module.exports = { readAll, writeAll, insert, find, filter, update, usingPostgres };
