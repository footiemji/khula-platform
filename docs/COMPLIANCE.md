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

## POPIA

| Requirement | Status |
|---|---|
| Explicit, informed consent before processing | ✅ Required field (`popiaConsent`) — applications cannot be created without it, and consent is timestamped. |
| Purpose limitation | Application data is only used for affordability/risk assessment in this MVP. Document any secondary use (marketing, credit bureau reporting) and get separate consent for it. |
| Right of access / correction / deletion | 🔲 Not yet implemented as self-service. Add a data-subject request process, even if manual at first. |
| Data minimisation | ID numbers are not echoed back in API responses (`GET /api/applications/:reference` strips it) — extend this principle to any new fields you add. |
| Security safeguards | The MVP stores data in plain JSON files locally — **encrypt data at rest and restrict access before any real personal information touches this system.** See README §5. |
| Data retention & disposal policy | 🔲 Not yet implemented — define and automate a retention schedule for declined/inactive applications. |
| Information Officer registration | Confirm Khula's Information Officer is registered with the Information Regulator independently of this software. |

## Credit bureau reporting

Once live, loans typically need to be reported to registered credit bureaus (monthly). This isn't built yet — it's a natural next module once you have a real disbursement and repayment pipeline (`server/routes/collections.js` in the roadmap).

## Suggested compliance-related next steps

1. Get the affordability ratios and risk-scoring weights formally signed off by your compliance function — they're intentionally isolated in two small files so this review is easy.
2. Add the pre-agreement statement and cooling-off flow before any real disbursement.
3. Commission a POPIA data protection impact assessment before moving off local JSON storage.
4. Document your credit bureau reporting process and vendor before scaling loan volume.
