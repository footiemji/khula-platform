const express = require('express');
const db = require('../lib/db');
const { sendWhatsAppMessage } = require('../lib/whatsappSender');
const { createApplication } = require('../lib/applicationEngine');
const { matchBankName } = require('../lib/bankCodes');

const router = express.Router();

// Serializes processing per phone number. Without this, two messages
// arriving close together from the same person (someone typing quickly,
// or a retry from Meta) can interleave — both webhook calls read the
// session before either has finished writing its update, so the second
// message gets processed against stale state instead of the first
// message's result. Different phone numbers still process fully in
// parallel; only messages from the SAME conversation are forced to wait
// their turn.
const sessionQueues = new Map();

function runSerialized(phone, task) {
  const previous = sessionQueues.get(phone) || Promise.resolve();
  const next = previous.then(task, task); // run task regardless of whether the previous one threw
  sessionQueues.set(phone, next.catch(() => {})); // don't let one failure jam the queue for future messages
  return next;
}

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

  runSerialized(from, async () => {
    const session = await getOrCreateSession(from);
    const reply = await advanceConversation(session, text);
    await sendWhatsAppMessage(from, reply);
  });
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

// A tiny, readable state machine. Each step reads the user's last reply,
// stores it, and asks the next question. On the final step it calls the
// same engine (server/lib/applicationEngine.js) the web widget and agent
// console use — one shared path, so a hard gate or consent requirement
// added there applies here too, not just on the other channels.
//
// Related fields are batched into single combined questions where doing so
// doesn't lose anything — a WhatsApp conversation with 25 separate
// round-trips would be worse UX than the form it's replacing, not better.
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
      session.step = 'ask_marital_status';
      await saveSession(session);
      return 'Marital status?\n1) Single\n2) Married in community of property\n3) Married out of community of property\n4) Divorced / widowed\n\nReply with a number 1-4.';

    case 'ask_marital_status': {
      const map = { 1: 'single', 2: 'married_in_community', 3: 'married_out_of_community', 4: 'divorced_widowed' };
      const choice = map[text.trim()];
      if (!choice) return 'Please reply with a number from 1 to 4.';
      session.data.maritalStatus = choice;
      session.step = 'ask_residential_status';
      await saveSession(session);
      return 'And your living situation?\n1) Own home (bond)\n2) Own home (paid off)\n3) Renting\n4) Living with family\n\nReply with a number 1-4.';
    }

    case 'ask_residential_status': {
      const map = { 1: 'own_bonded', 2: 'own_paid_off', 3: 'renting', 4: 'living_with_family' };
      const choice = map[text.trim()];
      if (!choice) return 'Please reply with a number from 1 to 4.';
      session.data.residentialStatus = choice;
      session.step = 'ask_debt_review';
      await saveSession(session);
      return 'Are you currently under debt review? Reply YES or NO. (If yes, we won\'t be able to proceed — this is a legal requirement, not a Khula policy choice.)';
    }

    case 'ask_debt_review':
      session.data.underDebtReview = /^y(es)?$/i.test(text.trim());
      session.step = 'ask_consent_bundle';
      await saveSession(session);
      return 'Almost through the legal bits — please confirm ALL of the following by replying AGREE:\n\n' +
        '✓ I consent to Khula processing my personal information under POPIA\n' +
        '✓ I consent to a credit bureau check being run on my profile\n' +
        '✓ All information I provide is true, accurate, and complete\n' +
        '✓ I have not withheld anything that could affect this decision\n' +
        '✓ I authorise Khula to verify the information I provide\n' +
        '✓ I understand this does not guarantee approval\n\n' +
        'Reply AGREE to continue, or STOP if you don\'t consent (we can\'t proceed without this).';

    case 'ask_consent_bundle':
      if (!/^agree$/i.test(text.trim())) {
        return 'We need your agreement to all of the above to continue. Reply AGREE when you\'re ready, or STOP to end here.';
      }
      session.data.popiaConsent = true;
      session.data.creditBureauConsent = true;
      session.data.declarationsAccepted = true;
      session.step = 'ask_employment';
      await saveSession(session);
      return 'What best describes your employment?\n1) Permanent employee\n2) Contract employee\n3) Self-employed\n4) Informal / piece work\n5) Unemployed\n\nReply with a number 1-5.';

    case 'ask_employment': {
      const map = { 1: 'formal_permanent', 2: 'formal_contract', 3: 'self_employed', 4: 'informal', 5: 'unemployed' };
      const choice = map[text.trim()];
      if (!choice) return 'Please reply with a number from 1 to 5.';
      session.data.employmentType = choice;
      session.step = 'ask_employer_details';
      await saveSession(session);
      return "Employer/business name and their phone number, in one message like:\nABC Traders, 0115551234\n\n(Reply 'skip' if self-employed/informal with no fixed employer)";
    }

    case 'ask_employer_details': {
      if (/^skip$/i.test(text.trim())) {
        session.data.employerName = null;
        session.data.employerPhone = null;
      } else {
        const parts = text.split(',').map((p) => p.trim());
        session.data.employerName = parts[0] || null;
        session.data.employerPhone = parts[1] || null;
      }
      session.step = 'ask_months_salary';
      await saveSession(session);
      return "How many months have you worked there, and what day of the month do you get paid? One message like:\n18 months, 25th\n\n(If paid on the last working day, just say 'last')";
    }

    case 'ask_months_salary': {
      const monthsMatch = text.match(/\d+/);
      if (!monthsMatch) return "Please include how many months, e.g. '18 months, 25th'";
      session.data.monthsEmployed = parseInt(monthsMatch[0], 10);
      const dayPart = text.split(',')[1] || text;
      session.data.salaryPaymentDate = dayPart.trim();
      session.step = 'ask_income';
      await saveSession(session);
      return "What's your average NET monthly income (after tax), in Rand? e.g. 8500";
    }

    case 'ask_income': {
      const income = Number(text.replace(/[^\d.]/g, ''));
      if (!income || income <= 0) return 'Please send just the number, e.g. 8500';
      session.data.netMonthlyIncome = income;
      session.step = 'ask_commission_overtime';
      await saveSession(session);
      return "Any regular commission or overtime (average over the last 3 months)? Reply with the Rand amount, or '0' if none.";
    }

    case 'ask_commission_overtime': {
      const amount = Number(text.replace(/[^\d.]/g, ''));
      if (isNaN(amount)) return "Please reply with a number, or '0' if none.";
      session.data.averageCommission3mo = amount;
      session.data.averageOvertime3mo = 0;
      session.step = 'ask_expenses';
      await saveSession(session);
      return "And your average monthly living expenses (rent, food, transport — not including other debt), in Rand?";
    }

    case 'ask_expenses': {
      const expenses = Number(text.replace(/[^\d.]/g, ''));
      if (expenses == null || isNaN(expenses) || expenses < 0) return 'Please send just the number, e.g. 4200';
      session.data.monthlyExpenses = expenses;
      session.step = 'ask_debts';
      await saveSession(session);
      return "Any other loans or accounts (store cards, other lenders)? List each on its own line like:\nCapfin, personal loan, 5000, 800\n\n(Provider, type, balance owed, monthly instalment)\n\nOr reply 'none' if you don't have any.";
    }

    case 'ask_debts': {
      if (/^none$/i.test(text.trim())) {
        session.data.existingDebts = [];
      } else {
        session.data.existingDebts = text.split('\n').map((line) => {
          const parts = line.split(',').map((p) => p.trim());
          return { provider: parts[0] || '', type: parts[1] || '', balance: Number(parts[2]) || 0, instalment: Number(parts[3]) || 0 };
        }).filter((d) => d.provider);
      }
      session.step = 'ask_amount';
      await saveSession(session);
      return `How much would you like to borrow? (Between R${process.env.MIN_LOAN_AMOUNT || 500} and R${process.env.MAX_LOAN_AMOUNT || 50000})`;
    }

    case 'ask_amount': {
      const amount = Number(text.replace(/[^\d.]/g, ''));
      if (!amount) return 'Please send just the number, e.g. 3000';
      session.data.requestedAmount = amount;
      session.step = 'ask_term';
      await saveSession(session);
      return `Over how many months would you like to repay? (1-${process.env.MAX_TERM_MONTHS || 60})`;
    }

    case 'ask_term': {
      const term = Number(text.replace(/[^\d.]/g, ''));
      const maxTerm = Number(process.env.MAX_TERM_MONTHS || 60);
      if (!term || term < 1 || term > maxTerm) return `Please reply with a number of months between 1 and ${maxTerm}.`;
      session.data.termMonths = term;
      session.step = 'ask_purpose';
      await saveSession(session);
      return "What's the loan for? (e.g. emergency, school fees, medical, home repairs)";
    }

    case 'ask_purpose':
      session.data.loanPurpose = text;
      session.step = 'ask_bank_holder';
      await saveSession(session);
      return "Almost done — I need your payout bank details. This account must be in your own name.\n\nWhat's the account holder's full name?";

    case 'ask_bank_holder':
      session.data.bankAccountHolder = text;
      session.step = 'ask_bank_name';
      await saveSession(session);
      return 'Which bank?';

    case 'ask_bank_name': {
      session.data.bankName = text;
      const matched = matchBankName(text);
      session.step = 'ask_account_number';
      if (matched && matched.branchCode) {
        // Recognised bank — branch code is universal, so there's no need
        // to ask for it at all.
        session.data.branchCode = matched.branchCode;
        session.data.bankName = matched.name; // use the canonical name, not whatever variant they typed
        session.data.branchCodeAutoFilled = true;
        await saveSession(session);
        return `Got it — ${matched.name} (branch code ${matched.branchCode} filled in automatically). Account number?`;
      }
      await saveSession(session);
      return 'Account number?';
    }

    case 'ask_account_number': {
      const acc = text.replace(/\s/g, '');
      if (!/^\d{6,17}$/.test(acc)) return "That doesn't look like a valid account number. Please try again.";
      session.data.accountNumber = acc;
      if (session.data.branchCodeAutoFilled) {
        // Already have the branch code — skip straight to finishing up.
        session.step = 'done';
        await saveSession(session);
        return await finalizeApplication(session);
      }
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

  const result = await createApplication(
    {
      fullName: d.fullName,
      idNumber: d.idNumber,
      phoneNumber: session.phone,
      maritalStatus: d.maritalStatus,
      residentialStatus: d.residentialStatus,
      underDebtReview: d.underDebtReview,
      popiaConsent: d.popiaConsent,
      creditBureauConsent: d.creditBureauConsent,
      declarationsAccepted: d.declarationsAccepted,
      employmentType: d.employmentType,
      employerName: d.employerName,
      employerPhone: d.employerPhone,
      monthsEmployed: d.monthsEmployed,
      salaryPaymentDate: d.salaryPaymentDate,
      netMonthlyIncome: d.netMonthlyIncome,
      averageCommission3mo: d.averageCommission3mo,
      averageOvertime3mo: d.averageOvertime3mo,
      monthlyExpenses: d.monthlyExpenses,
      existingDebts: d.existingDebts,
      requestedAmount: d.requestedAmount,
      termMonths: d.termMonths,
      loanPurpose: d.loanPurpose,
      bankAccountHolder: d.bankAccountHolder,
      bankName: d.bankName,
      accountNumber: d.accountNumber,
      branchCode: d.branchCode,
    },
    { channel: 'whatsapp', baseUrl: process.env.PUBLIC_APP_URL || 'https://your-domain.example' }
  );

  if (!result.ok) {
    return `Sorry, ${result.error} Message START to try again.`;
  }

  return result.response.message + '\n\nMessage us here anytime to check your status.';
}

module.exports = router;
