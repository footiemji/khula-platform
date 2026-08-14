# Compliance checklist

*This document is engineering-side guidance, not legal advice. Have your NCR compliance officer / attorney review before this platform touches real money — this is the same caution any lender should apply regardless of who built the software.*

## National Credit Act / NCR

| Requirement | Status in this MVP |
|---|---|
| Affordability assessment before granting credit (Reg. 23A/23B) | ✅ Implemented as a rules engine (`server/lib/affordability.js`) — instalment-to-income ratio + discretionary income buffer. **Have your compliance officer confirm the exact ratios and statutory expense norms table match your NCR registration conditions.** |
| Pre-agreement statement & quotation | ✅ Auto-generated as a PDF (`server/lib/pdfAgreement.js`), downloadable before signature via `/api/applications/:reference/pre-agreement.pdf`. **Have compliance confirm the exact required wording, fee breakdown, and format before relying on this document.** |
| Cooling-off / right to rescind | ✅ A configurable reconsideration window (`RECONSIDERATION_DAYS`, default 5 business days) opens on signature; borrowers can self-cancel at no cost via `/api/applications/:reference/cancel` until the deadline. **This is a policy default, not a confirmed statutory citation — have compliance confirm what right actually applies to your credit agreements and adjust the wording/window accordingly.** |
| Credit life insurance disclosure | 🔲 Not yet implemented — add if you offer/require credit life insurance. |
| Reckless lending prevention | ✅ Automated decline / manual-review routing when affordability fails, rather than allowing an override by default. Manual overrides in the admin console are logged (`adminNotes`) but should require a documented reason in production. |
| Registration as a credit provider | Confirm current NCR registration status independently before any live lending — this MVP does not verify or display real-time registration status. |
| Identity verification (KYC) | ✅ Working document collection (ID, proof of address, proof of income) with mandatory human review before signing unlocks — see "What KYC actually is here" below. |

## What KYC actually is here — and what it isn't

Borrowers upload three documents (ID, proof of address, proof of income) through a dedicated upload page. Files are validated by their actual content, not just filename or claimed type (so a renamed file can't slip through), encrypted with AES-256-GCM before being written to disk, and never auto-approved — signing stays locked until an admin reviews the documents and confirms all three checks in the admin console. Every document view and every verify/reject decision is timestamped and logged (`kyc.auditLog`) against the admin who made it.

**What this is not:** biometric identity verification. It doesn't check whether the ID document is genuine (hologram/security-feature detection), doesn't match a selfie against the ID photo, and doesn't run a liveness check to confirm a real person is present. Those require a real API like Smile ID, and Anthropic (or any AI system) can't credibly fake that verification — building a convincing-looking auto-pass would be actively dangerous for a lender, so this deliberately routes to a human instead. Wiring in real Smile ID verification is a natural next step (see README §4) once you have API credentials; the human-review gate this ships with is a legitimate control on its own and is how many micro-lenders operate even after adding automated checks, as a fallback for edge cases.

**Document retention:** uploaded documents currently persist indefinitely once uploaded. Define a retention/deletion policy (e.g. delete documents for declined applications after N days) before handling real applicants at volume — see the POPIA data retention row below.

## POPIA

| Requirement | Status |
|---|---|
| Explicit, informed consent before processing | ✅ Required field (`popiaConsent`) — applications cannot be created without it, and consent is timestamped. |
| Purpose limitation | Application data is only used for affordability/risk assessment in this MVP. Document any secondary use (marketing, credit bureau reporting) and get separate consent for it. |
| Right of access / correction / deletion | 🔲 Not yet implemented as self-service. Add a data-subject request process, even if manual at first. |
| Data minimisation | ID numbers are not echoed back in API responses (`GET /api/applications/:reference` strips it) — extend this principle to any new fields you add. |
| Security safeguards | Application data uses the JSON file store or Postgres (see `docs/DATABASE.md`); uploaded KYC documents are encrypted at rest with AES-256-GCM (`server/lib/fileEncryption.js`) and only accessible to authenticated admins. **Still confirm transport security (HTTPS in production — see `docs/DEPLOY.md`) and consider a managed secrets store for `KYC_ENCRYPTION_KEY` and `JWT_SECRET` beyond a plain `.env` file.** |
| Data retention & disposal policy | 🔲 Uploaded documents and application records currently persist indefinitely. Define and automate a retention/deletion schedule — e.g. delete documents for declined applications after N days, and anonymise or purge application records past your regulatory retention requirement. |
| Information Officer registration | Confirm Khula's Information Officer is registered with the Information Regulator independently of this software. |

## Credit bureau reporting

Once live, loans typically need to be reported to registered credit bureaus (monthly). This isn't built yet — it's a natural next module once you have a real disbursement and repayment pipeline (`server/routes/collections.js` in the roadmap).

## Suggested compliance-related next steps

1. Get the affordability ratios and risk-scoring weights formally signed off by your compliance function — they're intentionally isolated in two small files so this review is easy.
2. Define and automate a document/data retention policy before real applicant volume — see the retention row above.
3. Commission a POPIA data protection impact assessment, particularly covering the KYC document upload and storage flow.
4. Document your credit bureau reporting process and vendor before scaling loan volume.
5. When ready to move beyond human-reviewed KYC, evaluate Smile ID (or equivalent) for automated biometric/document-authenticity checks — wire it in alongside, not instead of, the existing human review gate until you've validated its accuracy for your applicant base.
