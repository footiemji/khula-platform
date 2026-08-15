// DebiCheck mandate initiation stub. DebiCheck mandates aren't confirmed by
// a form on our site — the bank account holder approves them electronically
// THROUGH THEIR OWN BANK (via banking app, USSD, or card-present at a
// terminal), triggered by a request our System Operator (Netcash, Stitch,
// or similar accredited provider) sends to their bank. This module is
// where that request gets sent once you have real credentials.
//
// Until NETCASH_SERVICE_KEY / NETCASH_ACCOUNT_NUMBER (or an equivalent
// Stitch API key) are configured, this logs what would be sent and returns
// a synthetic "pending" status so you can test the surrounding application
// flow (admin trigger button, status tracking) without a live account.
//
// Two real providers worth evaluating, both PASA-accredited System
// Operators:
//   - Netcash: established, already in Khula's original tech stack.
//     https://api.netcash.co.za/inbound-payments/dc/
//   - Stitch: newer, API-first, supports card-present mandate signing at a
//     physical point of sale — relevant if the spaza-shop-assisted
//     application flow happens. https://stitch.money/payment-methods/debicheck
// Neither is wired up here — this is intentionally provider-agnostic so you
// can plug in whichever you choose without restructuring the application
// flow around it.

const { v4: uuidv4 } = require('uuid');

function isConfigured() {
  return Boolean(process.env.NETCASH_SERVICE_KEY && process.env.NETCASH_ACCOUNT_NUMBER);
}

/**
 * Initiates a DebiCheck mandate for a signed, active loan. Returns a mandate
 * reference and a status the application record can track.
 */
async function initiateMandate({ reference, accountHolder, bankName, accountNumber, branchCode, instalmentAmount, instalmentDay }) {
  const mandateReference = `DC-${reference}-${uuidv4().slice(0, 8).toUpperCase()}`;

  if (!isConfigured()) {
    console.log(
      `[DebiCheck STUB] Would send mandate request:`,
      { mandateReference, accountHolder, bankName, accountNumber: `****${String(accountNumber).slice(-4)}`, branchCode, instalmentAmount, instalmentDay }
    );
    return {
      ok: true,
      mandateReference,
      status: 'mandate_sent',
      note: 'NETCASH_SERVICE_KEY not configured — this is a simulated mandate. No real request was sent to any bank.',
    };
  }

  // TODO: real Netcash NIWS_NIF DebiCheck batch submission (or Stitch's
  // mandate API if you choose that provider instead) goes here once you
  // have live credentials. The response should be mapped to the same
  // { ok, mandateReference, status } shape so nothing downstream changes.
  throw new Error('Real DebiCheck integration not yet implemented — NETCASH_SERVICE_KEY is set but no provider call has been wired in.');
}

module.exports = { initiateMandate, isConfigured };
