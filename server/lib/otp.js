// Verifies that whoever is applying actually controls the phone number they
// entered — this matters specifically for the web application flow, where
// someone could type in any phone number, including a number they don't
// own, along with someone else's ID/proof-of-address/proof-of-income
// documents. A 6-digit code sent to that number and required back closes
// that gap for the web channel.
//
// The WhatsApp channel doesn't need this: if someone is messaging Khula
// FROM a WhatsApp number, they've already proven they control it — that's
// inherent to the channel. OTP is a web-specific gap-closer, not a general
// KYC step. See server/routes/applications.js for where this is enforced.

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { sendWhatsAppMessage, sendWhatsAppTemplate } = require('./whatsappSender');
const { toWhatsAppFormat } = require('./phoneFormat');

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_VERIFY_ATTEMPTS = 5;
const MAX_REQUESTS_PER_WINDOW = 3;
const REQUEST_WINDOW_MS = 15 * 60 * 1000;

// The canonical key used to match a phone number across requests — using
// the same WhatsApp-ready format here as for the actual send means
// "0821234567" and "+27 82 123 4567" are correctly recognised as the same
// number, rather than accidentally creating two separate OTP records for
// what's really one person.
function normalizePhone(phone) {
  return toWhatsAppFormat(phone);
}

function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function generateCode() {
  return String(crypto.randomInt(100000, 999999));
}

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

// Sends a fresh OTP to the given phone number over WhatsApp. Returns
// { ok: true } or { ok: false, error } — rate-limited per phone number to
// stop someone from hammering a number with codes (their own, as a
// nuisance, or someone else's).
async function requestOtp(phoneNumber) {
  const phone = normalizePhone(phoneNumber);
  if (!phone || phone.length < 9) {
    return { ok: false, error: 'Please provide a valid phone number.' };
  }

  const recent = await db.filter(
    'otp_verifications',
    (o) => o.phone === phone && !o.deliveryFailed && Date.now() - new Date(o.createdAt).getTime() < REQUEST_WINDOW_MS
  );
  if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
    return { ok: false, error: 'Too many codes requested for this number. Please wait 15 minutes and try again.' };
  }

  const code = generateCode();
  const record = {
    id: uuidv4(),
    phone,
    codeHash: hashCode(code),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + OTP_TTL_MS).toISOString(),
    attempts: 0,
    verified: false,
    verifiedToken: null,
  };
  await db.insert('otp_verifications', record);

  const waMessagingPhone = phone; // already in WhatsApp-ready format via normalizePhone/toWhatsAppFormat

  // Once WHATSAPP_OTP_TEMPLATE_NAME is set (i.e. your Authentication
  // template is approved), OTPs send via the template — reliable
  // regardless of whether the customer has an open 24-hour service
  // window. Until then, this falls back to the plain-text message, which
  // ONLY delivers within that window — see docs/DEPLOY.md or README §4.
  const delivered = process.env.WHATSAPP_OTP_TEMPLATE_NAME
    ? await sendWhatsAppTemplate(
        waMessagingPhone,
        process.env.WHATSAPP_OTP_TEMPLATE_NAME,
        process.env.WHATSAPP_OTP_TEMPLATE_LANG || 'en_US',
        [code]
      )
    : await sendWhatsAppMessage(waMessagingPhone, `Your Khula Financial Services verification code is ${code}. It expires in 5 minutes. Don't share this code with anyone.`);

  if (!delivered) {
    // Don't leave a dead record counting against the rate limit for a code
    // that never arrived — the person shouldn't burn one of their 3
    // attempts per 15 minutes on a delivery failure that wasn't their fault.
    await db.update('otp_verifications', (o) => o.id === record.id, (o) => ({ ...o, deliveryFailed: true }));
    return {
      ok: false,
      error: 'Could not deliver the code to WhatsApp. This usually means the phone number isn\'t on WhatsApp, isn\'t in your approved test-recipient list yet, or your WhatsApp access token has expired — check the server logs for the exact reason.',
    };
  }

  return { ok: true };
}

// Verifies a code against the most recent OTP request for that phone.
// Returns { ok: true, verificationToken } on success — that token must be
// passed back with the application submission (see applications.js) so the
// server, not just the client UI, enforces that verification happened.
async function verifyOtp(phoneNumber, code) {
  const phone = normalizePhone(phoneNumber);
  const candidates = await db.filter('otp_verifications', (o) => o.phone === phone && !o.verified);
  if (candidates.length === 0) {
    return { ok: false, error: 'No pending verification for this number. Request a new code.' };
  }
  const latest = candidates.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

  if (new Date() > new Date(latest.expiresAt)) {
    return { ok: false, error: 'That code has expired. Request a new one.' };
  }
  if (latest.attempts >= MAX_VERIFY_ATTEMPTS) {
    return { ok: false, error: 'Too many incorrect attempts. Request a new code.' };
  }

  if (hashCode(String(code || '').trim()) !== latest.codeHash) {
    await db.update('otp_verifications', (o) => o.id === latest.id, (o) => ({ ...o, attempts: o.attempts + 1 }));
    return { ok: false, error: 'Incorrect code. Please try again.' };
  }

  const verificationToken = generateToken();
  await db.update('otp_verifications', (o) => o.id === latest.id, (o) => ({
    ...o,
    verified: true,
    verifiedToken: verificationToken,
    verifiedAt: new Date().toISOString(),
  }));

  return { ok: true, verificationToken };
}

// Called at application-submission time to confirm the phone number was
// actually verified via a token this module issued, and that the token
// belongs to the same phone number being submitted. This is the real gate —
// the frontend UX is just there to make it usable, not to be trusted alone.
async function checkVerificationToken(phoneNumber, verificationToken) {
  if (!verificationToken) return false;
  const phone = normalizePhone(phoneNumber);
  const match = await db.find('otp_verifications', (o) => o.phone === phone && o.verified && o.verifiedToken === verificationToken);
  return Boolean(match);
}

module.exports = { requestOtp, verifyOtp, checkVerificationToken, normalizePhone };
