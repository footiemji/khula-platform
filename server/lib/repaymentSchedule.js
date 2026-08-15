// Builds a repayment schedule with real calendar due dates from a signed
// loan's amortization schedule (server/lib/costOfCredit.js gives month
// numbers and amounts; this attaches actual dates and payment-tracking
// status so reminders and collections have something concrete to act on).

function buildRepaymentSchedule(signedAt, quotationSchedule) {
  const startDate = new Date(signedAt);
  return quotationSchedule.map((month) => {
    const dueDate = new Date(startDate);
    dueDate.setMonth(dueDate.getMonth() + month.month);
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

module.exports = { buildRepaymentSchedule };
