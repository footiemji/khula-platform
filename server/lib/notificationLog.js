// A single place to record every WhatsApp message sent to a customer —
// automated (reminders, thank-yous) or manual (admin's own custom
// messages) — so admin has a real communications history per customer,
// not just the ability to send things. "More control" means visibility
// as much as it means a send button.

const db = require('./db');

/**
 * @param {string} reference - application reference
 * @param {object} entry
 * @param {string} entry.type - e.g. 'upcoming_reminder', 'overdue_notice', 'thank_you', 'custom', 'balance_summary'
 * @param {string} entry.message - the actual text sent
 * @param {string} [entry.sentBy] - admin email, or omitted/'system' for automated sends
 * @param {boolean} [entry.delivered] - whether the underlying send actually succeeded
 */
async function logNotification(reference, entry) {
  try {
    await db.update('applications', (a) => a.reference === reference, (a) => ({
      ...a,
      notificationHistory: [
        ...(a.notificationHistory || []),
        {
          type: entry.type,
          message: entry.message,
          sentBy: entry.sentBy || 'system',
          sentAt: new Date().toISOString(),
          delivered: entry.delivered !== false,
        },
      ],
    }));
  } catch (err) {
    // Logging failure should never break the actual send/notification flow
    // that triggered it — this is a record-keeping nicety, not something
    // worth failing a customer-facing action over.
    console.error(`Failed to log notification for ${reference}:`, err.message);
  }
}

module.exports = { logNotification };
