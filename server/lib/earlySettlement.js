// Calculates the true amount owed if a borrower settles their loan early,
// implementing National Credit Act Section 125(2) as literally written:
//
//   settlement = (a) the unpaid principal balance at that time
//              + (b) unpaid interest and other charges payable UP TO the
//                    settlement date
//
// The entire "rebate" effect everyone talks about is just the natural
// consequence of (b): months that haven't happened yet contribute nothing.
// Since Khula's interest/insurance are already computed on a declining
// balance per month (server/lib/costOfCredit.js), this is mostly "stop
// counting future months" rather than a separate discount formula layered
// on top.
//
// The initiation fee is deliberately excluded entirely — it's a once-off
// charge for originating the loan, fully earned at signature, not
// something that accrues over the term the way interest does.

function daysBetween(a, b) {
  return (new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24);
}

/**
 * @param {object} app - the application record (needs affordability.quotation.schedule,
 *   collections.repaymentSchedule, signature.signedAt)
 * @param {Date} [asOfDate] - defaults to now
 * @returns {object} { settlementAmount, remainingPrincipal, accruedInterestFeesInsurance,
 *   alreadyFullySettled, breakdown }
 */
function calculateEarlySettlement(app, asOfDate = new Date()) {
  const quotationSchedule = app.affordability?.quotation?.schedule || [];
  const repaymentSchedule = app.collections?.repaymentSchedule || [];

  if (!quotationSchedule.length || !repaymentSchedule.length) {
    return { settlementAmount: null, error: 'No repayment schedule found — this loan may not be signed yet.' };
  }

  const sorted = [...repaymentSchedule].sort((a, b) => a.installmentNumber - b.installmentNumber);
  const lastPaidIdx = sorted.reduce((acc, inst, i) => (inst.status === 'paid' ? i : acc), -1);

  if (lastPaidIdx === sorted.length - 1) {
    return { settlementAmount: 0, remainingPrincipal: 0, accruedInterestFeesInsurance: 0, alreadyFullySettled: true, breakdown: [] };
  }

  // Remaining principal is whatever's left after the last instalment that
  // was ACTUALLY paid — not what the original schedule assumed would have
  // been paid by now. An instalment sitting unpaid/overdue means its
  // capital portion was never really repaid, so the balance stays at the
  // higher figure until a real payment reduces it.
  const remainingPrincipal = lastPaidIdx === -1
    ? quotationSchedule[0].openingBalance
    : quotationSchedule[lastPaidIdx].closingBalance;

  let accrued = 0;
  const breakdown = [];
  let periodStart = lastPaidIdx === -1
    ? app.signature?.signedAt
    : sorted[lastPaidIdx].dueDate;

  for (let i = lastPaidIdx + 1; i < sorted.length; i++) {
    const installment = sorted[i];
    const periodEnd = installment.dueDate;
    const quotationMonth = quotationSchedule[i]; // same index alignment as repaymentSchedule

    if (new Date(asOfDate) >= new Date(periodEnd)) {
      // This whole period has elapsed (on time or overdue) — its interest,
      // service fee, and insurance are genuinely owed in full, even though
      // it was never paid. Keep walking forward to check the next period.
      const periodTotal = quotationMonth.interestPortion + quotationMonth.serviceFee + quotationMonth.insurancePremium;
      accrued += periodTotal;
      breakdown.push({ installmentNumber: installment.installmentNumber, status: 'fully elapsed', proportion: 1, amount: Math.round(periodTotal * 100) / 100 });
      periodStart = periodEnd;
      continue;
    }

    if (new Date(asOfDate) > new Date(periodStart)) {
      // Currently mid-way through this period — prorate by days elapsed.
      const totalDays = daysBetween(periodStart, periodEnd);
      const elapsedDays = daysBetween(periodStart, asOfDate);
      const proportion = totalDays > 0 ? Math.min(1, Math.max(0, elapsedDays / totalDays)) : 0;
      const periodTotal = quotationMonth.interestPortion + quotationMonth.serviceFee + quotationMonth.insurancePremium;
      const proratedAmount = periodTotal * proportion;
      accrued += proratedAmount;
      breakdown.push({ installmentNumber: installment.installmentNumber, status: 'in progress', proportion: Math.round(proportion * 1000) / 1000, amount: Math.round(proratedAmount * 100) / 100 });
    }
    // Anything after this point hasn't started accruing at all — correctly excluded.
    break;
  }

  accrued = Math.round(accrued * 100) / 100;
  const settlementAmount = Math.round((remainingPrincipal + accrued) * 100) / 100;

  return {
    settlementAmount,
    remainingPrincipal: Math.round(remainingPrincipal * 100) / 100,
    accruedInterestFeesInsurance: accrued,
    alreadyFullySettled: false,
    breakdown,
  };
}

module.exports = { calculateEarlySettlement };
