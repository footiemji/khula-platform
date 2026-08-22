const express = require('express');
const db = require('../lib/db');
const { sendWhatsAppMessage } = require('../lib/whatsappSender');
const { createApplication, signApplication, getPublicAppUrl } = require('../lib/applicationEngine');
const { matchBankName } = require('../lib/bankCodes');
const { sendWhatsAppList, sendWhatsAppButtons } = require('../lib/whatsappSender');

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

  // Delivery status updates — sent/delivered/read/failed — arrive on this
  // SAME webhook, as a `statuses` array rather than `messages`. This is
  // the only place a real delivery failure reason actually shows up: the
  // send API call can return a message ID successfully (meaning Meta
  // accepted the request) while the message still never reaches the
  // phone — e.g. because the 24-hour customer-service window closed, or
  // the recipient isn't reachable on WhatsApp. Logging these is what
  // turns "message not received, no idea why" into an actual diagnosis
  // instead of a guess.
  const statuses = change?.statuses;
  if (statuses && statuses.length) {
    statuses.forEach((s) => {
      if (s.status === 'failed') {
        const errorDetail = (s.errors || []).map((e) => `${e.code}: ${e.title}${e.message ? ' — ' + e.message : ''}`).join('; ');
        console.error(`[WhatsApp DELIVERY FAILED -> ${s.recipient_id}] message ${s.id}: ${errorDetail || 'no error detail provided'}`);
      } else {
        console.log(`[WhatsApp STATUS -> ${s.recipient_id}] message ${s.id}: ${s.status}`);
      }
    });
  }

  const message = change?.messages?.[0];
  if (!message) return; // no inbound message on this webhook call (e.g. it was a status update, handled above)

  const from = message.from; // WhatsApp user's phone number (E.164, no +)
  // Tapping a list/button option comes back as message.interactive.*_reply.id
  // rather than a text body — extract whichever applies. Using the
  // semantic id (e.g. "single", "married_in_community") set when the list
  // was sent means the conversation handlers below don't need a separate
  // lookup table to interpret a tapped reply versus typed text.
  const text = (
    message.interactive?.list_reply?.id ||
    message.interactive?.button_reply?.id ||
    message.text?.body ||
    ''
  ).trim();

  runSerialized(from, async () => {
    const { session, isNew } = await getOrCreateSession(from);

    // If this is a brand-new conversation AND there's a recent, unverified
    // OTP request for this number, they almost certainly got here by
    // tapping the "message us first" link from the website — not by
    // deciding to apply natively on WhatsApp. Launching the full
    // application flow in that case is exactly what caused the reported
    // confusion: people end up mid-conversation on WhatsApp with no clear
    // signal to go back, so most just... stay. Redirect them explicitly
    // instead, while still leaving the door open to continue right here
    // if that's what they'd rather do.
    if (isNew && text.length > 0) {
      const recentOtp = await db.find(
        'otp_verifications',
        (o) => o.phone === from && !o.verified && Date.now() - new Date(o.createdAt).getTime() < 10 * 60 * 1000
      );
      if (recentOtp) {
        session.step = 'post_web_redirect';
        session.data.redirectedAt = new Date().toISOString();
        await saveSession(session);
        await sendWhatsAppMessage(
          from,
          "Thanks — you're all set! Head back to the website to continue your application.\n\nPrefer to finish here on WhatsApp instead? Just reply with your full name and we'll carry on right here."
        );
        return;
      }
    }

    const reply = await advanceConversation(session, text);
    await sendReply(from, reply);
  });
});

// Dispatches an advanceConversation() result to the right WhatsApp send
// function. Most steps just return a plain string (sent as normal text);
// steps with a small, fixed set of options return a small descriptor
// object instead, so the customer gets a real tappable list/buttons
// rather than being asked to type a number — this is what actually fixes
// "reply with 1-4", not just clearer wording around it.
async function sendReply(to, reply) {
  if (typeof reply === 'string') {
    return sendWhatsAppMessage(to, reply);
  }
  if (reply.interactive === 'list') {
    return sendWhatsAppList(to, reply.body, reply.buttonLabel || 'Select', reply.options);
  }
  if (reply.interactive === 'buttons') {
    return sendWhatsAppButtons(to, reply.body, reply.options);
  }
  return sendWhatsAppMessage(to, String(reply));
}

