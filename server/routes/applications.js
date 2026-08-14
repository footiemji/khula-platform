const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../lib/db');
const { assessAffordability } = require('../lib/affordability');
const { scoreApplication, decide } = require('../lib/riskScore');
const { streamPreAgreementPDF } = require('../lib/pdfAgreement');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

// Default reconsideration window (business days), configurable via .env.
// This is a policy default, not a confirmed statutory requirement — see
// docs/COMPLIANCE.md. Have your compliance officer confirm the applicable
// right before relying on this in production.
const RECONSIDERATION_DAYS = Number(process.env.RECONSIDERATION_DAYS || 5);

function addBusinessDays(date, days) {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (day !== 0 && day !== 6) added += 1;
  }
  return result;
}

function generateReference() {
  const stamp = Date.now().toString(36).toUpperCase();
  return `KHULA-${stamp}`;
}

// POST /api/applications
// Creates a new loan application, runs the instant affordability + risk
// decision, and stores the outcome. Used by both the web chat widget and
// the WhatsApp conversation engine — one code path, two front doors.
router.post('/', asyncHandler(async (req, res) => {
  const {
    fullName,
    idNumber,
    phoneNumber,
    employmentType,
    monthsEmployed,
    netMonthlyIncome,
    monthlyExpenses,
    existingDebtInstalments,
    requestedAmount,
    termMonths,
    popiaConsent,
    channel = 'web',
  } = req.body || {};

  if (!popiaConsent) {
    return res.status(400).json({ error: 'POPIA consent is required before we can process an application.' });
  }
  if (!fullName || !idNumber || !phoneNumber) {
    return res.status(400).json({ error: 'Full name, ID number and phone number are required.' });
  }

  // Very light ID number sanity check (13 digits, SA format). Real KYC /
  // identity verification happens via Smile ID before disbursement — see
  // docs/COMPLIANCE.md.
  const idClean = String(idNumber).replace(/\s/g, '');
  if (!/^\d{13}$/.test(idClean)) {
    return res.status(400).json({ error: 'ID number must be 13 digits.' });
  }

  const affordability = assessAffordability({
    netMonthlyIncome: Number(netMonthlyIncome),
    monthlyExpenses: Number(monthlyExpenses),
    existingDebtInstalments: Number(existingDebtInstalments || 0),
    requestedAmount: Number(requestedAmount),
    termMonths: Number(termMonths),
  });

  if (affordability.errors && affordability.errors.length) {
    return res.status(400).json({ error: affordability.errors.join(' ') });
  }

  const previousLoans = await db.filter('applications', (a) => a.idNumber === idClean && a.decision === 'approved');
  const missedPayments = previousLoans.filter((a) => a.repaymentStatus === 'missed').length;

  const risk = scoreApplication({
    employmentType,
    monthsEmployed: Number(monthsEmployed || 0),
    netMonthlyIncome: Number(netMonthlyIncome),
    existingDebtInstalments: Number(existingDebtInstalments || 0),
    requestedAmount: Number(requestedAmount),
    previousLoansWithKhula: previousLoans.length,
    missedPaymentsWithKhula: missedPayments,
  });

  const outcome = decide({ affordability, risk });

  const record = {
    id: uuidv4(),
    reference: generateReference(),
    createdAt: new Date().toISOString(),
    channel,
    status: outcome.decision === 'approved' ? 'awaiting_signature' : outcome.decision,
    decision: outcome.decision,
    fullName,
    idNumber: idClean,
    phoneNumber,
    employmentType,
    monthsEmployed: Number(monthsEmployed || 0),
    netMonthlyIncome: Number(netMonthlyIncome),
    monthlyExpenses: Number(monthlyExpenses),
    existingDebtInstalments: Number(existingDebtInstalments || 0),
    requestedAmount: Number(requestedAmount),
    termMonths: Number(termMonths),
    popiaConsent: true,
    popiaConsentAt: new Date().toISOString(),
    affordability,
    risk,
    signature: null,
    reconsiderationDeadline: null,
    adminNotes: [],
  };

  await db.insert('applications', record);

  res.status(201).json({
    reference: record.reference,
    decision: record.decision,
    status: record.status,
    proposedInstalment: affordability.proposedInstalment,
    suggestedAmount: affordability.suggestedAmount,
    message: messageForDecision(outcome.decision, record),
  });
}));

