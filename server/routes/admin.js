const express = require('express');
const db = require('../lib/db');
const { signToken, requireAdmin, checkPassword } = require('../lib/auth');
const { readDocument } = require('../lib/documentStore');
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

// GET /api/admin/applications/:reference/documents/:docId — decrypts and
// streams a single uploaded document. Every access is appended to the
// application's kyc.auditLog so there's a record of who viewed what and
// when — standard practice for anything touching ID documents.
router.get('/applications/:reference/documents/:docId', requireAdmin, asyncHandler(async (req, res) => {
  const app = await db.find('applications', (a) => a.reference === req.params.reference);
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  const doc = (app.kyc?.documents || []).find((d) => d.id === req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  let buffer;
  try {
    buffer = readDocument(app.reference, doc.storedFilename);
  } catch (err) {
    return res.status(500).json({ error: 'Could not decrypt document. Check KYC_ENCRYPTION_KEY is set and unchanged since upload.' });
  }

  await db.update('applications', (a) => a.reference === req.params.reference, (a) => ({
    ...a,
    kyc: {
      ...a.kyc,
      auditLog: [...(a.kyc.auditLog || []), { action: 'viewed', documentType: doc.type, by: req.admin.email, at: new Date().toISOString() }],
    },
  }));

  res.setHeader('Content-Type', doc.mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${doc.type}-${app.reference}.${doc.mimeType.split('/')[1]}"`);
  res.send(buffer);
}));

// POST /api/admin/applications/:reference/kyc-decision
// Body: { decision: 'verify' | 'reject', checks: { identity, address, employment }, note }
// This is the human gate: signing only unlocks once all three checks pass.
router.post('/applications/:reference/kyc-decision', requireAdmin, asyncHandler(async (req, res) => {
  const { decision, checks, note } = req.body || {};
  if (!['verify', 'reject'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "verify" or "reject".' });
  }

  const app = await db.find('applications', (a) => a.reference === req.params.reference);
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  if (app.status !== 'pending_kyc') {
    return res.status(400).json({ error: `Application is not pending KYC review (status: ${app.status}).` });
  }

  if (decision === 'verify') {
    const identity = Boolean(checks?.identity);
    const address = Boolean(checks?.address);
    const employment = Boolean(checks?.employment);
    if (!identity || !address || !employment) {
      return res.status(400).json({ error: 'All three checks (identity, address, employment) must be confirmed to verify KYC.' });
    }
    const updated = await db.update('applications', (a) => a.reference === req.params.reference, (a) => ({
      ...a,
      status: 'awaiting_signature',
      kyc: {
        ...a.kyc,
        status: 'verified',
        identityVerified: true,
        addressVerified: true,
        employmentVerified: true,
        reviewedBy: req.admin.email,
        reviewedAt: new Date().toISOString(),
        auditLog: [...(a.kyc.auditLog || []), { action: 'verified', by: req.admin.email, at: new Date().toISOString(), note: note || null }],
      },
    }));
    return res.json(updated);
  }

  // reject
  const updated = await db.update('applications', (a) => a.reference === req.params.reference, (a) => ({
    ...a,
    status: 'declined',
    decision: 'declined',
    kyc: {
      ...a.kyc,
      status: 'rejected',
      reviewedBy: req.admin.email,
      reviewedAt: new Date().toISOString(),
      auditLog: [...(a.kyc.auditLog || []), { action: 'rejected', by: req.admin.email, at: new Date().toISOString(), note: note || null }],
    },
    adminNotes: [...(a.adminNotes || []), { note: note || 'KYC documents rejected on review.', at: new Date().toISOString(), by: req.admin.email }],
  }));
  res.json(updated);
}));

module.exports = router;
