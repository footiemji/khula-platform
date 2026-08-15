// Computes the actual cost of credit — interest, initiation fee, monthly
// service fee, and credit life insurance — as a proper month-by-month
// amortization schedule, not a single flat estimate. This is what gets
// shown in the quotation and the pre-agreement statement.
//
// Figures below are the National Credit Act's published maximum caps for
// short-term/unsecured credit as of the caps confirmed against the National
// Credit Regulator and legal-industry sources in 2026:
//   - Interest: 5%/month on a consumer's first loan in a calendar year,
//     3%/month on a repeat loan within the same year (Reg. on short-term
//     credit transactions)
//   - Initiation fee: R165 + 10% of the amount over R1,000, capped at R1,050
//   - Monthly service fee: capped at R60
//   - Credit life insurance: capped at R4.50 per R1,000 of the OUTSTANDING
//     balance per month (not the original loan amount — cost declines as
//     the loan is paid down)
//
// These are defaults, configurable via .env, and Khula's actual charged
// rates can be set at or below these caps — but not above them. NCA
// regulations are reviewed periodically by the dti/NCR; have your
// compliance officer confirm these are still current before relying on
// this for real quotations. See docs/COMPLIANCE.md.

const FIRST_LOAN_INTEREST_RATE = Number(process.env.INTEREST_RATE_FIRST_LOAN_PCT || 5) / 100;
const REPEAT_LOAN_INTEREST_RATE = Number(process.env.INTEREST_RATE_REPEAT_LOAN_PCT || 3) / 100;
const INITIATION_FEE_BASE = Number(process.env.INITIATION_FEE_BASE || 165);
const INITIATION_FEE_RATE = Number(process.env.INITIATION_FEE_RATE_PCT || 10) / 100;
const INITIATION_FEE_CAP = Number(process.env.INITIATION_FEE_CAP || 1050);
const MONTHLY_SERVICE_FEE = Number(process.env.MONTHLY_SERVICE_FEE || 60);
const CREDIT_LIFE_RATE_PER_1000 = Number(process.env.CREDIT_LIFE_RATE_PER_1000 || 4.5);

// NCA short-term credit transactions (the bracket these caps are drawn
// from) are defined for loans up to R8,000 over up to 6 months. Khula's
// platform allows up to R15,000 — amounts above R8,000 fall under a
// different NCA bracket (unsecured credit transactions) with a different,
// repo-rate-linked interest formula that this engine does NOT implement,
// because that formula depends on the prevailing SARB repo rate at the time
// of the calculation and hardcoding a rate here would silently go stale.
// Loans above this threshold are flagged in the quotation output so your
// compliance officer can confirm the correct formula before you quote one.
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
