# Building toward acquisition-readiness

You want Khula to be attractive to larger financial institutions as an acquisition target, without selling prematurely. That outcome is mostly built through operating discipline over time — code alone won't get you there — but the technical foundation matters more than founders often expect. Notes below are general practice, not financial or legal advice; validate the M&A-specific points with an advisor when the time comes.

## What acquirers in fintech typically diligence

1. **Clean IP ownership.** Every contributor (including any freelancers or agencies) should have signed IP assignment. Keep a simple register of who wrote what, from day one.
2. **Regulatory standing.** Active NCR registration in good standing, POPIA compliance documentation, and a clean complaints/regulatory history are often bigger value drivers than the tech stack itself.
3. **Auditable decisioning.** Because lending decisions can be scrutinised retrospectively (regulator, court, or acquirer due diligence), an explainable, logged decision trail — which this MVP's rules-based affordability/risk engines already provide — is worth more than a marginally more accurate black-box model that can't explain itself.
4. **Unit economics clarity.** Cost per acquired borrower, default rate by cohort, and loan-level profitability need to be trackable from early on. Instrument this now (the admin `stats` endpoint is a starting point) rather than reconstructing it under diligence pressure later.
5. **Data room hygiene.** Financial statements (Xero from day one helps here), cap table, material contracts, and compliance certificates organised and current — most of this is operational discipline, not code.
6. **Technical integration ease.** An API-first architecture (which this is — the affordability/risk/decision logic is decoupled from both the WhatsApp and web front doors) makes it easier for an acquirer to fold Khula into an existing platform, which is often what makes a "buy" more attractive than a "build".
7. **Security posture.** Even before you need a SOC 2 report, having documented security practices (secrets management, encryption at rest, access logging) signals maturity. The README's production security checklist is a starting point.
8. **Customer contract assignability.** Loan agreements and any partner/vendor contracts should be written so they can transfer on an acquisition (or survive a change of control) without needing to renegotiate each one individually — worth a specific check with your attorney when your agreement templates are finalised.

## A practical near-term sequence

1. Get NCR registration and POPIA documentation fully in order (tracked in `docs/COMPLIANCE.md`).
2. Wire in real KYC (Smile ID), signature (SigniFlow), and collections (Netcash DebiCheck) so the platform can safely handle real disbursements at small scale.
3. Run a small, real loan book for long enough to generate genuine repayment/default data — this is the single most valuable asset for both fundraising and eventual acquisition conversations, more than the codebase itself.
4. Keep books clean in Xero from the first transaction.
5. Revisit this document annually as the business matures — acquirer expectations shift as you scale from pilot to a real loan book.
