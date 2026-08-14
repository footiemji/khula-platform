const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const db = require('../lib/db');
const { assessAffordability } = require('../lib/affordability');
const { scoreApplication, decide } = require('../lib/riskScore');
const { streamPreAgreementPDF } = require('../lib/pdfAgreement');
const { detectType } = require('../lib/fileType');
const { saveDocument } = require('../lib/documentStore');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 3 } });

const REQUIRED_DOCUMENT_TYPES = ['id_document', 'proof_of_address', 'proof_of_income'];

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
    status: outcome.decision === 'approved' ? 'pending_kyc' : outcome.decision,
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
    kyc: {
      status: outcome.decision === 'approved' ? 'awaiting_documents' : 'not_applicable',
      identityVerified: false,
      addressVerified: false,
      employmentVerified: false,
      documents: [],
      reviewedBy: null,
      reviewedAt: null,
      auditLog: [],
    },
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
  const base = process.env.PUBLIC_APP_URL || '';
  switch (decisionType) {
    case 'approved':
      return `Good news, ${record.fullName.split(' ')[0]}! You're pre-approved for R${record.requestedAmount} over ${record.termMonths} months (est. R${record.affordability.proposedInstalment}/month). Reference ${record.reference}.\n\nBefore we can pay out, we need 3 documents: a copy of your ID, proof of address, and proof of income (payslip or bank statement). Upload them here: ${base}/upload.html?ref=${record.reference}\n\nOur team reviews documents within 1 business day — you'll be notified here once you're cleared to sign.`;
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
  const { idNumber, kyc, ...safe } = app; // don't echo full ID number or internal file paths back over the wire
  const safeKyc = kyc && {
    status: kyc.status,
    identityVerified: kyc.identityVerified,
    addressVerified: kyc.addressVerified,
    employmentVerified: kyc.employmentVerified,
    documentsUploaded: (kyc.documents || []).map((d) => d.type),
    missingDocuments: REQUIRED_DOCUMENT_TYPES.filter((t) => !(kyc.documents || []).some((d) => d.type === t)),
  };
  res.json({ ...safe, kyc: safeKyc });
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

// POST /api/applications/:reference/documents — multipart upload of the 3
// required KYC documents (id_document, proof_of_address, proof_of_income).
// Files are validated by actual content (magic bytes), not by trusting the
// filename or Content-Type header, then encrypted before being written to
// disk. Nothing is auto-verified here — a human reviews and unlocks signing
// via the admin console (see server/routes/admin.js). See docs/COMPLIANCE.md
// for what real biometric/document-authenticity verification would add.
router.post(
  '/:reference/documents',
  upload.fields(REQUIRED_DOCUMENT_TYPES.map((type) => ({ name: type, maxCount: 1 }))),
  asyncHandler(async (req, res) => {
    const app = await db.find('applications', (a) => a.reference === req.params.reference);
    if (!app) return res.status(404).json({ error: 'Application not found.' });
    if (!['pending_kyc'].includes(app.status)) {
      return res.status(400).json({ error: `Documents can only be uploaded while an application is pending KYC review (status: ${app.status}).` });
    }

    const files = req.files || {};
    const uploadedTypes = Object.keys(files);
    if (uploadedTypes.length === 0) {
      return res.status(400).json({ error: `No files received. Expected one or more of: ${REQUIRED_DOCUMENT_TYPES.join(', ')}.` });
    }

    const newDocuments = [];
    const rejected = [];
    for (const type of uploadedTypes) {
      const file = files[type][0];
      const detected = detectType(file.buffer);
      if (!detected) {
        rejected.push({ type, reason: 'Unsupported or unrecognized file type. Only PDF, JPEG, and PNG are accepted.' });
        continue;
      }
      const { id, filename } = saveDocument(app.reference, file.buffer);
      newDocuments.push({
        id,
        type,
        originalName: (file.originalname || 'document').slice(0, 200),
        mimeType: detected.mime,
        sizeBytes: file.buffer.length,
        uploadedAt: new Date().toISOString(),
        storedFilename: filename,
      });
    }

    if (rejected.length) {
      return res.status(400).json({ error: 'Some files were rejected.', rejected, accepted: newDocuments.map((d) => d.type) });
    }

    const updated = await db.update(
      'applications',
      (a) => a.reference === req.params.reference,
      (a) => {
        const existingTypes = new Set((a.kyc.documents || []).map((d) => d.type));
        const documents = [...(a.kyc.documents || []).filter((d) => !newDocuments.some((n) => n.type === d.type)), ...newDocuments];
        const missing = REQUIRED_DOCUMENT_TYPES.filter((t) => !documents.some((d) => d.type === t));
        return {
          ...a,
          kyc: {
            ...a.kyc,
            documents,
            status: missing.length === 0 ? 'pending_review' : 'awaiting_documents',
          },
        };
      }
    );

    const missing = REQUIRED_DOCUMENT_TYPES.filter((t) => !updated.kyc.documents.some((d) => d.type === t));
    res.status(201).json({
      reference: updated.reference,
      uploaded: newDocuments.map((d) => d.type),
      missingDocuments: missing,
      kycStatus: updated.kyc.status,
      message:
        missing.length === 0
          ? "All 3 documents received — thanks! Our team will review within 1 business day and let you know when you're cleared to sign."
          : `Got it. Still needed: ${missing.join(', ')}.`,
    });
  })
);

// GET /api/applications/:reference/pre-agreement.pdf — downloadable pre-agreement
// statement, available once the automated decision has approved the loan.
router.get('/:reference/pre-agreement.pdf', asyncHandler(async (req, res) => {
  const app = await db.find('applications', (a) => a.reference === req.params.reference);
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  if (!['pending_kyc', 'awaiting_signature', 'active'].includes(app.status)) {
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
