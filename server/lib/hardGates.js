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

const NON_TERMINAL_STATUSES = ['pending_kyc', 'manual_review', 'awaiting_signature', 'active'];

// Standalone so it can be checked EARLY in a conversation (right after ID
// and phone are captured, before 15 more questions get asked) rather than
// only at the very end via the full checkHardGates() call inside
// createApplication(). Making someone answer an entire application only
// to be rejected at the last step for something checkable on message two
// is exactly the wasted-time problem this exists to avoid.
async function findExistingApplication(idNumber, phoneNumber) {
  const idClean = String(idNumber || '').replace(/\s/g, '');
  if (!idClean && !phoneNumber) return null;
  return db.find('applications', (a) =>
    NON_TERMINAL_STATUSES.includes(a.status) &&
    ((idClean && a.idNumber === idClean) || (phoneNumber && a.phoneNumber === phoneNumber))
  );
}

/**
 * Runs the hard-gate checks. Returns { blocked: boolean, reasons: string[] }.
 * Called before affordability/risk scoring — if blocked is true, the
 * application should be declined immediately without running the rest of
 * the decision engine.
 */
async function checkHardGates(input) {
  const { idNumber, phoneNumber, underDebtReview, isUnrehabilitatedInsolvent } = input || {};
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

  const idClean = String(idNumber || '').replace(/\s/g, '');

  // Duplicate/flooding block — anyone with an existing loan or an
  // application still working through the pipeline can't start another
  // one. Checked by BOTH ID number and phone number, since either alone
  // is evadable (a different number, or claiming a different identity)
  // but matching on either catches most real attempts to get around it.
  // Applications that have reached a genuinely resolved state — declined,
  // completed, or expired — don't count; only ones still actually in
  // progress do.
  const existing = await findExistingApplication(idClean, phoneNumber);
  if (existing) {
    reasons.push(`You already have ${existing.status === 'active' ? 'an active loan' : 'a pending application'} with Khula (reference ${existing.reference}). Please wait for that to be resolved before applying again.`);
  }

  // Existing Khula loan in arrears — check for any active loan under this
  // ID number with an overdue instalment.
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

module.exports = { checkHardGates, ageFromSAIdNumber, findExistingApplication };
