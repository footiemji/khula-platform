require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const asyncHandler = require('./lib/asyncHandler');

const applicationsRouter = require('./routes/applications');
const adminRouter = require('./routes/admin');
const whatsappRouter = require('./routes/whatsapp');
const otpRouter = require('./routes/otp');
const agentRouter = require('./routes/agent');

const app = express();

// Render (and most PaaS platforms) sit behind a reverse proxy, which sets
// X-Forwarded-For on every request. Without telling Express to trust that
// proxy, express-rate-limit can't safely determine each request's real
// client IP — in the worst case, every request looks like it comes from
// the same source, meaning one user hitting a rate limit could
// incorrectly affect everyone else. '1' means "trust exactly one hop" —
// Render's own proxy — which is correct here and doesn't open this up to
// IP-spoofing via a client-supplied header, since only Render's proxy is
// trusted, not arbitrary forwarded values from the internet.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled for the demo inline styles; tighten for production
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Basic abuse protection on the public-facing loan application endpoint.
const applyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many requests, please try again later.' } });
app.use('/api/applications', applyLimiter);

// Tighter limit on admin login specifically — this is the endpoint most
// worth protecting against brute-force password guessing.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many login attempts. Please try again in 15 minutes.' } });
app.use('/api/admin/login', loginLimiter);

// OTP requests are already rate-limited per-phone-number inside otp.js, but
// this adds a second, IP-based layer against someone hammering the
// endpoint across many different numbers.
const otpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many requests, please try again later.' } });
app.use('/api/otp', otpLimiter);

// Agent login gets a brute-force limiter too, same as admin login.
const agentLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15, message: { error: 'Too many login attempts. Please try again in 15 minutes.' } });
app.use('/api/agent/login', agentLoginLimiter);

if (!process.env.KYC_ENCRYPTION_KEY) {
  console.warn(
    '\n[warning] KYC_ENCRYPTION_KEY is not set. Document uploads will fail until you set one:\n' +
    '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
    '  then add KYC_ENCRYPTION_KEY=<the output> to your .env\n'
  );
}

app.use('/api/applications', applicationsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/whatsapp', whatsappRouter);
app.use('/api/otp', otpRouter);
app.use('/api/agent', agentRouter);

// Periodic collections sweep — sends upcoming-payment reminders and
// overdue notices. See server/lib/collectionsSweep.js for the production
// caveats (single-instance only; move to an external scheduler if you ever
// run more than one instance of this app).
const { runCollectionsSweep } = require('./lib/collectionsSweep');
const SWEEP_INTERVAL_MS = Number(process.env.COLLECTIONS_SWEEP_INTERVAL_MS || 6 * 60 * 60 * 1000); // default every 6 hours
setInterval(() => {
  runCollectionsSweep().catch((err) => console.error('Collections sweep failed:', err.message));
}, SWEEP_INTERVAL_MS);

// Application expiry sweep — clears out unresolved applications after 24
// hours (see server/lib/applicationExpiry.js). Runs more frequently than
// the collections sweep since a 24-hour expiry window needs finer-grained
// checking than a 6-hour one would allow.
const { runApplicationExpirySweep } = require('./lib/applicationExpiry');
const EXPIRY_SWEEP_INTERVAL_MS = Number(process.env.EXPIRY_SWEEP_INTERVAL_MS || 60 * 60 * 1000); // default every hour
setInterval(() => {
  runApplicationExpirySweep().catch((err) => console.error('Application expiry sweep failed:', err.message));
}, EXPIRY_SWEEP_INTERVAL_MS);

app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'khula-financial-services', time: new Date().toISOString() }));

// Non-sensitive config the frontend needs — e.g. the real WhatsApp number
// for building a wa.me deep link, so it's not hardcoded into static HTML.
app.get('/api/config', (req, res) => res.json({
  whatsappBusinessNumber: process.env.WHATSAPP_BUSINESS_NUMBER || null,
  otpTemplateConfigured: Boolean(process.env.WHATSAPP_OTP_TEMPLATE_NAME),
  applicationsPaused: process.env.APPLICATIONS_PAUSED === 'true',
  minLoanAmount: Number(process.env.MIN_LOAN_AMOUNT || 500),
  maxLoanAmount: Number(process.env.MAX_LOAN_AMOUNT || 1000),
}));

// GET /api/whatsapp-qr.png — a scannable QR code for the WhatsApp entry
// point, pre-filled with "LOAN" so desktop visitors get the exact same
// deliberate-first-message signal as someone tapping the wa.me link
// directly on their phone. Generated on demand rather than as a static
// asset, since the underlying number is only known at runtime from env
// config.
const QRCode = require('qrcode');
app.get('/api/whatsapp-qr.png', asyncHandler(async (req, res) => {
  const number = process.env.WHATSAPP_BUSINESS_NUMBER;
  if (!number) return res.status(404).send('WhatsApp number not configured yet.');

  const waLink = `https://wa.me/${number}?text=${encodeURIComponent('LOAN')}`;
  const buffer = await QRCode.toBuffer(waLink, { width: 300, margin: 1, color: { dark: '#16321A', light: '#00000000' } });
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=3600'); // number doesn't change often — safe to cache for an hour
  res.send(buffer);
}));

// South African bank list + branch codes, for the payout bank dropdown —
// single source of truth shared with the WhatsApp channel's fuzzy matcher.
const { SA_BANKS } = require('./lib/bankCodes');
app.get('/api/banks', (req, res) => res.json(SA_BANKS));

// Serve the borrower chat widget + admin dashboard
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

app.listen(PORT, () => {
  console.log(`\nKhula Financial Services platform running at http://localhost:${PORT}`);
  console.log(`Borrower app:  http://localhost:${PORT}/`);
  console.log(`Admin console: http://localhost:${PORT}/admin.html\n`);
});
