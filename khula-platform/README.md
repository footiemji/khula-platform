# Khula Financial Services — WhatsApp-Forward Micro-Loan Platform

*Grow. Thrive. Rise.*

A working MVP for a disruptive, radically simple micro-lending platform: a WhatsApp-native conversational loan application, instant explainable affordability + risk decisioning, e-signature capture, and a lender-side admin console — built to be **boringly reliable in the plumbing and refreshingly simple in the experience**.

This zip is a real, runnable app (Node.js + a lightweight file-based store, zero external services required to demo it end to end). Every place where it stubs a third-party integration is clearly marked with a `TODO` and instructions, so you can wire in your actual credentials without re-architecting anything.

---

## 1. Quick start (2 minutes)

```bash
cd khula-platform
npm install
cp .env.example .env
npm run seed:admin -- "YourStrongPassword123!"   # copy the printed hash into .env as ADMIN_PASSWORD_HASH
npm start
```

Then open:
- **Borrower app:** http://localhost:3000/ — the WhatsApp-style chat widget, fully functional against the real backend
- **Admin console:** http://localhost:3000/admin.html — log in with `ADMIN_EMAIL` from `.env` and the password you just seeded
- **Agent console:** http://localhost:3000/agent.html — for shop staff/field agents submitting applications on behalf of a customer. Create an agent first from the admin console's "Agents" tab (or `POST /api/admin/agents`), which generates an agent code and takes a PIN you set — hand those to the agent to log in.

No database server or build step required to try it. To run it in Docker instead:

```bash
docker compose up --build
```

Your data persists in a named Docker volume (`khula-data`) across restarts.

---

## 2. What's actually functional right now

| Capability | Status |
|---|---|
| Conversational loan application (web widget) | ✅ Fully working, hits the real API |
| Conversational loan application (WhatsApp) | ✅ Code complete — needs your Meta WhatsApp Business credentials to send live messages (see §4) |
| Instant affordability assessment (NCR-style) | ✅ Working rules engine, see `server/lib/affordability.js` |
| Explainable risk scoring | ✅ Working, transparent rules engine, see `server/lib/riskScore.js` |
| POPIA consent capture + logging | ✅ Working, timestamped on every application |
| E-signature capture | ✅ Working simulation (typed name + timestamp + IP). Swap for SigniFlow for a legally binding signature — see §4 |
| Pre-agreement statement (PDF) | ✅ Working — auto-generated per application, downloadable before signature |
| Reconsideration / cooling-off window | ✅ Working — configurable window after signature, with a self-service cancel endpoint |
| Admin console (approve/decline, stats) | ✅ Fully working |
| One-command deploy (Docker) | ✅ `docker compose up --build` |
| Swappable Postgres backend | ✅ Set `DATABASE_URL` in `.env` to switch from the zero-setup JSON file store to Postgres — same interface, tested against both. See `docs/DATABASE.md` |
| Data storage | ✅ File-based JSON store for the MVP — swap for Postgres/DynamoDB in one file (`server/lib/db.js`) when you scale |
| KYC / identity verification | ✅ Working document upload (ID, proof of address, proof of income, proof of bank account), encrypted at rest, gated behind mandatory human admin review before signing unlocks. Not biometric/automated — see `docs/COMPLIANCE.md`. |
| Phone number verification (OTP) | ✅ Working — web applicants must verify a 6-digit code sent via WhatsApp before an application can be created, closing the gap where someone could apply using a phone number they don't control. WhatsApp applicants skip this (the channel itself proves phone control). |
| Payout account verification | ✅ Working — applicants must provide payout bank details, upload proof of the account, and the admin review explicitly confirms the account is in the applicant's name before signing unlocks. A loose automated name-match hint flags likely mismatches for the reviewer. |
| Full cost-of-credit quotation | ✅ Working — interest, initiation fee, monthly service fee, and credit life insurance (correctly declining on the outstanding balance) shown as a full month-by-month breakdown, grounded in the actual NCA maximum caps. See `docs/COMPLIANCE.md` for the exact figures and citations. |
| Manual credit bureau / underwriting check | ✅ Working — admin records employment, credit record, and judgments/defaults findings; KYC verification is blocked until this is recorded. Manual for now — see §4 for wiring in a real bureau API. |
| DebiCheck mandate initiation | ✅ Stubbed the same way as WhatsApp sending — logs what would be sent until real Netcash/Stitch credentials are configured. See `server/lib/debicheck.js` and §4. |
| Agent-assisted applications (spaza-shop flow) | ✅ Working — a dedicated form-based console (`public/agent.html`) for shop staff/field agents to submit applications on behalf of a physically-present customer, with its own PIN login, mandatory OTP verification of the *customer's* phone, an explicit customer-present confirmation gate, and full state reset between customers on shared devices. Every application is tagged with which agent/shop facilitated it. See `docs/VISION.md` for the design reasoning. |
| Debit order collection (Netcash DebiCheck) | 🔲 Not yet built — see §4 |
| Accounting sync (Xero) | 🔲 Not yet built — see §4 |

