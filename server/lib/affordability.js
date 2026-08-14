// Affordability engine, modelled on the NCR affordability assessment
// principles (Regulations 23A/23B of the National Credit Act): lenders must
// verify income and expenses and leave the consumer with enough discretionary
// income to service the debt without hardship.
//
// This is a policy ENGINE, not legal advice — have your NCR compliance
// officer / attorney sign off on the exact ratios and statutory expense
// tables before this touches real money.

const MAX_INSTALMENT_TO_INCOME_RATIO = Number(process.env.MAX_INSTALMENT_TO_INCOME_RATIO || 0.25);
const MIN_LOAN_AMOUNT = Number(process.env.MIN_LOAN_AMOUNT || 500);
const MAX_LOAN_AMOUNT = Number(process.env.MAX_LOAN_AMOUNT || 15000);

// Simple flat-rate instalment calc for illustration. Replace with your
// actual NCA-compliant initiation fee / service fee / interest schedule.
function estimateInstalment({ principal, termMonths, monthlyRatePct = 3 }) {
  const r = monthlyRatePct / 100;
  if (r === 0) return principal / termMonths;
  const instalment = (principal * r) / (1 - Math.pow(1 + r, -termMonths));
  return Math.round(instalment * 100) / 100;
}

function assessAffordability({ netMonthlyIncome, monthlyExpenses, existingDebtInstalments, requestedAmount, termMonths }) {
  const errors = [];
  if (!netMonthlyIncome || netMonthlyIncome <= 0) errors.push('Net monthly income is required.');
  if (monthlyExpenses == null || monthlyExpenses < 0) errors.push('Monthly expenses are required.');
  if (!requestedAmount || requestedAmount < MIN_LOAN_AMOUNT || requestedAmount > MAX_LOAN_AMOUNT) {
    errors.push(`Loan amount must be between R${MIN_LOAN_AMOUNT} and R${MAX_LOAN_AMOUNT}.`);
  }
  if (!termMonths || termMonths < 1 || termMonths > 36) errors.push('Term must be between 1 and 36 months.');

  if (errors.length) return { eligible: false, errors };

  const discretionaryIncome = netMonthlyIncome - monthlyExpenses - (existingDebtInstalments || 0);
  const proposedInstalment = estimateInstalment({ principal: requestedAmount, termMonths });
  const instalmentToIncome = proposedInstalment / netMonthlyIncome;

  const passesDiscretionary = discretionaryIncome >= proposedInstalment * 1.1; // 10% buffer
  const passesRatio = instalmentToIncome <= MAX_INSTALMENT_TO_INCOME_RATIO;

  const eligible = passesDiscretionary && passesRatio;

  // Suggest the largest affordable amount at the same term if declined,
  // so the flow can offer a counter-offer instead of a flat no.
  let suggestedAmount = null;
  if (!eligible) {
    const affordableInstalment = Math.min(
      discretionaryIncome / 1.1,
      netMonthlyIncome * MAX_INSTALMENT_TO_INCOME_RATIO
    );
    if (affordableInstalment > 0) {
      // invert the instalment formula for principal
      const rate = 0.03;
      const principal = affordableInstalment * (1 - Math.pow(1 + rate, -termMonths)) / rate;
      suggestedAmount = Math.max(0, Math.floor(principal / 100) * 100);
    }
  }

  return {
    eligible,
    errors: [],
    discretionaryIncome: Math.round(discretionaryIncome * 100) / 100,
    proposedInstalment,
    instalmentToIncomeRatio: Math.round(instalmentToIncome * 1000) / 1000,
    maxAllowedRatio: MAX_INSTALMENT_TO_INCOME_RATIO,
    suggestedAmount: suggestedAmount && suggestedAmount >= MIN_LOAN_AMOUNT ? suggestedAmount : null,
  };
}

module.exports = { assessAffordability, estimateInstalment, MIN_LOAN_AMOUNT, MAX_LOAN_AMOUNT };
