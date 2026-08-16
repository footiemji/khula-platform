// Affordability engine, modelled on the NCR affordability assessment
// principles (Regulations 23A/23B of the National Credit Act): lenders must
// verify income and expenses and leave the consumer with enough discretionary
// income to service the debt without hardship.
//
// This is a policy ENGINE, not legal advice — have your NCR compliance
// officer / attorney sign off on the exact ratios and statutory expense
// tables before this touches real money.

const { buildQuotation } = require('./costOfCredit');

const MAX_INSTALMENT_TO_INCOME_RATIO = Number(process.env.MAX_INSTALMENT_TO_INCOME_RATIO || 0.30);
const MIN_LOAN_AMOUNT = Number(process.env.MIN_LOAN_AMOUNT || 500);
const MAX_LOAN_AMOUNT = Number(process.env.MAX_LOAN_AMOUNT || 50000);
const MIN_NET_MONTHLY_INCOME = Number(process.env.MIN_NET_MONTHLY_INCOME || 3000);
const MAX_TERM_MONTHS = Number(process.env.MAX_TERM_MONTHS || 60);

// Minimum deemed living expenses by income band — 05_Underwriting_Policy
// Section 5.3. Where an applicant's declared expenses are lower than this
// floor for their income band, the floor is used instead — this exists
// specifically to stop someone under-declaring expenses to look more
// affordable than they actually are.
const MINIMUM_DEEMED_EXPENSE_TABLE = [
  { maxIncome: 5000, minExpense: 2500 },
  { maxIncome: 10000, minExpense: 3500 },
  { maxIncome: 20000, minExpense: 5000 },
  { maxIncome: 40000, minExpense: 8000 },
  { maxIncome: Infinity, minExpense: 12000 },
];

function minimumDeemedExpense(netMonthlyIncome) {
  const band = MINIMUM_DEEMED_EXPENSE_TABLE.find((b) => netMonthlyIncome <= b.maxIncome);
  return band ? band.minExpense : MINIMUM_DEEMED_EXPENSE_TABLE[MINIMUM_DEEMED_EXPENSE_TABLE.length - 1].minExpense;
}

function assessAffordability({ netMonthlyIncome, monthlyExpenses, existingDebtInstalments, requestedAmount, termMonths, isFirstLoan = true }) {
  const errors = [];
  if (!netMonthlyIncome || netMonthlyIncome <= 0) errors.push('Net monthly income is required.');
  if (netMonthlyIncome && netMonthlyIncome < MIN_NET_MONTHLY_INCOME) {
    errors.push(`Net monthly income must be at least R${MIN_NET_MONTHLY_INCOME.toLocaleString('en-ZA')}.`);
  }
  if (monthlyExpenses == null || monthlyExpenses < 0) errors.push('Monthly expenses are required.');
  if (!requestedAmount || requestedAmount < MIN_LOAN_AMOUNT || requestedAmount > MAX_LOAN_AMOUNT) {
    errors.push(`Loan amount must be between R${MIN_LOAN_AMOUNT} and R${MAX_LOAN_AMOUNT.toLocaleString('en-ZA')}.`);
  }
  if (!termMonths || termMonths < 1 || termMonths > MAX_TERM_MONTHS) errors.push(`Term must be between 1 and ${MAX_TERM_MONTHS} months.`);

  if (errors.length) return { eligible: false, errors };

  // Effective expenses can never be lower than the deemed minimum for this
  // income band, regardless of what was declared.
  const deemedMinimum = minimumDeemedExpense(netMonthlyIncome);
  const expenseFloorApplied = monthlyExpenses < deemedMinimum;
  const effectiveExpenses = Math.max(monthlyExpenses, deemedMinimum);

  // The affordability check uses the FULL monthly instalment — capital,
  // interest, service fee, and insurance together — not just capital and
  // interest. A loan can look affordable on principal+interest alone and
  // still leave a borrower unable to cover the real monthly cost once fees
  // and insurance are added, which is exactly the outcome this check
  // exists to prevent.
  const quotation = buildQuotation({ principal: requestedAmount, termMonths, isFirstLoan });
  const proposedInstalment = quotation.firstMonthInstalment;

  const discretionaryIncome = netMonthlyIncome - effectiveExpenses - (existingDebtInstalments || 0);
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
    declaredExpenses: monthlyExpenses,
    deemedMinimumExpense: deemedMinimum,
    expenseFloorApplied,
    effectiveExpenses,
  };
}

module.exports = { assessAffordability, minimumDeemedExpense, MIN_LOAN_AMOUNT, MAX_LOAN_AMOUNT, MIN_NET_MONTHLY_INCOME, MAX_TERM_MONTHS };