---

## 3. Architecture

```
Borrower on WhatsApp  ──┐
                         ├──> Express API ──> Affordability engine ──┐
Borrower on web widget ─┘         │            Risk scoring engine   ├──> Decision + JSON store
                                   │                                  │
                          Admin console <──────────────────────────┘
```

- **`server/index.js`** — Express app, security middleware (helmet, rate limiting, CORS), route mounting.
- **`server/routes/applications.js`** — public API for creating and signing applications (used by the web widget).
- **`server/routes/whatsapp.js`** — Meta WhatsApp Cloud API webhook + a self-contained conversation state machine that walks a borrower through the same fields, one message at a time.
- **`server/routes/admin.js`** — JWT-authenticated lender console API.
- **`server/lib/affordability.js`** — NCR-style affordability engine (instalment-to-income ratio + discretionary income buffer).
- **`server/lib/riskScore.js`** — transparent, explainable rules-based risk score (swap for a bureau-scorecard model later without touching anything downstream).
- **`server/lib/db.js`** — the facade every route talks to (`insert/find/update/filter/readAll`, all async). It picks a backend based on whether `DATABASE_URL` is set, so nothing outside this file needs to know or care.
- **`server/lib/db.file.js`** — zero-setup JSON file backend, used when `DATABASE_URL` is unset.
- **`server/lib/db.postgres.js`** — Postgres backend, used when `DATABASE_URL` is set. Same interface, tested against both a local Postgres instance and the file store to confirm identical behavior.
- **`public/`** — the borrower landing page + chat widget, and the admin dashboard. Plain HTML/CSS/JS — no build step, no framework lock-in, easy for any web dev to pick up.

See `docs/ARCHITECTURE.md` for more detail and a suggested production topology.

---

## 4. Making it real: wiring in production services

### WhatsApp Business Cloud API (Meta)
1. Create a Meta developer app and a WhatsApp Business Account.
2. Set `WHATSAPP_VERIFY_TOKEN` in `.env` to any string you choose, and register `https://your-domain.com/api/whatsapp/webhook` as the webhook URL in the Meta dashboard with that same token.
3. Generate a permanent access token and set `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`.
4. That's it — `server/routes/whatsapp.js` already calls the Graph API `/messages` endpoint once those two variables are set; until then it logs outbound messages to the console so you can test the conversation flow locally.

### Smile ID (automated KYC, on top of the existing human review)
The MVP already gates signing behind document upload + mandatory human review (see `docs/COMPLIANCE.md`). To add automated biometric/document-authenticity checks on top: call Smile ID's verification API when documents are uploaded in `server/routes/applications.js` (`POST /:reference/documents`), store the match confidence on `application.kyc`, and surface it in the admin review panel (`public/js/admin.js`) so your reviewer sees both the automated score and the documents themselves — keep the human gate rather than replacing it, at least until you've validated Smile ID's accuracy for your applicant base.

