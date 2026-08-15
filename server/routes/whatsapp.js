const express = require('express');
const db = require('../lib/db');
const { assessAffordability } = require('../lib/affordability');
const { scoreApplication, decide } = require('../lib/riskScore');
const { sendWhatsAppMessage } = require('../lib/whatsappSender');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/whatsapp/webhook — Meta's verification handshake.
// When you register this URL in the Meta App Dashboard, it calls this with
// hub.mode / hub.verify_token / hub.challenge and expects the challenge back.
// ---------------------------------------------------------------------------
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---------------------------------------------------------------------------
// POST /api/whatsapp/webhook — inbound messages land here.
// This is a minimal, dependency-free conversational state machine that walks
// a borrower through the same fields as the web widget, one WhatsApp message
// at a time. Swap `sendWhatsAppMessage` for real Graph API calls once you
// have WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID (see README).
// ---------------------------------------------------------------------------
router.post('/webhook', async (req, res) => {
  // Acknowledge immediately — Meta requires a fast 200 regardless of
  // processing outcome, or it will retry and duplicate messages.
  res.sendStatus(200);

  const entry = req.body?.entry?.[0];
  const change = entry?.changes?.[0]?.value;
  const message = change?.messages?.[0];
  if (!message) return; // status callbacks, etc — nothing to do

  const from = message.from; // WhatsApp user's phone number (E.164, no +)
  const text = (message.text?.body || '').trim();

  const session = await getOrCreateSession(from);
  const reply = await advanceConversation(session, text);
  await sendWhatsAppMessage(from, reply);
});

function getOrCreateSession(phone) {
  return (async () => {
    let session = await db.find('conversations', (c) => c.phone === phone);
    if (!session) {
      session = { phone, step: 'welcome', data: {}, updatedAt: new Date().toISOString() };
      await db.insert('conversations', session);
    }
    return session;
  })();
}

async function saveSession(session) {
  await db.update('conversations', (c) => c.phone === session.phone, () => ({ ...session, updatedAt: new Date().toISOString() }));
}

const STEPS = [
  'welcome',
  'ask_name',
  'ask_id',
  'ask_consent',
  'ask_employment',
  'ask_income',
  'ask_expenses',
  'ask_amount',
  'ask_term',
  'done',
];

