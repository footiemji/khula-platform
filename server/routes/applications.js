const express = require('express');
const multer = require('multer');
const db = require('../lib/db');
const { streamPreAgreementPDF } = require('../lib/pdfAgreement');
const { detectType } = require('../lib/fileType');
const { saveDocument } = require('../lib/documentStore');
const { createApplication, signApplication, getPublicAppUrl } = require('../lib/applicationEngine');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 4 } });

const REQUIRED_DOCUMENT_TYPES = ['id_document', 'proof_of_address', 'proof_of_income', 'proof_of_bank_account'];

// Default reconsideration window (business days) — used in the pre-agreement
// PDF disclosure. The actual signing logic (which also uses this) now lives
// in server/lib/applicationEngine.js's signApplication(), shared with the
// WhatsApp status-check flow.
const RECONSIDERATION_DAYS = Number(process.env.RECONSIDERATION_DAYS || 5);

// POST /api/applications
// Creates a new loan application via the web widget. See
// server/lib/applicationEngine.js for the shared validation/decision logic
// used by this, the agent-assisted flow, and (in spirit) WhatsApp.
router.post('/', asyncHandler(async (req, res) => {
  const result = await createApplication(req.body, { channel: req.body?.channel || 'web', baseUrl: getPublicAppUrl() });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.status(201).json(result.response);
}));

// GET /api/applications/:reference — status check
router.get('/:reference', asyncHandler(async (req, res) => {
  const app = await db.find('applications', (a) => a.reference === req.params.reference);
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  const { idNumber, kyc, accountNumber, ...safe } = app; // strip ID number, KYC internals, and full account number
  const safeKyc = kyc && {
    status: kyc.status,
    identityVerified: kyc.identityVerified,
    addressVerified: kyc.addressVerified,
    employmentVerified: kyc.employmentVerified,
    payoutAccountVerified: kyc.payoutAccountVerified,
    documentsUploaded: (kyc.documents || []).map((d) => d.type),
    missingDocuments: REQUIRED_DOCUMENT_TYPES.filter((t) => !(kyc.documents || []).some((d) => d.type === t)),
  };
  res.json({ ...safe, accountNumberMasked: accountNumber ? `****${accountNumber.slice(-4)}` : null, kyc: safeKyc });
}));

// POST /api/applications/:reference/sign — simulated e-signature capture.
// Real deployments should route this through SigniFlow for a legally
// binding, audit-trailed signature (see docs/COMPLIANCE.md).
router.post('/:reference/sign', asyncHandler(async (req, res) => {
  const { typedFullName } = req.body || {};
  const result = await signApplication(req.params.reference, typedFullName, req.ip);
  if (!result.ok) return res.status(result.status).json({ error: result.error });

  const updated = result.application;
  res.json({
    reference: updated.reference,
    status: updated.status,
    reconsiderationDeadline: updated.reconsiderationDeadline,
    message: `Signed! Reference ${updated.reference}. Last step: we'll send a debit order mandate request to your bank — confirm it there (app, USSD, or however your bank does it), and your funds are released as soon as that's confirmed. You can cancel at no cost until ${result.reconsiderationDeadline.toLocaleDateString('en-ZA')} — just message us.`,
  });
}));

// POST /api/applications/:reference/documents — multipart upload of the 4
// required KYC documents (id_document, proof_of_address, proof_of_income,
// proof_of_bank_account — the last one confirms the payout account and
// must be in the applicant's name; the admin review checks this).
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
        rejected.push({ type, reason: 'Unsupported or unrecognized file type. Only PDF files are accepted.' });
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
          ? `All ${REQUIRED_DOCUMENT_TYPES.length} documents received — thanks! Our team will review within 1 business day and let you know when you're cleared to sign.`
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
