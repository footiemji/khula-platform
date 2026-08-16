// Hard eligibility gates — 04_Underwriting_Policy.docx Section 3. These are
// automatic disqualifiers, not risk-score inputs: if any of these fire, the
// application is declined before affordability is even calculated. This is
// deliberately separate from server/lib/riskScore.js, which scores
// borderline cases — these are bright-line rules with no scoring involved.

const db = require('./db');

// South African ID numbers encode date of birth as the first 6 digits
// (YYMMDD) but not century — the standard convention (used across SA
// financial services) is: if the 2-digit year is greater than the current
// 2-digit year, assume 1900s; otherwise assume 2000s. This isn't perfect at
// the exact boundary, but it's the accepted practical approach given the ID
// number format itself doesn't disambiguate.
function ageFromSAIdNumber(idNumber) {
  const digits = String(idNumber || '').replace(/\s/g, '');
  if (!/^\d{13}$/.test(digits)) return null;

  const yy = parseInt(digits.slice(0, 2), 10);
  const mm = parseInt(digits.slice(2, 4), 10);
  const dd = parseInt(digits.slice(4, 6), 10);

  const currentYear = new Date().getFullYear();
  const currentYY = currentYear % 100;
  const century = yy > currentYY ? 1900 : 2000;
  const birthYear = century + yy;

  const birthDate = new Date(birthYear, mm - 1, dd);
  if (isNaN(birthDate.getTime()) || birthDate.getMonth() !== mm - 1) return null; // invalid date (e.g. day 31 in a 30-day month)

  const now = new Date();
  let age = now.getFullYear() - birthDate.getFullYear();
  const hasHadBirthdayThisYear = now.getMonth() > birthDate.getMonth() || (now.getMonth() === birthDate.getMonth() && now.getDate() >= birthDate.getDate());
  if (!hasHadBirthdayThisYear) age -= 1;

  return age;
}

/**
 * Runs the hard-gate checks. Returns { blocked: boolean, reasons: string[] }.
 * Called before affordability/risk scoring — if blocked is true, the
 * application should be declined immediately without running the rest of
 * the decision engine.
 */
async function checkHardGates(input) {
  const { idNumber, underDebtReview, isUnrehabilitatedInsolvent } = input || {};
  const reasons = [];

  const age = ageFromSAIdNumber(idNumber);
  if (age !== null && age < 18) {
    reasons.push('Applicant must be 18 years or older.');
  }

  if (underDebtReview) {
    reasons.push('Applicant is currently under debt review — applications cannot proceed while under debt review.');
  }

  if (isUnrehabilitatedInsolvent) {
    reasons.push('Applicant is an unrehabilitated insolvent.');
  }

  // Existing Khula loan in arrears — check for any active loan under this
  // ID number with an overdue instalment.
  const idClean = String(idNumber || '').replace(/\s/g, '');
  if (idClean) {
    const existingLoans = await db.filter('applications', (a) => a.idNumber === idClean && a.status === 'active');
    const hasArrears = existingLoans.some((loan) =>
      (loan.collections?.repaymentSchedule || []).some((installment) => installment.status === 'overdue')
    );
    if (hasArrears) {
      reasons.push('Applicant has an existing Khula loan currently in arrears.');
    }
  }

  return { blocked: reasons.length > 0, reasons, age };
}

module.exports = { checkHardGates, ageFromSAIdNumber };
