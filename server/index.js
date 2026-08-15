require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const applicationsRouter = require('./routes/applications');
const adminRouter = require('./routes/admin');
const whatsappRouter = require('./routes/whatsapp');
const otpRouter = require('./routes/otp');
const agentRouter = require('./routes/agent');

const app = express();
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

app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'khula-financial-services', time: new Date().toISOString() }));

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