function messageForDecision(decisionType, record) {
  switch (decisionType) {
    case 'approved':
      return `Good news, ${record.fullName.split(' ')[0]}! You're pre-approved for R${record.requestedAmount} over ${record.termMonths} months (est. R${record.affordability.proposedInstalment}/month). Reference ${record.reference}. Next step: sign your agreement.`;
    case 'manual_review':
      return `Thanks ${record.fullName.split(' ')[0]}. Your application (${record.reference}) needs a quick human review — we'll be in touch on WhatsApp within 1 business day.`;
    case 'declined':
      return record.affordability.suggestedAmount
        ? `Based on what you shared, R${record.requestedAmount} isn't affordable right now, but R${record.affordability.suggestedAmount} over the same term looks manageable. Reply to try that amount.`
        : `Based on what you shared, we can't offer a loan right now. Reference ${record.reference}.`;
    default:
      return `Your application (${record.reference}) has been received.`;
  }
}

// GET /api/applications/:reference — status check
router.get('/:reference', asyncHandler(async (req, res) => {
  const app = await db.find('applications', (a) => a.reference === req.params.reference);
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  const { idNumber, ...safe } = app; // don't echo full ID number back over the wire
  res.json(safe);
}));

// POST /api/applications/:reference/sign — simulated e-signature capture.
// Real deployments should route this through SigniFlow for a legally
// binding, audit-trailed signature (see docs/COMPLIANCE.md).
router.post('/:reference/sign', asyncHandler(async (req, res) => {
  const { typedFullName } = req.body || {};
  if (!typedFullName) return res.status(400).json({ error: 'Typed full name is required to sign.' });

  const app = await db.find('applications', (a) => a.reference === req.params.reference);
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  if (app.status !== 'awaiting_signature') {
    return res.status(400).json({ error: `Application is not awaiting signature (status: ${app.status}).` });
  }
  if (typedFullName.trim().toLowerCase() !== app.fullName.trim().toLowerCase()) {
    return res.status(400).json({ error: 'Typed name must match the name on the application.' });
  }

  const signedAt = new Date();
  const reconsiderationDeadline = addBusinessDays(signedAt, RECONSIDERATION_DAYS);

  const updated = await db.update(
    'applications',
    (a) => a.reference === req.params.reference,
    (a) => ({
      ...a,
      status: 'active',
      signature: {
        typedFullName,
        signedAt: signedAt.toISOString(),
        ip: req.ip,
      },
      reconsiderationDeadline: reconsiderationDeadline.toISOString(),
    })
  );

  res.json({
    reference: updated.reference,
    status: updated.status,
    reconsiderationDeadline: updated.reconsiderationDeadline,
    message: `Signed and active! R${updated.requestedAmount} is on its way. Reference ${updated.reference}. You can cancel at no cost until ${reconsiderationDeadline.toLocaleDateString('en-ZA')} — just message us.`,
  });
}));

// GET /api/applications/:reference/pre-agreement.pdf — downloadable pre-agreement
// statement, available once the automated decision has approved the loan.
router.get('/:reference/pre-agreement.pdf', asyncHandler(async (req, res) => {
  const app = await db.find('applications', (a) => a.reference === req.params.reference);
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  if (!['awaiting_signature', 'active'].includes(app.status)) {
    return res.status(400).json({ error: 'Pre-agreement statement is only available once an offer has been approved.' });
  }
  streamPreAgreementPDF(res, app, RECONSIDERATION_DAYS);
}));

// POST /api/applications/:reference/cancel — exercise the reconsideration
// right. Real deployments should also reverse any disbursement/collections
// already scheduled — that logic belongs in the collections module (see
// docs/ARCHITECTURE.md).
router.post('/:reference/cancel', asyncHandler(async (req, res) => {
  const app = await db.find('applications', (a) => a.reference === req.params.reference);
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  if (app.status !== 'active') {
    return res.status(400).json({ error: `Only an active, signed loan can be cancelled this way (status: ${app.status}).` });
  }
  if (app.reconsiderationDeadline && new Date() > new Date(app.reconsiderationDeadline)) {
    return res.status(400).json({ error: 'The reconsideration window has closed. Please contact Khula directly.' });
  }
  const updated = await db.update(
    'applications',
    (a) => a.reference === req.params.reference,
    (a) => ({
      ...a,
      status: 'cancelled',
      adminNotes: [...(a.adminNotes || []), { note: 'Cancelled by borrower within reconsideration window.', at: new Date().toISOString(), by: 'borrower' }],
    })
  );
  res.json({ reference: updated.reference, status: updated.status, message: 'Your loan has been cancelled at no cost. Nothing further will be collected.' });
}));

module.exports = router;