// A tiny, readable state machine. Each step reads the user's last reply,
// stores it, and asks the next question. On the final step it calls the same
// affordability + risk logic the web app uses.
async function advanceConversation(session, text) {
  switch (session.step) {
    case 'welcome':
      session.step = 'ask_name';
      await saveSession(session);
      return "Welcome to Khula Financial Services 🌱 Grow. Thrive. Rise.\n\nI can get you a loan decision in under 2 minutes. What's your full name?";

    case 'ask_name':
      session.data.fullName = text;
      session.step = 'ask_id';
      await saveSession(session);
      return `Thanks ${text.split(' ')[0]}. What's your 13-digit South African ID number? (This stays private and is only used to verify your identity.)`;

    case 'ask_id':
      if (!/^\d{13}$/.test(text.replace(/\s/g, ''))) {
        return "That doesn't look like a valid 13-digit ID number. Please try again.";
      }
      session.data.idNumber = text.replace(/\s/g, '');
      session.step = 'ask_consent';
      await saveSession(session);
      return 'Before we continue: do you consent to Khula processing your personal information under POPIA to assess this loan application? Reply YES to continue.';

    case 'ask_consent':
      if (!/^y(es)?$/i.test(text)) {
        return 'No problem — we need consent to proceed. Reply YES whenever you\'re ready.';
      }
      session.data.popiaConsent = true;
      session.step = 'ask_employment';
      await saveSession(session);
      return 'What best describes your employment?\n1) Permanent employee\n2) Contract employee\n3) Self-employed\n4) Informal / piece work\n5) Unemployed\n\nReply with a number 1-5.';

    case 'ask_employment': {
      const map = { 1: 'formal_permanent', 2: 'formal_contract', 3: 'self_employed', 4: 'informal', 5: 'unemployed' };
      const choice = map[text.trim()];
      if (!choice) return 'Please reply with a number from 1 to 5.';
      session.data.employmentType = choice;
      session.step = 'ask_income';
      await saveSession(session);
      return "What's your average NET monthly income (after tax), in Rand? e.g. 8500";
    }

    case 'ask_income': {
      const income = Number(text.replace(/[^\d.]/g, ''));
      if (!income || income <= 0) return 'Please send just the number, e.g. 8500';
      session.data.netMonthlyIncome = income;
      session.step = 'ask_expenses';
      await saveSession(session);
      return "And your average monthly expenses (rent, food, transport, existing debt), in Rand?";
    }

    case 'ask_expenses': {
      const expenses = Number(text.replace(/[^\d.]/g, ''));
      if (expenses == null || isNaN(expenses) || expenses < 0) return 'Please send just the number, e.g. 4200';
      session.data.monthlyExpenses = expenses;
      session.step = 'ask_amount';
      await saveSession(session);
      return `How much would you like to borrow? (Between R${process.env.MIN_LOAN_AMOUNT || 500} and R${process.env.MAX_LOAN_AMOUNT || 15000})`;
    }

    case 'ask_amount': {
      const amount = Number(text.replace(/[^\d.]/g, ''));
      if (!amount) return 'Please send just the number, e.g. 3000';
      session.data.requestedAmount = amount;
      session.step = 'ask_term';
      await saveSession(session);
      return 'Over how many months would you like to repay? (1-36)';
    }

    case 'ask_term': {
      const term = Number(text.replace(/[^\d.]/g, ''));
      if (!term || term < 1 || term > 36) return 'Please reply with a number of months between 1 and 36.';
      session.data.termMonths = term;
      session.step = 'ask_bank_holder';
      await saveSession(session);
      return "Almost done — I need your payout bank details. This account must be in your own name.\n\nWhat's the account holder's full name?";
    }

    case 'ask_bank_holder':
      session.data.bankAccountHolder = text;
      session.step = 'ask_bank_name';
      await saveSession(session);
      return 'Which bank?';

    case 'ask_bank_name':
      session.data.bankName = text;
      session.step = 'ask_account_number';
      await saveSession(session);
      return 'Account number?';

    case 'ask_account_number': {
      const acc = text.replace(/\s/g, '');
      if (!/^\d{6,17}$/.test(acc)) return "That doesn't look like a valid account number. Please try again.";
      session.data.accountNumber = acc;
      session.step = 'ask_branch_code';
      await saveSession(session);
      return 'Branch code? (reply "skip" if you don\'t have it handy)';
    }

    case 'ask_branch_code':
      session.data.branchCode = /^skip$/i.test(text.trim()) ? null : text.replace(/\s/g, '');
      session.step = 'done';
      await saveSession(session);
      return await finalizeApplication(session);

    case 'done':
    default:
      session.step = 'welcome';
      session.data = {};
      await saveSession(session);
      return "Let's start a new application. What's your full name?";
  }
}

