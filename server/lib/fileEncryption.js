// Encrypts uploaded KYC documents at rest with AES-256-GCM. Files never
// touch disk in plaintext — this matters because ID documents, proof of
// address, and payslips are exactly the kind of data POPIA and basic
// security hygiene require you to protect.
//
// KYC_ENCRYPTION_KEY must be a 32-byte key, hex-encoded (64 hex chars).
// Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// Losing this key means losing access to every stored document — back it
// up the same way you'd back up any other production secret, separately
// from the documents themselves.

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey() {
  const hex = process.env.KYC_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'KYC_ENCRYPTION_KEY is missing or invalid. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" and set it in .env'
    );
  }
  return Buffer.from(hex, 'hex');
}

// Returns a single Buffer: [iv (12 bytes)][auth tag (16 bytes)][ciphertext]
function encryptBuffer(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

function decryptBuffer(payload) {
  const key = getKey();
  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

module.exports = { encryptBuffer, decryptBuffer };
