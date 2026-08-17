// Sends payment reminders and post-payment thank-yous over WhatsApp.
//
// Cost note (read this before enabling in production): as of Meta's July
// 2025 pricing change, a WhatsApp message the business sends FIRST — like
// a payment reminder — is billed per message under the "Utility" category
// unless it falls inside an already-open 24-hour window that the customer
// started (i.e. they messaged Khula recently). There is no monthly free
// allowance for these anymore. A "payment received, thank you" reply sent
// in response to a DebiCheck collection is not free-by-default either,
// since the collection event isn't the customer messaging you — budget for
// these as a real per-message cost once WHATSAPP_ACCESS_TOKEN is live, and
// check developers.facebook.com/docs/whatsapp/pricing for current
// South Africa rates specifically, which change periodically.

const { sendWhatsAppMessage } = require('./whatsappSender');
const { toWhatsAppFormat } = require('./phoneFormat');

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long' });
}

async function sendUpcomingReminder(app, installment) {
  const phone = toWhatsAppFormat(app.phoneNumber);
  const firstName = app.fullName.split(' ')[0];
  const message = `Hi ${firstName}, this is a reminder that your Khula instalment of R${installment.amount.toFixed(2)} is due on ${formatDate(installment.dueDate)}. Reference ${app.reference}. Make sure there are sufficient funds in your account for the DebiCheck collection. Reply here if you need help.`;
  return sendWhatsAppMessage(phone, message);
}

async function sendOverdueNotice(app, installment) {
  const phone = toWhatsAppFormat(app.phoneNumber);
  const firstName = app.fullName.split(' ')[0];
  const message = `Hi ${firstName}, we weren't able to collect your Khula instalment of R${installment.amount.toFixed(2)} due ${formatDate(installment.dueDate)}. Reference ${app.reference}. Please reply here to arrange payment — we'd rather help you catch up than let this become a bigger problem.`;
  return sendWhatsAppMessage(phone, message);
}

// Sent periodically for an instalment that's STILL unpaid a while after the
// first overdue notice — deliberately not escalating in tone each time.
// Repeated aggressive contact (or worse, daily pings) is exactly the
// pattern that turns a manageable short-term default into a debt spiral —
// see docs/VISION.md's explicit commitment not to replicate that. This
// stops automatically after MAX_OVERDUE_REMINDERS (see
// collectionsSweep.js) — beyond that point, further contact should come
// through the human-driven legal escalation ladder, not an automated loop.
async function sendRepeatOverdueReminder(app, installment) {
  const phone = toWhatsAppFormat(app.phoneNumber);
  const firstName = app.fullName.split(' ')[0];
  const message = `Hi ${firstName}, just checking in — your Khula instalment of R${installment.amount.toFixed(2)} (reference ${app.reference}) is still outstanding. If you're going through a tough time, message us here and we can talk through options together. No judgment, just want to help you get back on track.`;
  return sendWhatsAppMessage(phone, message);
}

async function sendThankYou(app, installment, remaining) {
  const phone = toWhatsAppFormat(app.phoneNumber);
  const firstName = app.fullName.split(' ')[0];
  const message = remaining > 0
    ? `Thanks ${firstName}! We've received your payment of R${installment.amount.toFixed(2)}. You have ${remaining} instalment${remaining === 1 ? '' : 's'} left on this loan. Reference ${app.reference}.`
    : `Thanks ${firstName}! That was your final instalment — this loan is now fully paid off. 🎉 Well done, and thanks for being a Khula customer. Reference ${app.reference}.`;
  return sendWhatsAppMessage(phone, message);
}

// Sent once the DebiCheck mandate is confirmed and disbursement actually
// happens — deliberately NOT sent at loan signature, since signing the
// agreement and the bank confirming the debit order mandate are two
// separate things. See server/routes/admin.js mandate/confirm endpoint.
async function sendDisbursementConfirmation(app) {
  const phone = toWhatsAppFormat(app.phoneNumber);
  const firstName = app.fullName.split(' ')[0];
  const message = `Great news ${firstName} — your debit order mandate is confirmed, and R${app.requestedAmount} is on its way to your account now. Reference ${app.reference}. You can still cancel at no cost until your reconsideration window closes — just message us.`;
  return sendWhatsAppMessage(phone, message);
}

// Sent if the customer doesn't confirm the mandate at their bank (or
// declines it) — the loan stays signed but funds don't move until this is
// resolved, so the borrower needs to know something is actually blocking
// their payout, not just silence.
async function sendMandateDeclinedNotice(app) {
  const phone = toWhatsAppFormat(app.phoneNumber);
  const firstName = app.fullName.split(' ')[0];
  const message = `Hi ${firstName}, we weren't able to confirm your debit order mandate, so we haven't been able to release your funds yet. Reference ${app.reference}. Please message us here so we can sort this out together.`;
  return sendWhatsAppMessage(phone, message);
}

module.exports = { sendUpcomingReminder, sendOverdueNotice, sendRepeatOverdueReminder, sendThankYou, sendDisbursementConfirmation, sendMandateDeclinedNotice };