async function finalizeApplication(session) {
  const d = session.data;

  const previousLoans = await db.filter('applications', (a) => a.idNumber === d.idNumber && a.decision === 'approved');
  const thisCalendarYear = new Date().getFullYear();
  const previousLoansThisYear = previousLoans.filter((a) => new Date(a.createdAt).getFullYear() === thisCalendarYear);
  const isFirstLoan = previousLoansThisYear.length === 0;
  const missedPayments = previousLoans.filter((a) => a.repaymentStatus === 'missed').length;

  const affordability = assessAffordability({
    netMonthlyIncome: d.netMonthlyIncome,
    monthlyExpenses: d.monthlyExpenses,
    existingDebtInstalments: 0,
    requestedAmount: d.requestedAmount,
    termMonths: d.termMonths,
    isFirstLoan,
  });

  if (affordability.errors.length) {
    return `Sorry, ${affordability.errors.join(' ')} Message START to try again.`;
  }

  const risk = scoreApplication({
    employmentType: d.employmentType,
    monthsEmployed: 12,
    netMonthlyIncome: d.netMonthlyIncome,
    existingDebtInstalments: 0,
    requestedAmount: d.requestedAmount,
    previousLoansWithKhula: previousLoans.length,
    missedPaymentsWithKhula: missedPayments,
  });

  const outcome = decide({ affordability, risk });
  const reference = `KHULA-${Date.now().toString(36).toUpperCase()}`;

  const namesMatch = namesLooselyMatch(d.fullName, d.bankAccountHolder);

  await db.insert('applications', {
    id: reference,
    reference,
    createdAt: new Date().toISOString(),
    channel: 'whatsapp',
    status: outcome.decision === 'approved' ? 'pending_kyc' : outcome.decision,
    decision: outcome.decision,
    fullName: d.fullName,
    idNumber: d.idNumber,
    phoneNumber: session.phone,
    phoneVerified: true, // messaging FROM this number is itself the proof of control
    employmentType: d.employmentType,
    netMonthlyIncome: d.netMonthlyIncome,
    monthlyExpenses: d.monthlyExpenses,
    existingDebtInstalments: 0,
    requestedAmount: d.requestedAmount,
    termMonths: d.termMonths,
    popiaConsent: true,
    popiaConsentAt: new Date().toISOString(),
    bankAccountHolder: d.bankAccountHolder,
    bankName: d.bankName,
    accountNumber: d.accountNumber,
    branchCode: d.branchCode,
    payoutNameLooselyMatches: namesMatch,
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
    },
    collections: {
      debicheckStatus: 'not_started',
      mandateReference: null,
      mandateSentAt: null,
      mandateConfirmedAt: null,
    },
    signature: null,
    reconsiderationDeadline: null,
    adminNotes: [],
  });

  if (outcome.decision === 'approved') {
    const base = process.env.PUBLIC_APP_URL || 'https://your-domain.example';
    const q = affordability.quotation;
    const ceilingNote = q.aboveShortTermCreditCeiling
      ? `\n\n⚠️ Above R${q.shortTermCreditCeiling} — needs compliance confirmation on applicable fee/interest caps before this quote is final.`
      : '';
    return `You're pre-approved, ${d.fullName.split(' ')[0]}! 🎉\n\n` +
      `Interest: ${(q.monthlyInterestRate * 100).toFixed(1)}%/month\n` +
      `Initiation fee: R${q.initiationFee.toFixed(2)}\n` +
      `Monthly service fee: R${q.monthlyServiceFee.toFixed(2)}\n` +
      `Insurance: from R${q.schedule[0].insurancePremium.toFixed(2)}/month\n` +
      `First instalment: R${q.firstMonthInstalment.toFixed(2)}\n` +
      `Total repayable: R${q.totalRepayable.toFixed(2)}\n\n` +
      `Reference: ${reference}${ceilingNote}\n\nBefore we can pay out we need 4 documents: ID copy, proof of address, proof of income, and proof of your bank account. Upload them here: ${base}/upload.html?ref=${reference}\n\nOur team reviews within 1 business day — message us here anytime to check your status.`;
  }
  if (outcome.decision === 'manual_review') {
    return `Thanks ${d.fullName.split(' ')[0]}. Reference ${reference} needs a quick human review — we'll message you here within 1 business day.`;
  }
  return affordability.suggestedAmount
    ? `R${d.requestedAmount} isn't affordable right now, but R${affordability.suggestedAmount} over ${d.termMonths} months looks manageable. Reply with that amount to re-apply, or START to begin again.`
    : `We can't offer a loan right now. Reference ${reference}. Message START to try again in future.`;
}

function namesLooselyMatch(a, b) {
  const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean).sort();
  const partsA = normalize(a);
  const partsB = normalize(b);
  if (!partsA.length || !partsB.length) return null;
  const overlap = partsA.filter((p) => partsB.includes(p));
  return overlap.length > 0;
}

module.exports = router;
