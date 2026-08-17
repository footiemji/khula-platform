// Scans every active loan's repayment schedule and sends reminders where
// due. Runs on a periodic internal timer (see server/index.js) and can also
// be triggered on demand from the admin console — useful for testing, and
// for anyone deploying without a proper external scheduler.
//
// Production note: an in-process setInterval works for a single-instance
// deployment (which is what this MVP targets) but resets on every restart —
// that's fine here since the sweep is idempotent (it only acts on what's
// actually due right now, re-reading persisted state each time), but if you
// ever run multiple instances of this app, move the trigger to an external
// scheduler (Render Cron Jobs, a simple cron hitting the admin endpoint
// below) instead of relying on each instance's own timer, or you'll send
// duplicate reminders.

const db = require('./db');
const { sendUpcomingReminder, sendOverdueNotice, sendRepeatOverdueReminder } = require('./reminders');

const REMINDER_DAYS_BEFORE = Number(process.env.REMINDER_DAYS_BEFORE || 3);
const OVERDUE_REMINDER_INTERVAL_DAYS = Number(process.env.OVERDUE_REMINDER_INTERVAL_DAYS || 7);
const MAX_OVERDUE_REMINDERS = Number(process.env.MAX_OVERDUE_REMINDERS || 4);

async function runCollectionsSweep() {
  const applications = await db.readAll('applications');
  const activeLoans = applications.filter((a) => a.status === 'active' && a.collections?.repaymentSchedule?.length);

  const results = { remindersSent: 0, overdueNoticesSent: 0, repeatOverdueRemindersSent: 0, errors: [] };
  const now = new Date();

  for (const app of activeLoans) {
    let scheduleChanged = false;
    const updatedSchedule = app.collections.repaymentSchedule.map((installment) => {
      if (installment.status === 'paid') return installment;

      const dueDate = new Date(installment.dueDate);
      const daysUntilDue = (dueDate - now) / (1000 * 60 * 60 * 24);

      try {
        if (installment.status === 'due' && daysUntilDue <= REMINDER_DAYS_BEFORE && daysUntilDue >= 0) {
          sendUpcomingReminder(app, installment).catch((e) => results.errors.push(e.message));
          results.remindersSent += 1;
          scheduleChanged = true;
          return { ...installment, status: 'reminder_sent', remindedAt: now.toISOString() };
        }

        if (daysUntilDue < 0 && installment.status !== 'overdue') {
          sendOverdueNotice(app, installment).catch((e) => results.errors.push(e.message));
          results.overdueNoticesSent += 1;
          scheduleChanged = true;
          return { ...installment, status: 'overdue', overdueNoticeAt: now.toISOString(), overdueReminderCount: 0, lastOverdueReminderAt: now.toISOString() };
        }

        // Already overdue — send a periodic, gentle re-reminder, capped so
        // this doesn't turn into an indefinite automated loop. Beyond the
        // cap, further contact should come through the human-driven legal
        // escalation ladder (see server/routes/admin.js legal/* endpoints),
        // not more automated messages.
        if (installment.status === 'overdue') {
          const reminderCount = installment.overdueReminderCount || 0;
          const lastReminder = new Date(installment.lastOverdueReminderAt || installment.overdueNoticeAt || dueDate);
          const daysSinceLastReminder = (now - lastReminder) / (1000 * 60 * 60 * 24);

          if (reminderCount < MAX_OVERDUE_REMINDERS && daysSinceLastReminder >= OVERDUE_REMINDER_INTERVAL_DAYS) {
            sendRepeatOverdueReminder(app, installment).catch((e) => results.errors.push(e.message));
            results.repeatOverdueRemindersSent += 1;
            scheduleChanged = true;
            return { ...installment, overdueReminderCount: reminderCount + 1, lastOverdueReminderAt: now.toISOString() };
          }
        }
      } catch (err) {
        results.errors.push(err.message);
      }

      return installment;
    });

    if (scheduleChanged) {
      await db.update('applications', (a) => a.reference === app.reference, (a) => ({
        ...a,
        collections: { ...a.collections, repaymentSchedule: updatedSchedule },
      }));
    }
  }

  return results;
}

module.exports = { runCollectionsSweep, REMINDER_DAYS_BEFORE, OVERDUE_REMINDER_INTERVAL_DAYS, MAX_OVERDUE_REMINDERS };
