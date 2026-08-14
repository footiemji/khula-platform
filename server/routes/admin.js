const express = require('express');
const db = require('../lib/db');
const { signToken, requireAdmin, checkPassword } = require('../lib/auth');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

// POST /api/admin/login
router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  const validEmail = (process.env.ADMIN_EMAIL || '').toLowerCase();
  const hash = process.env.ADMIN_PASSWORD_HASH || '';

  if (!hash) {
    return res.status(500).json({ error: 'Admin account not configured. Run `npm run seed:admin -- "password"` and set ADMIN_PASSWORD_HASH in .env.' });
  }
  if ((email || '').toLowerCase() !== validEmail) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }
  const ok = await checkPassword(password || '', hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials.' });

  const token = signToken({ role: 'admin', email: validEmail });
  res.json({ token });
}));

// GET /api/admin/applications?status=manual_review
router.get('/applications', requireAdmin, asyncHandler(async (req, res) => {
  const { status } = req.query;
  let apps = await db.readAll('applications');
  if (status) apps = apps.filter((a) => a.status === status || a.decision === status);
  apps = apps.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(apps);
}));

// GET /api/admin/stats
router.get('/stats', requireAdmin, asyncHandler(async (req, res) => {
  const apps = await db.readAll('applications');
  const totalDisbursed = apps.filter((a) => a.status === 'active').reduce((sum, a) => sum + a.requestedAmount, 0);
  res.json({
    total: apps.length,
    approved: apps.filter((a) => a.decision === 'approved').length,
    manualReview: apps.filter((a) => a.decision === 'manual_review').length,
    declined: apps.filter((a) => a.decision === 'declined').length,
    active: apps.filter((a) => a.status === 'active').length,
    totalDisbursed,
  });
}));

// POST /api/admin/applications/:reference/decision  { decision: 'approved' | 'declined', note }
router.post('/applications/:reference/decision', requireAdmin, asyncHandler(async (req, res) => {
  const { decision, note } = req.body || {};
  if (!['approved', 'declined'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "approved" or "declined".' });
  }
  const updated = await db.update(
    'applications',
    (a) => a.reference === req.params.reference,
    (a) => ({
      ...a,
      decision,
      status: decision === 'approved' ? 'awaiting_signature' : 'declined',
      adminNotes: [...(a.adminNotes || []), { note: note || `Manually ${decision} by admin`, at: new Date().toISOString(), by: req.admin.email }],
    })
  );
  if (!updated) return res.status(404).json({ error: 'Application not found.' });
  res.json(updated);
}));

module.exports = router;
