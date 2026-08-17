const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../lib/db');
const { signToken, requireAdmin, checkPassword } = require('../lib/auth');
const { readDocument } = require('../lib/documentStore');
const { initiateMandate } = require('../lib/debicheck');
const { sendThankYou, sendDisbursementConfirmation, sendMandateDeclinedNotice } = require('../lib/reminders');
const { runCollectionsSweep } = require('../lib/collectionsSweep');
const { parseSalaryDayOfMonth } = require('../lib/repaymentSchedule');
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

// POST /api/admin/applications/:reference/underwriting
// Records a manually-performed credit bureau check — employment, credit
// record, judgments/defaults. Manual for now; this is the natural place to
// wire in a real bureau API (XDS, TransUnion, CompuScan, Experian) later —
// swap the manual entry for an API call and keep the same fields on
// application.underwriting so nothing downstream has to change.
router.post('/applications/:reference/underwriting', requireAdmin, asyncHandler(async (req, res) => {
  const { employmentConfirmed, creditRecordClean, judgmentsOrDefaultsFound, notes, verifiedNetMonthlyIncome, verifiedMonthlyExpenses, incomeVerificationNote } = req.body || {};
  const app = await db.find('applications', (a) => a.reference === req.params.reference);
  if (!app) return res.status(404).json({ error: 'Application not found.' });

  // Flag when verified income is materially lower than what the applicant
  // declared (>10% lower) — this is the actual point of capturing both
  // figures, not just recording them side by side for the file.
  let incomeDiscrepancyFlag = app.underwriting?.incomeDiscrepancyFlag ?? false;
  if (verifiedNetMonthlyIncome != null) {
    const declared = app.netMonthlyIncome || 0;
    const verified = Number(verifiedNetMonthlyIncome);
    incomeDiscrepancyFlag = declared > 0 && verified < declared * 0.9;
  }

  const updated = await db.update('applications', (a) => a.reference === req.params.reference, (a) => ({
    ...a,
    underwriting: {
      ...a.underwriting,
      bureauChecked: true,
      bureauCheckedBy: req.admin.email,
      bureauCheckedAt: new Date().toISOString(),
      employmentConfirmed: Boolean(employmentConfirmed),
      creditRecordClean: Boolean(creditRecordClean),
      judgmentsOrDefaultsFound: Boolean(judgmentsOrDefaultsFound),
      notes: notes || null,
      verifiedNetMonthlyIncome: verifiedNetMonthlyIncome != null ? Number(verifiedNetMonthlyIncome) : (a.underwriting?.verifiedNetMonthlyIncome ?? null),
      verifiedMonthlyExpenses: verifiedMonthlyExpenses != null ? Number(verifiedMonthlyExpenses) : (a.underwriting?.verifiedMonthlyExpenses ?? null),
      incomeVerificationNote: incomeVerificationNote || (a.underwriting?.incomeVerificationNote ?? null),
      incomeDiscrepancyFlag,
    },
  }));
  res.json(updated);
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
// Body: { decision: 'verify' | 'reject', checks: { identity, address, employment, payoutAccount }, note }
// This is the human gate: signing only unlocks once all four document
// checks pass AND a bureau/underwriting check has been recorded (see the
// /underwriting endpoint above) — Khula shouldn't be one automated
// affordability pass away from disbursing, the way payday-style lenders
// historically operated. A human confirms both the documents and the
// credit picture before money can move.
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
    const payoutAccount = Boolean(checks?.payoutAccount);
    if (!identity || !address || !employment || !payoutAccount) {
      return res.status(400).json({ error: 'All four checks (identity, address, employment, payout account) must be confirmed to verify KYC.' });
    }
    if (!app.underwriting?.bureauChecked) {
      return res.status(400).json({ error: 'Record a credit bureau / underwriting check first (POST .../underwriting) before verifying KYC.' });
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
        payoutAccountVerified: true,
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

// POST /api/admin/applications/:reference/debicheck — initiates a DebiCheck
// mandate for a signed, active loan. See server/lib/debicheck.js for what
// this does with and without real Netcash/Stitch credentials configured.
router.post('/applications/:reference/debicheck', requireAdmin, asyncHandler(async (req, res) => {
  const app = await db.find('applications', (a) => a.reference === req.params.reference);
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  if (app.status !== 'active') {
    return res.status(400).json({ error: `DebiCheck mandates can only be initiated for active, signed loans (status: ${app.status}).` });
  }
  if (app.collections?.debicheckStatus && app.collections.debicheckStatus !== 'not_started') {
    return res.status(400).json({ error: `A DebiCheck mandate has already been initiated for this loan (status: ${app.collections.debicheckStatus}). Cancel it with your provider first if you need to resend.` });
  }

  const preferredDay = parseSalaryDayOfMonth(app.salaryPaymentDate);

  const result = await initiateMandate({
    reference: app.reference,
    accountHolder: app.bankAccountHolder,
    bankName: app.bankName,
    accountNumber: app.accountNumber,
    branchCode: app.branchCode,
    instalmentAmount: app.affordability?.quotation?.firstMonthInstalment,
    instalmentDay: preferredDay || new Date(app.signature?.signedAt || Date.now()).getDate(),
  });

  const updated = await db.update('applications', (a) => a.reference === req.params.reference, (a) => ({
    ...a,
    collections: {
      ...a.collections,
      debicheckStatus: result.status,
      mandateReference: result.mandateReference,
      mandateSentAt: new Date().toISOString(),
    },
    adminNotes: [...(a.adminNotes || []), { note: `DebiCheck mandate ${result.mandateReference} initiated.${result.note ? ' ' + result.note : ''}`, at: new Date().toISOString(), by: req.admin.email }],
  }));

  res.json({ ...updated, debicheckNote: result.note || null });
}));

// POST /api/admin/applications/:reference/mandate/confirm
// This is the real gate on disbursement: the loan is legally signed the
// moment the borrower types their name, but funds should only move once
// the DebiCheck mandate is actually confirmed by the borrower's own bank.
// Until a real provider webhook exists (see server/lib/debicheck.js), an
// admin confirms this manually — same "human gate until real integration
// exists" pattern used for the credit bureau check and KYC review.
router.post('/applications/:reference/mandate/confirm', requireAdmin, asyncHandler(async (req, res) => {
  const app = await db.find('applications', (a) => a.reference === req.params.reference);
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  if (app.collections?.debicheckStatus !== 'mandate_sent') {
    return res.status(400).json({ error: `No pending mandate to confirm (current status: ${app.collections?.debicheckStatus || 'not_started'}).` });
  }

  const confirmedAt = new Date().toISOString();
  const updated = await db.update('applications', (a) => a.reference === req.params.reference, (a) => ({
    ...a,
    collections: { ...a.collections, debicheckStatus: 'mandate_confirmed', mandateConfirmedAt: confirmedAt },
    disbursement: { status: 'disbursed', disbursedAt: confirmedAt, confirmedBy: req.admin.email },
    adminNotes: [...(a.adminNotes || []), { note: 'DebiCheck mandate confirmed by borrower\'s bank — funds disbursed.', at: confirmedAt, by: req.admin.email }],
  }));

  sendDisbursementConfirmation(updated).catch((e) => console.error('Failed to send disbursement confirmation:', e.message));

  res.json(updated);
}));

// POST /api/admin/applications/:reference/mandate/decline
router.post('/applications/:reference/mandate/decline', requireAdmin, asyncHandler(async (req, res) => {
  const { note } = req.body || {};
  const app = await db.find('applications', (a) => a.reference === req.params.reference);
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  if (app.collections?.debicheckStatus !== 'mandate_sent') {
    return res.status(400).json({ error: `No pending mandate to decline (current status: ${app.collections?.debicheckStatus || 'not_started'}).` });
  }

  const declinedAt = new Date().toISOString();
  const updated = await db.update('applications', (a) => a.reference === req.params.reference, (a) => ({
    ...a,
    collections: { ...a.collections, debicheckStatus: 'mandate_declined' },
    adminNotes: [...(a.adminNotes || []), { note: note || 'DebiCheck mandate declined/not confirmed by borrower\'s bank.', at: declinedAt, by: req.admin.email }],
  }));

  sendMandateDeclinedNotice(updated).catch((e) => console.error('Failed to send mandate declined notice:', e.message));

  res.json(updated);
}));

// ---------------- Agent management ----------------
// Agents are shop staff / field reps who submit applications on behalf of
// a physically-present customer (see server/routes/agent.js and
// public/agent.html). Managed here since only admins should be able to
// create or deactivate one.

function generateAgentCode() {
  return `AG-${Math.floor(1000 + Math.random() * 9000)}`;
}

// POST /api/admin/agents  { name, shopName, location, pin }
router.post('/agents', requireAdmin, asyncHandler(async (req, res) => {
  const { name, shopName, location, pin } = req.body || {};
  if (!name || !shopName || !pin) {
    return res.status(400).json({ error: 'Agent name, shop name, and a PIN are required.' });
  }
  if (!/^\d{4,8}$/.test(String(pin))) {
    return res.status(400).json({ error: 'PIN must be 4-8 digits.' });
  }

  let agentCode;
  let attempts = 0;
  do {
    agentCode = generateAgentCode();
    attempts += 1;
  } while (attempts < 10 && (await db.find('agents', (a) => a.agentCode === agentCode)));

  const pinHash = await bcrypt.hash(String(pin), 10);
  const agent = {
    id: uuidv4(),
    agentCode,
    name,
    shopName,
    location: location || null,
    pinHash,
    active: true,
    createdAt: new Date().toISOString(),
    createdBy: req.admin.email,
  };
  await db.insert('agents', agent);

  const { pinHash: _omit, ...safe } = agent;
  res.status(201).json(safe);
}));

// GET /api/admin/agents — list agents with a rough activity count
router.get('/agents', requireAdmin, asyncHandler(async (req, res) => {
  const agents = await db.readAll('agents');
  const applications = await db.readAll('applications');
  const withStats = agents.map(({ pinHash, ...a }) => ({
    ...a,
    applicationsSubmitted: applications.filter((app) => app.agent?.agentId === a.id).length,
    loansActive: applications.filter((app) => app.agent?.agentId === a.id && app.status === 'active').length,
  }));
  res.json(withStats.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
}));

// POST /api/admin/agents/:id/deactivate
router.post('/agents/:id/deactivate', requireAdmin, asyncHandler(async (req, res) => {
  const updated = await db.update('agents', (a) => a.id === req.params.id, (a) => ({ ...a, active: false }));
  if (!updated) return res.status(404).json({ error: 'Agent not found.' });
  const { pinHash, ...safe } = updated;
  res.json(safe);
}));

// ---------------- Collections ----------------

// POST /api/admin/applications/:reference/repayments/:installmentNumber/mark-paid
// No real payment webhook exists yet (see server/lib/debicheck.js) — this is
// how a payment gets recorded until DebiCheck confirmation is wired in. When
// it is, call this same logic from the webhook handler instead of requiring
// a manual click, and keep this endpoint as the manual-override path.
router.post('/applications/:reference/repayments/:installmentNumber/mark-paid', requireAdmin, asyncHandler(async (req, res) => {
  const app = await db.find('applications', (a) => a.reference === req.params.reference);
  if (!app) return res.status(404).json({ error: 'Application not found.' });

  const schedule = app.collections?.repaymentSchedule || [];
  const installmentNumber = Number(req.params.installmentNumber);
  const installment = schedule.find((i) => i.installmentNumber === installmentNumber);
  if (!installment) return res.status(404).json({ error: 'Installment not found.' });
  if (installment.status === 'paid') return res.status(400).json({ error: 'This installment is already marked paid.' });

  const paidAt = new Date().toISOString();
  const updatedSchedule = schedule.map((i) =>
    i.installmentNumber === installmentNumber ? { ...i, status: 'paid', paidAt, markedPaidBy: req.admin.email } : i
  );
  const remaining = updatedSchedule.filter((i) => i.status !== 'paid').length;
  const allPaid = remaining === 0;

  const updated = await db.update('applications', (a) => a.reference === req.params.reference, (a) => ({
    ...a,
    status: allPaid ? 'completed' : a.status,
    collections: { ...a.collections, repaymentSchedule: updatedSchedule },
    adminNotes: [...(a.adminNotes || []), { note: `Instalment ${installmentNumber} marked paid.${allPaid ? ' Loan fully repaid.' : ''}`, at: paidAt, by: req.admin.email }],
  }));

  sendThankYou(updated, installment, remaining).catch((e) => console.error('Failed to send thank-you message:', e.message));

  res.json(updated);
}));

// POST /api/admin/collections/run-sweep — manually trigger the reminder/
// overdue sweep (the same logic that also runs on a timer — see
// server/index.js). Useful for testing without waiting for the timer.
router.post('/collections/run-sweep', requireAdmin, asyncHandler(async (req, res) => {
  const results = await runCollectionsSweep();
  res.json(results);
}));

// ---------------- Legal / collections escalation ----------------
// Tracks the ladder from soft collections through to enforcement. Every
// step here is a manual admin action, deliberately — actual legal
// escalation (sending a Section 129 notice, handing a case to a collector,
// pursuing a court judgment) should always be a human decision, not
// something the system does on its own on a timer. See docs/VISION.md and
// the compliance review this was built from for why: Khula (as a company)
// cannot itself use Small Claims Court, and an EAO/garnishee order can
// only be applied for AFTER a Magistrate's Court judgment already exists —
// this is enforcement tracking, not a first-line collections tool.

// POST /api/admin/applications/:reference/legal/section129
router.post('/applications/:reference/legal/section129', requireAdmin, asyncHandler(async (req, res) => {
  const { note } = req.body || {};
  const app = await db.find('applications', (a) => a.reference === req.params.reference);
  if (!app) return res.status(404).json({ error: 'Application not found.' });

  const sentAt = new Date().toISOString();
  const updated = await db.update('applications', (a) => a.reference === req.params.reference, (a) => ({
    ...a,
    legal: {
      ...a.legal,
      section129NoticeSent: true,
      section129SentAt: sentAt,
      notes: [...(a.legal?.notes || []), { action: 'section129_sent', at: sentAt, by: req.admin.email, note: note || null }],
    },
  }));
  res.json(updated);
}));

// POST /api/admin/applications/:reference/legal/handover  { collectorReference, note }
router.post('/applications/:reference/legal/handover', requireAdmin, asyncHandler(async (req, res) => {
  const { collectorReference, note } = req.body || {};
  const app = await db.find('applications', (a) => a.reference === req.params.reference);
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  if (!app.legal?.section129NoticeSent) {
    return res.status(400).json({ error: 'Send the Section 129 notice before handing this case to a collector/attorney.' });
  }

  const handedAt = new Date().toISOString();
  const updated = await db.update('applications', (a) => a.reference === req.params.reference, (a) => ({
    ...a,
    legal: {
      ...a.legal,
      handedToCollector: true,
      handedToCollectorAt: handedAt,
      collectorReference: collectorReference || null,
      notes: [...(a.legal?.notes || []), { action: 'handed_to_collector', at: handedAt, by: req.admin.email, note: note || null }],
    },
  }));
  res.json(updated);
}));

// POST /api/admin/applications/:reference/legal/judgment  { judgmentReference, judgmentDate, note }
// A Magistrate's Court judgment — NOT Small Claims Court, which Khula
// cannot use as a company (Small Claims Courts Act s7(1) restricts
// plaintiffs to natural persons).
router.post('/applications/:reference/legal/judgment', requireAdmin, asyncHandler(async (req, res) => {
  const { judgmentReference, judgmentDate, note } = req.body || {};
  const app = await db.find('applications', (a) => a.reference === req.params.reference);
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  if (!app.legal?.handedToCollector) {
    return res.status(400).json({ error: 'Hand this case to a collector/attorney before recording a court judgment.' });
  }

  const recordedAt = new Date().toISOString();
  const updated = await db.update('applications', (a) => a.reference === req.params.reference, (a) => ({
    ...a,
    legal: {
      ...a.legal,
      magistratesCourtJudgment: true,
      judgmentDate: judgmentDate || recordedAt,
      judgmentReference: judgmentReference || null,
      notes: [...(a.legal?.notes || []), { action: 'judgment_recorded', at: recordedAt, by: req.admin.email, note: note || null }],
    },
  }));
  res.json(updated);
}));

// POST /api/admin/applications/:reference/legal/enforcement  { mechanism: 'eao'|'garnishee'|'warrant_of_execution', note }
router.post('/applications/:reference/legal/enforcement', requireAdmin, asyncHandler(async (req, res) => {
  const { mechanism, note } = req.body || {};
  if (!['eao', 'garnishee', 'warrant_of_execution'].includes(mechanism)) {
    return res.status(400).json({ error: 'mechanism must be "eao", "garnishee", or "warrant_of_execution".' });
  }
  const app = await db.find('applications', (a) => a.reference === req.params.reference);
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  if (!app.legal?.magistratesCourtJudgment) {
    return res.status(400).json({ error: 'An EAO, garnishee order, or warrant of execution can only be pursued AFTER a Magistrate\'s Court judgment — record the judgment first.' });
  }

  const initiatedAt = new Date().toISOString();
  const updated = await db.update('applications', (a) => a.reference === req.params.reference, (a) => ({
    ...a,
    legal: {
      ...a.legal,
      enforcementMechanism: mechanism,
      enforcementInitiatedAt: initiatedAt,
      notes: [...(a.legal?.notes || []), { action: `enforcement_${mechanism}_initiated`, at: initiatedAt, by: req.admin.email, note: note || null }],
    },
  }));
  res.json(updated);
}));

module.exports = router;
