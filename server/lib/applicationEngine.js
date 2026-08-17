// Core application-creation logic, extracted so the web widget, the
// agent-assisted flow, and (in spirit) WhatsApp all run through the exact
// same validation, affordability, risk, and record-construction path.
// Duplicating this logic per channel is how it drifts out of sync — one
// engine, three front doors.

const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { assessAffordability } = require('./affordability');
const { scoreApplication, decide } = require('./riskScore');
const { checkVerificationToken } = require('./otp');
const { checkHardGates } = require('./hardGates');

function generateReference() {
  const stamp = Date.now().toString(36).toUpperCase();
  return `KHULA-${stamp}`;
}

// Loose check: does the payout account holder's name look like it's the
// same person as the applicant? This is a hint for the admin reviewer, NOT
// an authoritative match — the human review is still what actually decides.
function namesLooselyMatch(a, b) {
  const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean).sort();
  const partsA = normalize(a);
  const partsB = normalize(b);
  if (!partsA.length || !partsB.length) return null;
  const overlap = partsA.filter((p) => partsB.includes(p));
  return overlap.length > 0;
}

function messageForDecision(decisionType, record, baseUrl) {
  const base = baseUrl || '';
  switch (decisionType) {
    case 'approved': {
      const q = record.affordability.quotation;
      const ceilingNote = q.aboveShortTermCreditCeiling
        ? `\n\n⚠️ This amount is above R${q.shortTermCreditCeiling}, so it falls outside the standard short-term credit fee/interest caps — have this quote confirmed by compliance before it's relied on.`
        : '';
      return `Good news, ${record.fullName.split(' ')[0]}! Here's your quote for R${record.requestedAmount} over ${record.termMonths} months:\n\n` +
        `• Interest: ${(q.monthlyInterestRate * 100).toFixed(1)}%/month\n` +
        `• Initiation fee (once-off): R${q.initiationFee.toFixed(2)}\n` +
        `• Monthly service fee: R${q.monthlyServiceFee.toFixed(2)}\n` +
        `• Credit life insurance: from R${q.schedule[0].insurancePremium.toFixed(2)}/month (declines as you repay)\n` +
        `• First month's total instalment: R${q.firstMonthInstalment.toFixed(2)}\n` +
        `• Total cost of credit: R${q.totalCostOfCredit.toFixed(2)}\n` +
        `• Total you'll repay: R${q.totalRepayable.toFixed(2)}\n\n` +
        `Reference ${record.reference}.${ceilingNote}\n\nBefore we can pay out, we need 4 things: a copy of your ID, proof of address, 3 months' bank statements (or latest payslip), and proof of your bank account (for payout — must be in your name). Upload them here: ${base}/upload.html?ref=${record.reference}\n\nOur team reviews within 1 business day — you'll be notified here once you're cleared to sign.`;
    }
    case 'manual_review':
      return `Thanks ${record.fullName.split(' ')[0]}. Your application (${record.reference}) needs a quick human review — we'll be in touch on WhatsApp within 1 business day.`;
    case 'declined':
      return record.affordability?.suggestedAmount
        ? `Based on what you shared, R${record.requestedAmount} isn't affordable right now, but R${record.affordability.suggestedAmount} over the same term looks manageable. Reply to try that amount.`
        : `Based on what you shared, we can't offer a loan right now. Reference ${record.reference}.`;
    default:
      return `Your application (${record.reference}) has been received.`;
  }
}

/**
 * Validates and creates a loan application. Returns { ok: true, response }
 * on success, or { ok: false, status, error } on validation failure — the
 * caller (an Express route) maps that straight to an HTTP response.
 *
 * @param {object} input - raw application fields (same shape regardless of channel)
 * @param {object} options
 * @param {string} options.channel - 'web' | 'whatsapp' | 'agent_assisted'
 * @param {string} [options.baseUrl] - PUBLIC_APP_URL, for links in the message
 * @param {object} [options.agentContext] - { agentId, agentCode, agentName, shopName } when channel is 'agent_assisted'
 */
