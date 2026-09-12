// Sends payment reminders and post-payment thank-yous over WhatsApp, and
// logs every one to the application's notificationHistory — a customer's
// full communication record lives in one place, whether the message was
// automated or sent manually by an admin (see server/routes/admin.js's
// notifications/send endpoint for the manual side).
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

const { sendWhatsAppMessage, sendWhatsAppDocument } = require('./whatsappSender');
const { toWhatsAppFormat } = require('./phoneFormat');
const { logNotification } = require('./notificationLog');
const { getPublicAppUrl } = require('./applicationEngine');

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long' });
}

// Every send function below follows the same shape: build the message,
// send it, log it, return { delivered, message }. Centralising the log
// call here means every call site gets a complete history for free,
// rather than every caller having to remember to log it separately.
async function sendAndLog(app, type, message) {
  const phone = toWhatsAppFormat(app.phoneNumber);
  const delivered = await sendWhatsAppMessage(phone, message);
  await logNotification(app.reference, { type, message, sentBy: 'system', delivered });
  return { delivered, message };
}

async function sendUpcomingReminder(app, installment) {
  const firstName = app.fullName.split(' ')[0];
  const message = `Hi ${firstName}, this is a reminder that your Khula instalment of R${installment.amount.toFixed(2)} is due on ${formatDate(installment.dueDate)}. Reference ${app.reference}. Make sure there are sufficient funds in your account for the DebiCheck collection. Reply here if you need help.`;
  return sendAndLog(app, 'upcoming_reminder', message);
}

async function sendOverdueNotice(app, installment) {
  const firstName = app.fullName.split(' ')[0];
  const message = `Hi ${firstName}, we weren't able to collect your Khula instalment of R${installment.amount.toFixed(2)} due ${formatDate(installment.dueDate)}. Reference ${app.reference}. Please reply here to arrange payment — we'd rather help you catch up than let this become a bigger problem.`;
  return sendAndLog(app, 'overdue_notice', message);
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
  const firstName = app.fullName.split(' ')[0];
  const message = `Hi ${firstName}, just checking in — your Khula instalment of R${installment.amount.toFixed(2)} (reference ${app.reference}) is still outstanding. If you're going through a tough time, message us here and we can talk through options together. No judgment, just want to help you get back on track.`;
  return sendAndLog(app, 'repeat_overdue_reminder', message);
}

async function sendThankYou(app, installment, remaining) {
  const firstName = app.fullName.split(' ')[0];
  const message = remaining > 0
    ? `Thanks ${firstName}! We've received your payment of R${installment.amount.toFixed(2)}. You have ${remaining} instalment${remaining === 1 ? '' : 's'} left on this loan. Reference ${app.reference}.`
    : `Thanks ${firstName}! That was your final instalment — this loan is now fully paid off. 🎉 Well done, and thanks for being a Khula customer. Reference ${app.reference}.`;
  return sendAndLog(app, 'thank_you', message);
}

// Sent once the DebiCheck mandate is confirmed and disbursement actually
// happens — deliberately NOT sent at loan signature, since signing the
// agreement and the bank confirming the debit order mandate are two
// separate things. See server/routes/admin.js mandate/confirm endpoint.
async function sendDisbursementConfirmation(app) {
  const firstName = app.fullName.split(' ')[0];
  const message = `Great news ${firstName} — your debit order mandate is confirmed, and R${app.requestedAmount} is on its way to your account now. Reference ${app.reference}. You can still cancel at no cost until your reconsideration window closes — just message us.`;
  return sendAndLog(app, 'disbursement_confirmation', message);
}

// Sent if the customer doesn't confirm the mandate at their bank (or
// declines it) — the loan stays signed but funds don't move until this is
// resolved, so the borrower needs to know something is actually blocking
// their payout, not just silence.
async function sendMandateDeclinedNotice(app) {
  const firstName = app.fullName.split(' ')[0];
  const message = `Hi ${firstName}, we weren't able to confirm your debit order mandate, so we haven't been able to release your funds yet. Reference ${app.reference}. Please message us here so we can sort this out together.`;
  return sendAndLog(app, 'mandate_declined', message);
}

