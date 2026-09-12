// Expires applications that have sat unresolved too long — this is what
// actually makes the duplicate-application block (server/lib/hardGates.js)
// workable in practice: without an expiry, someone who started an
// application, got distracted, and never finished it would be permanently
// blocked from ever applying again, since their old application would
// never leave a non-terminal status. 24 hours is deliberately generous
// for a genuine applicant to finish uploading documents, while short
// enough that abandoned attempts clear out quickly rather than piling up.

const db = require('./db');
const { sendWhatsAppMessage } = require('./whatsappSender');
const { toWhatsAppFormat } = require('./phoneFormat');
const { logNotification } = require('./notificationLog');

const EXPIRY_HOURS = Number(process.env.APPLICATION_EXPIRY_HOURS || 24);

// Only genuinely non-terminal, non-time-critical statuses expire.
// Deliberately NOT 'awaiting_signature' — once someone's been through
// full KYC and seen a real quote, silently expiring that under them
// feels like a bait-and-switch, not a flood-prevention measure. If a
// signed-quote customer goes quiet, that's a collections/follow-up
// question, not an auto-expiry one.
const EXPIRABLE_STATUSES = ['pending_kyc', 'manual_review'];

async function runApplicationExpirySweep() {
  const applications = await db.readAll('applications');
  const now = new Date();
  const results = { expired: 0, errors: [] };

  for (const app of applications) {
    if (!EXPIRABLE_STATUSES.includes(app.status)) continue;

    const ageHours = (now - new Date(app.createdAt)) / (1000 * 60 * 60);
    if (ageHours < EXPIRY_HOURS) continue;

    try {
      await db.update('applications', (a) => a.reference === app.reference, (a) => ({
        ...a,
        status: 'expired',
        adminNotes: [...(a.adminNotes || []), { note: `Auto-expired after ${EXPIRY_HOURS} hours with no resolution.`, at: now.toISOString(), by: 'system' }],
      }));

      const message = `Hi ${app.fullName.split(' ')[0]}, your Khula application (${app.reference}) has expired since we didn't hear back within ${EXPIRY_HOURS} hours. No problem — you're welcome to apply again anytime.`;
      const delivered = await sendWhatsAppMessage(toWhatsAppFormat(app.phoneNumber), message);
      await logNotification(app.reference, { type: 'application_expired', message, sentBy: 'system', delivered });

      results.expired += 1;
    } catch (err) {
      results.errors.push(err.message);
    }
  }

  return results;
}

module.exports = { runApplicationExpirySweep, EXPIRY_HOURS, EXPIRABLE_STATUSES };
