// Computes the actual cost of credit — interest, initiation fee, monthly
// service fee, and credit life insurance — as a proper month-by-month
// amortization schedule, not a single flat estimate. This is what gets
// shown in the quotation and the pre-agreement statement.
//
// Figures below match Khula's own adopted Credit Underwriting Policy
// (04_Underwriting_Policy.docx, Section 7), not general NCA research —
// these are the numbers the company has actually approved:
//   - Interest: 5%/month flat, no first-loan/repeat-loan distinction (the
//     underwriting policy and loan agreement both state a single flat
//     rate — the rate-differentiation mechanism below still exists in
//     case that changes, but defaults to the same rate either way)
//   - Initiation fee: R165 + 10% of the amount over R1,000, capped at R1,207.50
//   - Monthly service fee: capped at R69.00
//   - Credit life insurance: capped at R4.50 per R1,000 of the OUTSTANDING
//     balance per month (not the original loan amount — cost declines as
//     the loan is paid down) — this figure came from general NCA research,
//     not from Khula's own documents, since none of the uploaded policies
//     mention credit life insurance pricing specifically. Confirm this
//     still matches whatever insurer/policy Khula actually uses.
//
// These are defaults, configurable via .env. Have your compliance officer
// confirm these numbers are internally consistent — Khula's own
// Underwriting Policy and Loan Agreement did not fully agree with each
// other on the initiation fee cap structure when these documents were
// reviewed; this file uses the Underwriting Policy's flat-cap version.
// See docs/COMPLIANCE.md.

const FIRST_LOAN_INTEREST_RATE = Number(process.env.INTEREST_RATE_FIRST_LOAN_PCT || 5) / 100;
const REPEAT_LOAN_INTEREST_RATE = Number(process.env.INTEREST_RATE_REPEAT_LOAN_PCT || 5) / 100;
const INITIATION_FEE_BASE = Number(process.env.INITIATION_FEE_BASE || 165);
const INITIATION_FEE_RATE = Number(process.env.INITIATION_FEE_RATE_PCT || 10) / 100;
const INITIATION_FEE_CAP = Number(process.env.INITIATION_FEE_CAP || 1207.50);
const MONTHLY_SERVICE_FEE = Number(process.env.MONTHLY_SERVICE_FEE || 69);
const CREDIT_LIFE_RATE_PER_1000 = Number(process.env.CREDIT_LIFE_RATE_PER_1000 || 4.5);

// NCA short-term credit transactions (the bracket these caps are drawn
// from) are statutorily defined for loans up to R8,000 over up to 6
// months. Khula's own approved policy authorizes loans up to R50,000 over
// up to 60 months at a flat 5%/month WITHOUT drawing this bracket
// distinction — but that distinction is a statutory fact, not something
// an internal company policy can override. Loans above R8,000 or terms
// above 6 months may legally fall under a different NCA bracket
// (unsecured credit transactions) with a different, repo-rate-linked
// interest formula that this engine does NOT implement, because that
// formula depends on the prevailing SARB repo rate at the time of
// calculation and hardcoding a rate here would silently go stale. This is
// flagged in the quotation output specifically because Khula's own
// documents don't address it — have your compliance officer confirm
// which bracket actually governs loans above this threshold before
// relying on the flat 5% rate for them.
const SHORT_TERM_CREDIT_CEILING = Number(process.env.SHORT_TERM_CREDIT_CEILING || 8000);

function calculateInitiationFee(principal) {
  const fee = INITIATION_FEE_BASE + INITIATION_FEE_RATE * Math.max(0, principal - 1000);
  return Math.round(Math.min(fee, INITIATION_FEE_CAP) * 100) / 100;
}

// Standard amortization formula for the principal + interest portion only —
// fees and insurance are layered on top per month, not blended into this
// figure, so each cost component stays visible to the borrower.
function calculatePrincipalInterestInstalment(principal, monthlyRate, termMonths) {
  if (monthlyRate === 0) return principal / termMonths;
  const instalment = (principal * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -termMonths));
  return instalment;
}

/**
 * Builds a full month-by-month quotation.
 * @param {object} params
 * @param {number} params.principal
 * @param {number} params.termMonths
 * @param {boolean} params.isFirstLoan - true if this is the consumer's first loan with Khula this calendar year
 * @returns {object} quotation with schedule + totals
 */
function buildQuotation({ principal, termMonths, isFirstLoan = true }) {
  const monthlyRate = isFirstLoan ? FIRST_LOAN_INTEREST_RATE : REPEAT_LOAN_INTEREST_RATE;
  const principalInterestInstalment = calculatePrincipalInterestInstalment(principal, monthlyRate, termMonths);
  const initiationFee = calculateInitiationFee(principal);

  let balance = principal;
  const schedule = [];
  let totalInterest = 0;
  let totalInsurance = 0;

  for (let month = 1; month <= termMonths; month++) {
    const interestPortion = balance * monthlyRate;
    let capitalPortion = principalInterestInstalment - interestPortion;
    // Final month: settle whatever's left exactly, avoiding a stray cent from rounding.
    if (month === termMonths) capitalPortion = balance;

    const insurancePremium = Math.round((balance / 1000) * CREDIT_LIFE_RATE_PER_1000 * 100) / 100;
    const closingBalance = Math.max(0, Math.round((balance - capitalPortion) * 100) / 100);

    schedule.push({
      month,
      openingBalance: Math.round(balance * 100) / 100,
      interestPortion: Math.round(interestPortion * 100) / 100,
      capitalPortion: Math.round(capitalPortion * 100) / 100,
      serviceFee: MONTHLY_SERVICE_FEE,
      insurancePremium,
      totalInstalment: Math.round((capitalPortion + interestPortion + MONTHLY_SERVICE_FEE + insurancePremium) * 100) / 100,
      closingBalance,
    });

    totalInterest += interestPortion;
    totalInsurance += insurancePremium;
    balance = closingBalance;
  }

  const totalServiceFees = MONTHLY_SERVICE_FEE * termMonths;
  totalInterest = Math.round(totalInterest * 100) / 100;
  totalInsurance = Math.round(totalInsurance * 100) / 100;
  const totalCostOfCredit = Math.round((totalInterest + initiationFee + totalServiceFees + totalInsurance) * 100) / 100;
  const totalRepayable = Math.round((principal + totalCostOfCredit) * 100) / 100;

  // First month's total is the headline "your instalment is roughly R___"
  // figure — later months are usually very slightly lower as insurance
  // declines with the outstanding balance.
  const firstMonthInstalment = schedule[0]?.totalInstalment ?? 0;

  return {
    principal,
    termMonths,
    monthlyInterestRate: monthlyRate,
    isFirstLoan,
    initiationFee,
    monthlyServiceFee: MONTHLY_SERVICE_FEE,
    creditLifeInsuranceRatePer1000: CREDIT_LIFE_RATE_PER_1000,
    firstMonthInstalment,
    totalInterest,
    totalServiceFees,
    totalInsurance,
    totalCostOfCredit,
    totalRepayable,
    schedule,
    aboveShortTermCreditCeiling: principal > SHORT_TERM_CREDIT_CEILING,
    shortTermCreditCeiling: SHORT_TERM_CREDIT_CEILING,
  };
}

module.exports = { buildQuotation, calculateInitiationFee, SHORT_TERM_CREDIT_CEILING };