// Sent when a loan is paid off via early settlement — deliberately
// distinct from the normal final-instalment thank-you, since it's worth
// being transparent with the customer that paying early genuinely saved
// them money (the whole point of the NCA Section 125 right), not just a
// generic "loan closed" notice.
async function sendSettlementConfirmation(app, settlementAmount, overpayment) {
  const firstName = app.fullName.split(' ')[0];
  const overpaymentNote = overpayment > 0
    ? ` You paid R${overpayment.toFixed(2)} more than the exact settlement figure — we'll be in touch about refunding that.`
    : '';
  const message = `Great news ${firstName} — your loan is now fully settled early, for R${settlementAmount.toFixed(2)}. Paying it off ahead of schedule means you didn't pay interest or fees for the months you no longer needed the loan.${overpaymentNote} Thanks for being a Khula customer. Reference ${app.reference}.`;
  return sendAndLog(app, 'settlement_confirmation', message);
}

// This is THE moment a customer first learns their real quote and is told
// they're approved — and it's deliberately placed here, called only from
// server/routes/admin.js's kyc-decision 'verify' branch, AFTER identity,
// address, employment, and the credit bureau have all actually cleared.
// Passing the initial affordability check is necessary but not
// sufficient; showing a quote any earlier than this creates exactly the
// "I thought I was approved" problem this was built to fix — a customer
// who fails KYC or the bureau check should never have seen a number at
// all, let alone a congratulatory one.
async function sendApprovalQuoteReveal(app) {
  const phone = toWhatsAppFormat(app.phoneNumber);
  const firstName = app.fullName.split(' ')[0];
  const q = app.affordability?.quotation;
  if (!q) return { delivered: false, message: null };

  const ceilingNote = q.aboveShortTermCreditCeiling
    ? ` ⚠️ Above R${q.shortTermCreditCeiling} — needs compliance confirmation on applicable fee/interest caps before this quote is final.`
    : '';
  const summary = `Congratulations ${firstName} — you're approved! Here's your quote for R${app.requestedAmount} over ${app.termMonths} month${app.termMonths === 1 ? '' : 's'}: first instalment R${q.firstMonthInstalment.toFixed(2)}, total repayable R${q.totalRepayable.toFixed(2)}. Full breakdown in the PDF below.${ceilingNote}`;

  const summaryDelivered = await sendWhatsAppMessage(phone, summary);
  await logNotification(app.reference, { type: 'approval_quote_summary', message: summary, sentBy: 'system', delivered: summaryDelivered });

  const base = getPublicAppUrl();
  const pdfUrl = `${base}/api/applications/${app.reference}/pre-agreement.pdf`;
  const pdfDelivered = await sendWhatsAppDocument(phone, pdfUrl, `Khula-Pre-Agreement-${app.reference}.pdf`, 'Your quote and pre-agreement statement');
  await logNotification(app.reference, { type: 'approval_quote_pdf', message: `[PDF sent: ${pdfUrl}]`, sentBy: 'system', delivered: pdfDelivered });

  const signPrompt = `Reply SIGN (or your full name) to accept and sign. Reference ${app.reference}.`;
  const signDelivered = await sendWhatsAppMessage(phone, signPrompt);
  await logNotification(app.reference, { type: 'sign_prompt', message: signPrompt, sentBy: 'system', delivered: signDelivered });

  return { delivered: summaryDelivered && pdfDelivered && signDelivered };
}

module.exports = { sendUpcomingReminder, sendOverdueNotice, sendRepeatOverdueReminder, sendThankYou, sendDisbursementConfirmation, sendMandateDeclinedNotice, sendSettlementConfirmation, sendApprovalQuoteReveal };
