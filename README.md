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
| KYC / identity verification (Smile ID) | 🔲 Stubbed — basic ID-number format check only. Wire in Smile ID before real disbursement. |
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

### Smile ID (KYC / identity verification)
Add a call in `server/routes/applications.js` right after the ID-number format check — Smile ID's ID-verification API takes the ID number + a selfie/document photo and returns a match confidence. Block disbursement (not just application creation) on a passing KYC result.

### SigniFlow (legally binding e-signature)
Replace the `POST /api/applications/:reference/sign` handler's typed-name capture with a SigniFlow envelope: generate the loan agreement PDF from the application data, send it to SigniFlow for signature, and use their webhook to flip the application to `active` once countersigned.

### Netcash DebiCheck (collections)
Once a loan is `active`, register a DebiCheck mandate via Netcash using the borrower's bank details, and schedule the recurring debit order for the agreed instalment date. This is a natural next module: `server/routes/collections.js`.

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

## 8. Deploying tonight

See `docs/DEPLOY.md` for a verified, cost-checked comparison of Render (free), Railway (~$5/mo), a small VPS (~$4-6/mo, best long-term value), and AWS EC2 — with step-by-step instructions for each and a straight recommendation for getting a live link up in the next 15 minutes. `render.yaml` and `railway.json` are already included so those two platforms deploy with minimal manual configuration.
