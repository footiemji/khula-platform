# Compliance checklist

*This document is engineering-side guidance, not legal advice. Have your NCR compliance officer / attorney review before this platform touches real money — this is the same caution any lender should apply regardless of who built the software.*

## National Credit Act / NCR

| Requirement | Status in this MVP |
|---|---|
| Affordability assessment before granting credit (Reg. 23A/23B) | ✅ Implemented as a rules engine (`server/lib/affordability.js`) — checks the FULL monthly cost (capital, interest, fees, and insurance together) against discretionary income, not just principal and interest. **Have your compliance officer confirm the exact ratios and statutory expense norms table match your NCR registration conditions.** |
| Pre-agreement statement & quotation | ✅ Auto-generated as a PDF (`server/lib/pdfAgreement.js`), downloadable before signature via `/api/applications/:reference/pre-agreement.pdf`. Now shows a full cost-of-credit breakdown — interest, initiation fee, monthly service fee, insurance, total cost of credit, total repayable — not just an estimated instalment. **Have compliance confirm the exact required wording, fee breakdown, and format before relying on this document.** |
| Interest and fee caps | ✅ Implemented in `server/lib/costOfCredit.js`, defaulting to the published NCA maximums for short-term credit transactions (confirmed against NCR/legal-industry sources in 2026): 5%/month interest on a first loan, 3%/month on a repeat loan, initiation fee of R165 + 10% of the amount over R1,000 (capped at R1,050), and a monthly service fee capped at R60. **These regulations are reviewed periodically by the dti/NCR — confirm current figures before relying on them, and note the engine only implements the short-term credit bracket (≤R8,000); loans above that use a different, repo-rate-linked formula this MVP does not implement and flags for manual compliance review instead (`aboveShortTermCreditCeiling` on the quotation).** |
| Cooling-off / right to rescind | ✅ A configurable reconsideration window (`RECONSIDERATION_DAYS`, default 5 business days) opens on signature; borrowers can self-cancel at no cost via `/api/applications/:reference/cancel` until the deadline. **This is a policy default, not a confirmed statutory citation — have compliance confirm what right actually applies to your credit agreements and adjust the wording/window accordingly.** |
| Credit life insurance disclosure | ✅ Implemented, capped at R4.50 per R1,000 of the *outstanding* balance per month (the more consumer-protective declining-balance interpretation, matching the NCR's stated opinion on Regulation 3(1) — see `server/lib/costOfCredit.js`). Shown broken out per month and as a term total in the pre-agreement PDF. **Confirm this matches your actual credit life insurance product's terms and that the insurer/policy details are properly disclosed — this MVP calculates the cost but doesn't manage an actual insurance policy or claims process.** |
| Reckless lending prevention | ✅ Automated decline / manual-review routing when affordability fails, rather than allowing an override by default. Manual overrides in the admin console are logged (`adminNotes`) but should require a documented reason in production. |
| Registration as a credit provider | Confirm current NCR registration status independently before any live lending — this MVP does not verify or display real-time registration status. |
| Identity verification (KYC) | ✅ Working document collection (ID, proof of address, proof of income, proof of bank account) with mandatory human review, a manual credit bureau/underwriting check, and phone number verification (OTP) before signing unlocks — see "What KYC actually is here" below. |
| Payout to the correct person | ✅ Applicants must provide and prove a payout bank account, and admin review explicitly confirms the account is in the applicant's own name before signing unlocks — closing the specific fraud pattern of applying with someone else's identity documents but a different payout account. An automated name-match hint (`payoutNameLooselyMatches`) flags likely mismatches for the reviewer; final judgment stays human. |

## What KYC actually is here — and what it isn't

Borrowers upload four documents (ID, proof of address, proof of income, proof of bank account) through a dedicated upload page. Files are validated by their actual content, not just filename or claimed type (so a renamed file can't slip through), encrypted with AES-256-GCM before being written to disk, and never auto-approved — signing stays locked until an admin reviews the documents, confirms all four checks (identity, address, employment, payout account), and has recorded a credit bureau/underwriting check. Every document view and every verify/reject decision is timestamped and logged (`kyc.auditLog`) against the admin who made it.

Two fraud patterns are specifically addressed:
- **Applying with someone else's identity documents.** Web applicants must verify a one-time code sent to the phone number they entered (`server/lib/otp.js`) before an application can even be created — this doesn't prove the documents are genuine, but it does mean whoever is applying controls the phone number tied to the application, which is a real barrier against opportunistic misuse of someone else's stolen or found documents. WhatsApp applicants skip this step because messaging FROM a number is itself equivalent proof of control.
- **Disbursing to the wrong account.** The payout bank account is collected, proof of it is uploaded, and admin review must explicitly confirm the account is in the applicant's own name. An automated loose name-match (`payoutNameLooselyMatches` on the application record) flags likely mismatches for the reviewer's attention — it is a hint, not a verdict; the human decision is what actually gates signing.

**What this is not:** biometric identity verification. It doesn't check whether the ID document is genuine (hologram/security-feature detection), doesn't match a selfie against the ID photo, and doesn't run a liveness check to confirm a real person is present. Those require a real API like Smile ID, and Anthropic (or any AI system) can't credibly fake that verification — building a convincing-looking auto-pass would be actively dangerous for a lender, so this deliberately routes to a human instead. Wiring in real Smile ID verification is a natural next step (see README §4) once you have API credentials; the human-review gate this ships with is a legitimate control on its own and is how many micro-lenders operate even after adding automated checks, as a fallback for edge cases.

**What the OTP does and doesn't prove:** it proves control of a phone number at the moment of application, delivered via WhatsApp (so it also depends on `WHATSAPP_ACCESS_TOKEN` being configured for real delivery — see README §4). It does not verify the applicant's identity, and a determined fraudster who controls both a phone number and someone else's documents would still pass this check — it closes one specific gap (applying under a number you don't control), not the whole identity-fraud problem. Real biometric verification (Smile ID) is what closes the rest.

**Document retention:** uploaded documents currently persist indefinitely once uploaded. Define a retention/deletion policy (e.g. delete documents for declined applications after N days) before handling real applicants at volume — see the POPIA data retention row below.

## POPIA

| Requirement | Status |
|---|---|
| Explicit, informed consent before processing | ✅ Required field (`popiaConsent`) — applications cannot be created without it, and consent is timestamped. |
| Purpose limitation | Application data is only used for affordability/risk assessment in this MVP. Document any secondary use (marketing, credit bureau reporting) and get separate consent for it. |
| Right of access / correction / deletion | 🔲 Not yet implemented as self-service. Add a data-subject request process, even if manual at first. |
| Data minimisation | ID numbers are not echoed back in API responses (`GET /api/applications/:reference` strips it) — extend this principle to any new fields you add. |
| Security safeguards | Application data uses the JSON file store or Postgres (see `docs/DATABASE.md`); uploaded KYC documents are encrypted at rest with AES-256-GCM (`server/lib/fileEncryption.js`) and only accessible to authenticated admins. **Still confirm transport security (HTTPS in production — see `docs/DEPLOY.md`) and consider a managed secrets store for `KYC_ENCRYPTION_KEY` and `JWT_SECRET` beyond a plain `.env` file.** |
| Data retention & disposal policy | 🔲 Uploaded documents and application records currently persist indefinitely. Define and automate a retention/deletion schedule — e.g. delete documents for declined applications after N days, and anonymise or purge application records past your regulatory retention requirement. **This same gap is flagged directly in `public/privacy.html`'s retention section, which needs a real policy filled in before that page is treated as final.** |
| Public privacy policy | ✅ Draft published at `/privacy.html`, grounded in what the platform actually collects (see the page itself for the full breakdown). **Several fields are placeholders** — company registration number, registered address, contact details, and the retention schedule above — clearly marked `[in brackets]` in the page source. Fill these in and have the whole policy reviewed by an attorney before relying on it as your actual public-facing policy, the same as every other compliance document in this platform. |
| Information Officer registration | Confirm Khula's Information Officer is registered with the Information Regulator independently of this software. |

## Credit bureau reporting

Once live, loans typically need to be reported to registered credit bureaus (monthly). This isn't built yet — it's a natural next module once you have a real disbursement and repayment pipeline (`server/routes/collections.js` in the roadmap).

## Suggested compliance-related next steps

1. Get the affordability ratios and risk-scoring weights formally signed off by your compliance function — they're intentionally isolated in two small files so this review is easy.
2. Define and automate a document/data retention policy before real applicant volume — see the retention row above.
3. Commission a POPIA data protection impact assessment, particularly covering the KYC document upload and storage flow.
4. Document your credit bureau reporting process and vendor before scaling loan volume.
5. When ready to move beyond human-reviewed KYC, evaluate Smile ID (or equivalent) for automated biometric/document-authenticity checks — wire it in alongside, not instead of, the existing human review gate until you've validated its accuracy for your applicant base.
