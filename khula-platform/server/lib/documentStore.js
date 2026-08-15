// Stores uploaded KYC documents encrypted on disk, one folder per
// application reference. Nothing outside this file touches the filesystem
// directly — if you move to S3/cloud storage later (recommended once you're
// handling real documents at scale), this is the one file to change.

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { encryptBuffer, decryptBuffer } = require('./fileEncryption');

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');

function ensureDir(reference) {
  const dir = path.join(UPLOAD_DIR, reference);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveDocument(reference, buffer) {
  const dir = ensureDir(reference);
  const id = uuidv4();
  const filename = `${id}.enc`;
  fs.writeFileSync(path.join(dir, filename), encryptBuffer(buffer));
  return { id, filename };
}

function readDocument(reference, filename) {
  const filePath = path.join(UPLOAD_DIR, reference, filename);
  const payload = fs.readFileSync(filePath);
  return decryptBuffer(payload);
}

function deleteDocument(reference, filename) {
  const filePath = path.join(UPLOAD_DIR, reference, filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

module.exports = { saveDocument, readDocument, deleteDocument, UPLOAD_DIR };
