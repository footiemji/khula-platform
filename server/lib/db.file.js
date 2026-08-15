// Lightweight file-backed JSON store — the zero-setup default backend.
// Selected automatically when DATABASE_URL is not set (see db.js). Every
// function here is synchronous; the db.js facade wraps it so callers always
// get a consistent async interface regardless of which backend is active.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Derives the file path for a collection name rather than requiring every
// new collection to be registered in a fixed map — that map went stale
// once (a new collection was added elsewhere without an entry here, which
// crashed at runtime), so this is deliberately self-updating. Collection
// names are restricted to safe characters to prevent path traversal.
function fileFor(name) {
  if (!/^[a-z_]+$/.test(name)) {
    throw new Error(`Invalid collection name: ${name}`);
  }
  return path.join(DATA_DIR, `${name}.json`);
}

function ensureFile(file) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '[]', 'utf8');
}

function readAll(name) {
  const file = fileFor(name);
  ensureFile(file);
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw || '[]');
  } catch {
    return [];
  }
}

function writeAll(name, records) {
  const file = fileFor(name);
  ensureFile(file);
  // Write to temp file then rename — avoids truncated/corrupt writes on crash.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function insert(name, record) {
  const records = readAll(name);
  records.push(record);
  writeAll(name, records);
  return record;
}

function update(name, predicate, updater) {
  const records = readAll(name);
  const idx = records.findIndex(predicate);
  if (idx === -1) return null;
  records[idx] = updater({ ...records[idx] });
  writeAll(name, records);
  return records[idx];
}

function find(name, predicate) {
  return readAll(name).find(predicate) || null;
}

function filter(name, predicate) {
  return readAll(name).filter(predicate);
}

module.exports = { readAll, writeAll, insert, update, find, filter };
