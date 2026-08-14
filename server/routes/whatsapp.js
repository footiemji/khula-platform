const express = require('express');
const db = require('../lib/db');
const { assessAffordability } = require('../lib/affordability');
const { scoreApplication, decide } = require('../lib/riskScore');

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
      session.step = 'done';
      await saveSession(session);
      return await finalizeApplication(session);
    }

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
  const affordability = assessAffordability({
    netMonthlyIncome: d.netMonthlyIncome,
    monthlyExpenses: d.monthlyExpenses,
    existingDebtInstalments: 0,
    requestedAmount: d.requestedAmount,
    termMonths: d.termMonths,
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
  });

  const outcome = decide({ affordability, risk });
  const reference = `KHULA-${Date.now().toString(36).toUpperCase()}`;

  await db.insert('applications', {
    id: reference,
    reference,
    createdAt: new Date().toISOString(),
    channel: 'whatsapp',
    status: outcome.decision === 'approved' ? 'awaiting_signature' : outcome.decision,
    decision: outcome.decision,
    fullName: d.fullName,
    idNumber: d.idNumber,
    phoneNumber: session.phone,
    employmentType: d.employmentType,
    netMonthlyIncome: d.netMonthlyIncome,
    monthlyExpenses: d.monthlyExpenses,
    existingDebtInstalments: 0,
    requestedAmount: d.requestedAmount,
    termMonths: d.termMonths,
    popiaConsent: true,
    popiaConsentAt: new Date().toISOString(),
    affordability,
    risk,
    signature: null,
    adminNotes: [],
  });

  if (outcome.decision === 'approved') {
    const base = process.env.PUBLIC_APP_URL || 'https://your-domain.example';
    return `You're pre-approved, ${d.fullName.split(' ')[0]}! 🎉\nR${d.requestedAmount} over ${d.termMonths} months, est. R${affordability.proposedInstalment}/month.\nReference: ${reference}\n\nRead your pre-agreement statement: ${base}/api/applications/${reference}/pre-agreement.pdf\nThen visit ${base}/sign/${reference} to review and sign.`;
  }
  if (outcome.decision === 'manual_review') {
    return `Thanks ${d.fullName.split(' ')[0]}. Reference ${reference} needs a quick human review — we'll message you here within 1 business day.`;
  }
  return affordability.suggestedAmount
    ? `R${d.requestedAmount} isn't affordable right now, but R${affordability.suggestedAmount} over ${d.termMonths} months looks manageable. Reply with that amount to re-apply, or START to begin again.`
    : `We can't offer a loan right now. Reference ${reference}. Message START to try again in future.`;
}

// ---------------------------------------------------------------------------
// Outbound message sender. TODO: replace the console.log stub with a real
// call to the WhatsApp Cloud API once you have credentials:
//
// POST https://graph.facebook.com/v20.0/{WHATSAPP_PHONE_NUMBER_ID}/messages
// Headers: Authorization: Bearer {WHATSAPP_ACCESS_TOKEN}
// Body: { messaging_product: 'whatsapp', to, type: 'text', text: { body } }
// ---------------------------------------------------------------------------
async function sendWhatsAppMessage(to, body) {
  if (process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) {
    const url = `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    try {
      await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
      });
    } catch (err) {
      console.error('Failed to send WhatsApp message:', err.message);
    }
  } else {
    console.log(`[WhatsApp OUT -> ${to}]:`, body);
  }
}

module.exports = router;