### SigniFlow (legally binding e-signature)
Replace the `POST /api/applications/:reference/sign` handler's typed-name capture with a SigniFlow envelope: generate the loan agreement PDF from the application data, send it to SigniFlow for signature, and use their webhook to flip the application to `active` once countersigned.

### DebiCheck collections (Netcash or Stitch)
The collection layer already exists — `server/lib/debicheck.js` builds the mandate request and logs what it would send; `application.collections` tracks `debicheckStatus`; the admin console has a "Start DebiCheck" button on active loans (`POST /api/admin/applications/:reference/debicheck`). Wiring in a real provider means implementing the `TODO` inside `initiateMandate()` with an actual API call — the function signature and return shape are already what the rest of the app expects, so nothing else needs to change.

Two accredited PASA System Operators worth evaluating:
- **Netcash** — established, already in Khula's original tech stack. [Docs](https://api.netcash.co.za/inbound-payments/dc/)
- **Stitch** — newer, API-first, and notably supports card-present mandate signing at a physical point of sale, which is directly relevant if the spaza-shop-assisted application flow (see `docs/VISION.md`) happens. [Docs](https://stitch.money/payment-methods/debicheck)

Neither is wired up by default — `debicheck.js` is intentionally provider-agnostic.

### Credit bureau (XDS, TransUnion, CompuScan, Experian)
The manual bureau/underwriting check (`POST /api/admin/applications/:reference/underwriting`) is deliberately isolated to one endpoint and one object shape (`application.underwriting`) so swapping the manual entry for a real bureau API call is contained — call the bureau API when KYC review starts, populate the same fields (`employmentConfirmed`, `creditRecordClean`, `judgmentsOrDefaultsFound`) from the response, and set `bureauChecked: true` automatically instead of requiring the admin to tick it. The admin review panel already displays whatever's in this object, so the UI doesn't need to change either.

### Xero (accounting)
Sync disbursements and repayments to Xero via their API for clean books from day one — useful both for your own operations and for due diligence if you're raising or being acquired (see `docs/ACQUISITION_READINESS.md`).

---

## 5. Security notes for going to production

- Change `JWT_SECRET` and re-seed the admin password before any real deployment.
- Put this behind HTTPS (e.g. via a reverse proxy or your hosting platform) — never run the login/application endpoints over plain HTTP in production.
- The file-based store in `server/data/` is fine for a demo; move to a real database with encryption at rest before handling real ID numbers and financial data.
- Add audit logging for every admin decision (the `adminNotes` field is a starting point — extend it to an append-only log).
- Rotate the WhatsApp and third-party API keys via a secrets manager rather than a plain `.env` file once you're live.

---

## 6. Compliance

This MVP is built with NCR affordability principles and POPIA consent handling in mind, but **it is not a substitute for sign-off from your compliance officer or attorney**. See `docs/COMPLIANCE.md` for a checklist mapped to what's implemented vs. what still needs a human compliance review before you lend real money.

---

## 7. On being acquisition-ready

You mentioned wanting Khula to be attractive to larger financial institutions without selling. `docs/ACQUISITION_READINESS.md` covers the non-technical groundwork (clean IP ownership, data room hygiene, unit economics, compliance posture) that acquirers actually diligence — the code alone doesn't make a company acquirable, but a clean, well-documented, API-first codebase like this one removes a common blocker.

---

## 8. Where this goes next

`docs/VISION.md` addresses the harder question directly: how does this stay genuinely responsible lending — proper underwriting, fair collections, fraud prevention — as it gets faster and moves toward an agent-assisted, spaza-shop-speed experience for salary-advance customers, rather than becoming "just technology" the way Wonga.com was. Worth reading before scaling into that higher-vulnerability customer segment.

## 9. Deploying tonight

See `docs/DEPLOY.md` for a verified, cost-checked comparison of Render (free), Railway (~$5/mo), a small VPS (~$4-6/mo, best long-term value), and AWS EC2 — with step-by-step instructions for each and a straight recommendation for getting a live link up in the next 15 minutes. `render.yaml` and `railway.json` are already included so those two platforms deploy with minimal manual configuration.