async function createApplication(input, options = {}) {
  const { channel = 'web', baseUrl, agentContext = null } = options;
  const {
    fullName,
    idNumber,
    phoneNumber,
    alternatePhoneNumber,
    email,
    employmentType,
    employerName,
    employerAddress,
    employerPhone,
    jobTitle,
    monthsEmployed,
    salaryPaymentDate,
    netMonthlyIncome,
    grossMonthlyIncome,
    averageCommission3mo,
    averageOvertime3mo,
    monthlyExpenses,
    existingDebts, // array of { provider, type, balance, instalment } — replaces the old single existingDebtInstalments number
    requestedAmount,
    termMonths,
    loanPurpose,
    maritalStatus, // 'single' | 'married_in_community' | 'married_out_of_community' | 'divorced_widowed'
    residentialStatus, // 'own_bonded' | 'own_paid_off' | 'renting' | 'living_with_family'
    nationality, // 'sa_citizen' | 'permanent_resident'
    underDebtReview,
    isUnrehabilitatedInsolvent,
    popiaConsent,
    creditBureauConsent,
    declarationsAccepted, // single boolean covering the batched declaration set — see messageForDecision/UI for the itemized list shown to the applicant
    phoneVerificationToken,
    bankAccountHolder,
    bankName,
    accountNumber,
    branchCode,
  } = input || {};

  // ---- Consent & declarations (04_POPIA_Privacy_Notice + 07_Loan_Application_Form Section H) ----
  if (!popiaConsent) {
    return { ok: false, status: 400, error: 'POPIA consent is required before we can process an application.' };
  }
  if (!creditBureauConsent) {
    return { ok: false, status: 400, error: 'Credit bureau consent is required before we can process an application.' };
  }
  if (!declarationsAccepted) {
    return { ok: false, status: 400, error: 'You must accept the applicant declarations before we can process an application.' };
  }
  if (!fullName || !idNumber || !phoneNumber) {
    return { ok: false, status: 400, error: 'Full name, ID number and phone number are required.' };
  }
  if (!bankAccountHolder || !bankName || !accountNumber) {
    return { ok: false, status: 400, error: 'Payout bank account details (account holder, bank, account number) are required.' };
  }

  // Phone verification is required for every channel except WhatsApp
  // (messaging FROM a number is itself proof of control) — including
  // agent-assisted applications. This matters MORE in the agent channel,
  // not less: it's the check that stops an agent from enrolling people
  // using a phone number they don't actually control.
  if (channel !== 'whatsapp') {
    const verified = await checkVerificationToken(phoneNumber, phoneVerificationToken);
    if (!verified) {
      return { ok: false, status: 400, error: 'Phone number is not verified. Request and confirm a verification code first.' };
    }
  }

  const idClean = String(idNumber).replace(/\s/g, '');
  if (!/^\d{13}$/.test(idClean)) {
    return { ok: false, status: 400, error: 'ID number must be 13 digits.' };
  }

  const accountClean = String(accountNumber).replace(/\s/g, '');
  if (!/^\d{6,17}$/.test(accountClean)) {
    return { ok: false, status: 400, error: 'Account number looks invalid — please check and re-enter.' };
  }

  // ---- Hard eligibility gates (04_Underwriting_Policy.docx Section 3) ----
  // These are bright-line disqualifiers, checked BEFORE affordability —
  // there's no path to approval regardless of how affordable the loan
  // looks if one of these fires.
  const gateResult = await checkHardGates({ idNumber: idClean, underDebtReview, isUnrehabilitatedInsolvent });
  if (gateResult.blocked) {
    return { ok: false, status: 400, error: gateResult.reasons.join(' ') };
  }

  // ---- Itemized existing debts (replaces the old single aggregate number) ----
  const debtsList = Array.isArray(existingDebts) ? existingDebts.filter((d) => d && (d.balance || d.instalment)) : [];
  const totalExistingDebtInstalments = debtsList.reduce((sum, d) => sum + (Number(d.instalment) || 0), 0);

  // ---- Income calc with commission/overtime averaged at 50% (Underwriting Policy 5.1) ----
  const declaredNetIncome = Number(netMonthlyIncome) || 0;
  const commissionComponent = (Number(averageCommission3mo) || 0) * 0.5;
  const overtimeComponent = (Number(averageOvertime3mo) || 0) * 0.5;
  const effectiveNetIncome = declaredNetIncome + commissionComponent + overtimeComponent;

  const previousLoans = await db.filter('applications', (a) => a.idNumber === idClean && a.decision === 'approved');
  const thisCalendarYear = new Date().getFullYear();
  const previousLoansThisYear = previousLoans.filter((a) => new Date(a.createdAt).getFullYear() === thisCalendarYear);
  const isFirstLoan = previousLoansThisYear.length === 0;
  const missedPayments = previousLoans.filter((a) => a.repaymentStatus === 'missed').length;

  const affordability = assessAffordability({
    netMonthlyIncome: effectiveNetIncome,
    monthlyExpenses: Number(monthlyExpenses),
    existingDebtInstalments: totalExistingDebtInstalments,
    requestedAmount: Number(requestedAmount),
    termMonths: Number(termMonths),
    isFirstLoan,
  });

  if (affordability.errors && affordability.errors.length) {
    return { ok: false, status: 400, error: affordability.errors.join(' ') };
  }

  const risk = scoreApplication({
    employmentType,
    monthsEmployed: Number(monthsEmployed || 0),
    netMonthlyIncome: effectiveNetIncome,
    existingDebtInstalments: totalExistingDebtInstalments,
    requestedAmount: Number(requestedAmount),
    previousLoansWithKhula: previousLoans.length,
    missedPaymentsWithKhula: missedPayments,
  });

  const outcome = decide({ affordability, risk });

  const record = {
    id: uuidv4(),
    reference: generateReference(),
    createdAt: new Date().toISOString(),
    channel,
    agent: agentContext ? { agentId: agentContext.agentId, agentCode: agentContext.agentCode, agentName: agentContext.agentName, shopName: agentContext.shopName } : null,
    status: outcome.decision === 'approved' ? 'pending_kyc' : outcome.decision,
    decision: outcome.decision,
    fullName,
    idNumber: idClean,
    ageAtApplication: gateResult.age,
    phoneNumber,
    alternatePhoneNumber: alternatePhoneNumber || null,
    email: email || null,
    phoneVerified: channel === 'whatsapp' ? true : Boolean(phoneVerificationToken),
    maritalStatus: maritalStatus || null,
    residentialStatus: residentialStatus || null,
    nationality: nationality || null,
    employmentType,
    employerName: employerName || null,
    employerAddress: employerAddress || null,
    employerPhone: employerPhone || null,
    jobTitle: jobTitle || null,
    monthsEmployed: Number(monthsEmployed || 0),
    salaryPaymentDate: salaryPaymentDate || null,
    netMonthlyIncome: declaredNetIncome,
    grossMonthlyIncome: grossMonthlyIncome ? Number(grossMonthlyIncome) : null,
    averageCommission3mo: averageCommission3mo ? Number(averageCommission3mo) : 0,
    averageOvertime3mo: averageOvertime3mo ? Number(averageOvertime3mo) : 0,
    effectiveNetIncome,
    monthlyExpenses: Number(monthlyExpenses),
    existingDebts: debtsList,
    existingDebtInstalments: totalExistingDebtInstalments,
    requestedAmount: Number(requestedAmount),
    termMonths: Number(termMonths),
    loanPurpose: loanPurpose || null,
    underDebtReview: Boolean(underDebtReview),
    popiaConsent: true,
    popiaConsentAt: new Date().toISOString(),
    creditBureauConsent: true,
    creditBureauConsentAt: new Date().toISOString(),
    declarationsAccepted: true,
    declarationsAcceptedAt: new Date().toISOString(),
    bankAccountHolder,
    bankName,
    accountNumber: accountClean,
    branchCode: branchCode || null,
    payoutNameLooselyMatches: namesLooselyMatch(fullName, bankAccountHolder),
    affordability,
    risk,
    kyc: {
      status: outcome.decision === 'approved' ? 'awaiting_documents' : 'not_applicable',
      identityVerified: false,
      addressVerified: false,
      employmentVerified: false,
      payoutAccountVerified: false,
      documents: [],
      reviewedBy: null,
      reviewedAt: null,
      auditLog: [],
    },
    underwriting: {
      bureauChecked: false,
      bureauCheckedBy: null,
      bureauCheckedAt: null,
      employmentConfirmed: null,
      creditRecordClean: null,
      judgmentsOrDefaultsFound: null,
      notes: null,
      // Declared vs. verified income — 05_Affordability_Assessment.docx
      // Section B. Populated by admin during KYC review, not at
      // application time — the applicant's own figures are what's used
      // above; this is where a reviewer records what the documents
      // actually show, if it differs.
      verifiedNetMonthlyIncome: null,
      verifiedMonthlyExpenses: null,
      incomeVerificationNote: null,
    },
    collections: {
      debicheckStatus: 'not_started', // not_started | mandate_sent | mandate_confirmed | mandate_declined
      mandateReference: null,
      mandateSentAt: null,
      mandateConfirmedAt: null,
    },
    disbursement: {
      status: 'not_applicable', // not_applicable (pre-signature) | pending_mandate | disbursed
      disbursedAt: null,
      confirmedBy: null,
    },
    legal: {
      section129NoticeSent: false,
      section129SentAt: null,
      handedToCollector: false,
      handedToCollectorAt: null,
      collectorReference: null,
      magistratesCourtJudgment: false,
      judgmentDate: null,
      judgmentReference: null,
      enforcementMechanism: null, // 'eao' | 'garnishee' | 'warrant_of_execution' | null
      enforcementInitiatedAt: null,
      notes: [],
    },
    signature: null,
    reconsiderationDeadline: null,
    adminNotes: [],
  };

  await db.insert('applications', record);

  return {
    ok: true,
    response: {
      reference: record.reference,
      decision: record.decision,
      status: record.status,
      proposedInstalment: affordability.proposedInstalment,
      suggestedAmount: affordability.suggestedAmount,
      quotation: affordability.quotation,
      message: messageForDecision(outcome.decision, record, baseUrl),
    },
  };
}

module.exports = { createApplication, generateReference, namesLooselyMatch, messageForDecision };