function getOrCreateSession(phone) {
  return (async () => {
    let session = await db.find('conversations', (c) => c.phone === phone);
    if (session) return { session, isNew: false };
    session = { phone, step: 'welcome', data: {}, updatedAt: new Date().toISOString() };
    await db.insert('conversations', session);
    return { session, isNew: true };
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
    case 'post_web_redirect': {
      // Someone who was told "head back to the website" and then messaged
      // again. If it's soon after (they're clearly choosing to continue
      // here instead), treat their message as the start of a native
      // WhatsApp application. If it's been a while, they probably went
      // back to the website, finished there, and are now messaging for an
      // unrelated reason (a status check, a question) — don't wrongly
      // swallow that as if it were their name.
      const redirectedAt = new Date(session.data.redirectedAt || 0);
      const minutesSinceRedirect = (Date.now() - redirectedAt.getTime()) / (1000 * 60);
      if (minutesSinceRedirect < 30) {
        session.data.fullName = text;
        session.step = 'ask_id';
        await saveSession(session);
        return `Thanks ${text.split(' ')[0]}. What's your 13-digit South African ID number? (This stays private and is only used to verify your identity.)`;
      }
      return await checkExistingOrOfferFresh(session);
    }

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
      return {
        interactive: 'list',
        body: 'Marital status?',
        buttonLabel: 'Select',
        options: [
          { id: 'single', title: 'Single' },
          { id: 'married_in_community', title: 'Married in community' },
          { id: 'married_out_of_community', title: 'Married out of comm.' },
          { id: 'divorced_widowed', title: 'Divorced/widowed' },
        ],
      };

    case 'ask_marital_status': {
      const valid = ['single', 'married_in_community', 'married_out_of_community', 'divorced_widowed'];
      if (!valid.includes(text)) {
        return { interactive: 'list', body: 'Please pick one from the list.', buttonLabel: 'Select', options: valid.map((v) => ({ id: v, title: v.replace(/_/g, ' ') })) };
      }
      session.data.maritalStatus = text;
      session.step = 'ask_residential_status';
      await saveSession(session);
      return {
        interactive: 'list',
        body: 'And your living situation?',
        buttonLabel: 'Select',
        options: [
          { id: 'own_bonded', title: 'Own home (bond)' },
          { id: 'own_paid_off', title: 'Own home (paid off)' },
          { id: 'renting', title: 'Renting' },
          { id: 'living_with_family', title: 'Living with family' },
        ],
      };
    }

    case 'ask_residential_status': {
      const valid = ['own_bonded', 'own_paid_off', 'renting', 'living_with_family'];
      if (!valid.includes(text)) {
        return { interactive: 'list', body: 'Please pick one from the list.', buttonLabel: 'Select', options: valid.map((v) => ({ id: v, title: v.replace(/_/g, ' ') })) };
      }
      session.data.residentialStatus = text;
      session.step = 'ask_debt_review';
      await saveSession(session);
      return {
        interactive: 'buttons',
        body: "Are you currently under debt review? (If yes, we won't be able to proceed — this is a legal requirement, not a Khula policy choice.)",
        options: [{ id: 'no', title: 'No' }, { id: 'yes', title: 'Yes' }],
      };
    }

    case 'ask_debt_review':
      session.data.underDebtReview = text === 'yes' || /^y(es)?$/i.test(text.trim());
      session.step = 'ask_consent_bundle';
      await saveSession(session);
      return {
        interactive: 'buttons',
        body: 'Almost through the legal bits — please confirm ALL of the following:\n\n' +
          '✓ I consent to Khula processing my personal information under POPIA\n' +
          '✓ I consent to a credit bureau check being run on my profile\n' +
          '✓ All information I provide is true, accurate, and complete\n' +
          '✓ I have not withheld anything that could affect this decision\n' +
          '✓ I authorise Khula to verify the information I provide\n' +
          '✓ I understand this does not guarantee approval',
        options: [{ id: 'agree', title: 'I agree' }, { id: 'stop', title: 'Stop' }],
      };

    case 'ask_consent_bundle':
      if (text === 'stop' || /^stop$/i.test(text.trim())) {
        return "No problem — we can't proceed without this consent, but message us anytime if you change your mind.";
      }
      if (text !== 'agree' && !/^agree$/i.test(text.trim())) {
        return {
          interactive: 'buttons',
          body: "We need your agreement to all of the above to continue.",
          options: [{ id: 'agree', title: 'I agree' }, { id: 'stop', title: 'Stop' }],
        };
      }
      session.data.popiaConsent = true;
      session.data.creditBureauConsent = true;
      session.data.declarationsAccepted = true;
      session.step = 'ask_employment';
      await saveSession(session);
      return {
        interactive: 'list',
        body: 'What best describes your employment?',
        buttonLabel: 'Select',
        options: [
          { id: 'formal_permanent', title: 'Permanent employee' },
          { id: 'formal_contract', title: 'Contract employee' },
          { id: 'self_employed', title: 'Self-employed' },
          { id: 'informal', title: 'Informal/piece work' },
          { id: 'unemployed', title: 'Unemployed' },
        ],
      };

    case 'ask_employment': {
      const valid = ['formal_permanent', 'formal_contract', 'self_employed', 'informal', 'unemployed'];
      if (!valid.includes(text)) {
        return { interactive: 'list', body: 'Please pick one from the list.', buttonLabel: 'Select', options: valid.map((v) => ({ id: v, title: v.replace(/_/g, ' ') })) };
      }
      session.data.employmentType = text;
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
      return {
        interactive: 'buttons',
        body: `Over how many months would you like to repay? Pick a common option, or just type a number (1-${process.env.MAX_TERM_MONTHS || 60}).`,
        options: [{ id: '3', title: '3 months' }, { id: '6', title: '6 months' }, { id: '12', title: '12 months' }],
      };
    }

    case 'ask_term': {
      const term = Number(text.replace(/[^\d.]/g, ''));
      const maxTerm = Number(process.env.MAX_TERM_MONTHS || 60);
      if (!term || term < 1 || term > maxTerm) return `Please reply with a number of months between 1 and ${maxTerm}, or tap one of the options above.`;
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
      return {
        interactive: 'list',
        body: 'Which bank?',
        buttonLabel: 'Select bank',
        // WhatsApp lists cap out at 10 rows total — trimmed to the 9 most
        // commonly used banks plus "Other" rather than the full list the
        // web/agent dropdowns can show, which don't have that limit.
        options: [
          { id: 'Absa', title: 'Absa' },
          { id: 'African Bank', title: 'African Bank' },
          { id: 'Capitec', title: 'Capitec' },
          { id: 'Discovery Bank', title: 'Discovery Bank' },
          { id: 'FNB', title: 'FNB' },
          { id: 'Investec', title: 'Investec' },
          { id: 'Nedbank', title: 'Nedbank' },
          { id: 'Standard Bank', title: 'Standard Bank' },
          { id: 'TymeBank', title: 'TymeBank' },
          { id: 'Other', title: 'Other' },
        ],
      };

    case 'ask_bank_name': {
      if (text === 'Other') {
        session.step = 'ask_bank_name_other';
        await saveSession(session);
        return 'No problem — please type your bank\'s name.';
      }
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

    case 'ask_bank_name_other': {
      session.data.bankName = text;
      const matched = matchBankName(text);
      session.step = 'ask_account_number';
      if (matched && matched.branchCode) {
        session.data.branchCode = matched.branchCode;
        session.data.bankName = matched.name;
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
    default: {
      // Someone messaging after "done" almost always means they're
      // checking in on an application they already submitted — not
      // starting fresh. Blindly resetting here (the old behaviour) broke
      // the platform's own promise to "message us anytime to check your
      // status": there was no status check at all, just a silent restart.
      return await checkExistingOrOfferFresh(session);
    }

    case 'awaiting_sign_name': {
      if (!/^sign$/i.test(text.trim())) {
        // They typed something other than "SIGN" — treat it as their
        // typed-name signature directly, so "reply SIGN" isn't a hard
        // requirement if they just type their name straight away.
        const result = await signApplication(session.data.signingReference, text, null);
        session.step = 'welcome';
        session.data = {};
        await saveSession(session);
        if (!result.ok) return `${result.error} Message us here if you need help.`;
        return `Signed! Reference ${result.application.reference}. We'll send a debit order mandate request to your bank next — confirm it there, and your funds are released once that's confirmed. You can cancel at no cost until ${result.reconsiderationDeadline.toLocaleDateString('en-ZA')}.`;
      }
      return "Please type your full name exactly as it appears on your application — that's your signature.";
    }
  }
}

async function checkExistingOrOfferFresh(session) {
  const existing = await db.find('applications', (a) => a.phoneNumber?.replace(/\D/g, '').endsWith(session.phone.replace(/\D/g, '').slice(-9)));
  if (existing && existing.status === 'awaiting_signature') {
    session.step = 'awaiting_sign_name';
    session.data.signingReference = existing.reference;
    await saveSession(session);
    return statusMessageFor(existing);
  }
  if (existing) {
    session.step = 'welcome';
    session.data = {};
    await saveSession(session);
    return statusMessageFor(existing);
  }

  session.step = 'welcome';
  session.data = {};
  await saveSession(session);
  return "Let's start a new application. What's your full name?";
}

// Builds a plain-language status update for an existing application —
// used both here and could be reused anywhere else a "what's going on
// with my loan" check happens.
function statusMessageFor(app) {
  const firstName = app.fullName.split(' ')[0];
  switch (app.status) {
    case 'pending_kyc': {
      const uploaded = (app.kyc?.documents || []).map((d) => d.type);
      const required = ['id_document', 'proof_of_address', 'proof_of_income', 'proof_of_bank_account'];
      const missing = required.filter((t) => !uploaded.includes(t));
      const base = getPublicAppUrl();
      if (missing.length > 0) {
        return `Hi ${firstName}, your application ${app.reference} is still waiting on documents: ${missing.join(', ').replace(/_/g, ' ')}. Upload here: ${base}/upload.html?ref=${app.reference}`;
      }
      return `Hi ${firstName}, all your documents are in for ${app.reference} — our team is reviewing them, usually within 1 business day.`;
    }
    case 'awaiting_signature':
      return `Hi ${firstName}, you're cleared to sign! Reference ${app.reference}. Reply SIGN to complete it, or use the link we sent you earlier.`;
    case 'active':
      return `Hi ${firstName}, your loan (${app.reference}) is active. Message us here anytime if you have questions about your repayments.`;
    case 'completed':
      return `Hi ${firstName}, your loan (${app.reference}) is fully paid off. 🎉 Let us know if you'd like to apply again.`;
    case 'declined':
      return `Hi ${firstName}, your application (${app.reference}) didn't move forward. Reply START if you'd like to try again with different details.`;
    case 'manual_review':
      return `Hi ${firstName}, your application (${app.reference}) is still with our team for review — we'll be in touch within 1 business day.`;
    default:
      return `Hi ${firstName}, your application (${app.reference}) status is: ${app.status.replace(/_/g, ' ')}.`;
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
    { channel: 'whatsapp', baseUrl: getPublicAppUrl() }
  );

  if (!result.ok) {
    return `Sorry, ${result.error} Message START to try again.`;
  }

  return result.response.message + '\n\nMessage us here anytime to check your status.';
}

module.exports = router;
