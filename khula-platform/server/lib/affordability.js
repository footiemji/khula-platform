// Affordability engine, modelled on the NCR affordability assessment
// principles (Regulations 23A/23B of the National Credit Act): lenders must
// verify income and expenses and leave the consumer with enough discretionary
// income to service the debt without hardship.
//
// This is a policy ENGINE, not legal advice — have your NCR compliance
// officer / attorney sign off on the exact ratios and statutory expense
// tables before this touches real money.

const { buildQuotation } = require('./costOfCredit');

const MAX_INSTALMENT_TO_INCOME_RATIO = Number(process.env.MAX_INSTALMENT_TO_INCOME_RATIO || 0.25);
const MIN_LOAN_AMOUNT = Number(process.env.MIN_LOAN_AMOUNT || 500);
const MAX_LOAN_AMOUNT = Number(process.env.MAX_LOAN_AMOUNT || 15000);

function assessAffordability({ netMonthlyIncome, monthlyExpenses, existingDebtInstalments, requestedAmount, termMonths, isFirstLoan = true }) {
  const errors = [];
  if (!netMonthlyIncome || netMonthlyIncome <= 0) errors.push('Net monthly income is required.');
  if (monthlyExpenses == null || monthlyExpenses < 0) errors.push('Monthly expenses are required.');
  if (!requestedAmount || requestedAmount < MIN_LOAN_AMOUNT || requestedAmount > MAX_LOAN_AMOUNT) {
    errors.push(`Loan amount must be between R${MIN_LOAN_AMOUNT} and R${MAX_LOAN_AMOUNT}.`);
  }
  if (!termMonths || termMonths < 1 || termMonths > 36) errors.push('Term must be between 1 and 36 months.');

  if (errors.length) return { eligible: false, errors };

  // The affordability check uses the FULL monthly instalment — capital,
  // interest, service fee, and insurance together — not just capital and
  // interest. A loan can look affordable on principal+interest alone and
  // still leave a borrower unable to cover the real monthly cost once fees
  // and insurance are added, which is exactly the outcome this check
  // exists to prevent.
  const quotation = buildQuotation({ principal: requestedAmount, termMonths, isFirstLoan });
  const proposedInstalment = quotation.firstMonthInstalment;

  const discretionaryIncome = netMonthlyIncome - monthlyExpenses - (existingDebtInstalments || 0);
  const instalmentToIncome = proposedInstalment / netMonthlyIncome;

  const passesDiscretionary = discretionaryIncome >= proposedInstalment * 1.1; // 10% buffer
  const passesRatio = instalmentToIncome <= MAX_INSTALMENT_TO_INCOME_RATIO;

  const eligible = passesDiscretionary && passesRatio;

  // Suggest the largest affordable amount at the same term if declined,
  // so the flow can offer a counter-offer instead of a flat no. This
  // approximates using principal+interest only (fees are near-fixed
  // regardless of amount, so this stays a reasonable estimate rather than
  // an exact inverse of the full schedule).
  let suggestedAmount = null;
  if (!eligible) {
    const affordableInstalment = Math.min(
      discretionaryIncome / 1.1,
      netMonthlyIncome * MAX_INSTALMENT_TO_INCOME_RATIO
    );
    const feeAndInsuranceEstimate = quotation.monthlyServiceFee + (quotation.schedule[0]?.insurancePremium || 0);
    const affordableForCapitalInterest = affordableInstalment - feeAndInsuranceEstimate;
    if (affordableForCapitalInterest > 0) {
      const rate = quotation.monthlyInterestRate;
      const principal = rate === 0
        ? affordableForCapitalInterest * termMonths
        : (affordableForCapitalInterest * (1 - Math.pow(1 + rate, -termMonths))) / rate;
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
    quotation,
  };
}

module.exports = { assessAffordability, MIN_LOAN_AMOUNT, MAX_LOAN_AMOUNT };
