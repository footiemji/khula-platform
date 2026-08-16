// Builds a repayment schedule with real calendar due dates from a signed
// loan's amortization schedule (server/lib/costOfCredit.js gives month
// numbers and amounts; this attaches actual dates and payment-tracking
// status so reminders and collections have something concrete to act on).
//
// Due dates align to the borrower's actual salary payment date where one
// was captured (07_Loan_Application_Form Section E) — collecting on a date
// unrelated to when someone actually gets paid is a direct, avoidable
// cause of failed DebiCheck collections, not just a compliance nicety.

// Parses the free-text salary payment date field (the application form's
// own examples are things like "25th of each month" or "Last working
// day") into a numeric day-of-month. Clamped to 1-28 so it's valid in
// every month, including February — a due date of "31st" would silently
// roll over in short months otherwise.
function parseSalaryDayOfMonth(raw) {
  if (!raw) return null;
  const text = String(raw).toLowerCase();

  if (/last|end of month|month.?end/.test(text)) {
    // "Last working day" salary typically clears by month-end; collecting
    // a few days later gives the funds time to actually land.
    return 28;
  }

  const match = text.match(/\d{1,2}/);
  if (match) {
    const day = parseInt(match[0], 10);
    if (day >= 1 && day <= 28) return day;
    if (day > 28) return 28;
  }

  return null;
}

function buildRepaymentSchedule(signedAt, quotationSchedule, salaryPaymentDate) {
  const startDate = new Date(signedAt);
  const preferredDay = parseSalaryDayOfMonth(salaryPaymentDate);

  return quotationSchedule.map((month) => {
    const dueDate = new Date(startDate);
    dueDate.setMonth(dueDate.getMonth() + month.month);
    if (preferredDay) {
      dueDate.setDate(preferredDay);
      // If setting the day pushed the date into the following month
      // (shouldn't happen since preferredDay is clamped to 28, but
      // defensive against any future change to that clamp), pull back to
      // the last day of the intended month instead.
      if (dueDate.getMonth() !== ((startDate.getMonth() + month.month) % 12)) {
        dueDate.setDate(0);
      }
    }
    return {
      installmentNumber: month.month,
      dueDate: dueDate.toISOString(),
      amount: month.totalInstalment,
      status: 'due', // due | reminder_sent | paid | overdue | missed
      remindedAt: null,
      paidAt: null,
      markedPaidBy: null,
    };
  });
}

module.exports = { buildRepaymentSchedule, parseSalaryDayOfMonth };
