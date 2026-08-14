require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const applicationsRouter = require('./routes/applications');
const adminRouter = require('./routes/admin');
const whatsappRouter = require('./routes/whatsapp');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled for the demo inline styles; tighten for production
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Basic abuse protection on the public-facing loan application endpoint.
const applyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many requests, please try again later.' } });
app.use('/api/applications', applyLimiter);

app.use('/api/applications', applicationsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/whatsapp', whatsappRouter);

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
