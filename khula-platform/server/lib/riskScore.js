// Placeholder risk-scoring model. This is a transparent, explainable
// rules-based score so you can launch before a bureau-scorecard integration
// exists. Swap in Experian/XDS/TransUnion bureau data + a trained model
// later — keep the same output shape ({ score, band, reasons }) so nothing
// downstream (admin dashboard, decisioning) has to change.

function scoreApplication({ employmentType, monthsEmployed, netMonthlyIncome, existingDebtInstalments, requestedAmount, previousLoansWithKhula = 0, missedPaymentsWithKhula = 0 }) {
  let score = 600; // base score, out of a 300-850-style band
  const reasons = [];

  // Employment stability
  const employmentWeights = { formal_permanent: 80, formal_contract: 40, self_employed: 20, informal: -20, unemployed: -150 };
  const empDelta = employmentWeights[employmentType] ?? 0;
  score += empDelta;
  reasons.push(`Employment type (${employmentType || 'unspecified'}): ${empDelta >= 0 ? '+' : ''}${empDelta}`);

  // Tenure
  if (monthsEmployed >= 24) { score += 40; reasons.push('24+ months in current role: +40'); }
  else if (monthsEmployed >= 6) { score += 15; reasons.push('6-23 months in current role: +15'); }
  else { score -= 30; reasons.push('Under 6 months in current role: -30'); }

  // Debt burden already committed elsewhere
  const debtRatio = netMonthlyIncome > 0 ? (existingDebtInstalments || 0) / netMonthlyIncome : 1;
  if (debtRatio > 0.4) { score -= 60; reasons.push('Existing debt >40% of income: -60'); }
  else if (debtRatio > 0.2) { score -= 20; reasons.push('Existing debt 20-40% of income: -20'); }
  else { score += 20; reasons.push('Existing debt under 20% of income: +20'); }

  // Loan size relative to income (bigger ask = more risk, all else equal)
  const requestRatio = netMonthlyIncome > 0 ? requestedAmount / netMonthlyIncome : 1;
  if (requestRatio > 1.5) { score -= 40; reasons.push('Requested amount >1.5x monthly income: -40'); }
  else if (requestRatio <= 0.5) { score += 20; reasons.push('Requested amount <=0.5x monthly income: +20'); }

  // Repeat-borrower loyalty / track record with Khula itself
  if (previousLoansWithKhula > 0 && missedPaymentsWithKhula === 0) {
    score += Math.min(60, previousLoansWithKhula * 20);
    reasons.push(`Clean repayment history (${previousLoansWithKhula} prior loans): +${Math.min(60, previousLoansWithKhula * 20)}`);
  }
  if (missedPaymentsWithKhula > 0) {
    score -= missedPaymentsWithKhula * 50;
    reasons.push(`Missed payments on record (${missedPaymentsWithKhula}): -${missedPaymentsWithKhula * 50}`);
  }

  score = Math.max(300, Math.min(850, Math.round(score)));

  let band;
  if (score >= 700) band = 'low_risk';
  else if (score >= 580) band = 'medium_risk';
  else band = 'high_risk';

  return { score, band, reasons };
}

// Combines affordability + risk score into a single instant decision so the
// WhatsApp flow can respond in real time instead of "we'll get back to you".
function decide({ affordability, risk }) {
  if (!affordability.eligible) {
    return { decision: 'declined', reason: 'affordability', detail: affordability };
  }
  if (risk.band === 'high_risk') {
    return { decision: 'manual_review', reason: 'risk_band', detail: risk };
  }
  return { decision: 'approved', reason: 'passed_automated_checks', detail: { affordability, risk } };
}

module.exports = { scoreApplication, decide };
