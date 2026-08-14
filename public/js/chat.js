(() => {
  const chatBody = document.getElementById('chatBody');
  const input = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const quickReplies = document.getElementById('quickReplies');

  const state = { step: 'welcome', data: {} };

  function addBubble(text, who = 'bot') {
    const el = document.createElement('div');
    el.className = `bubble ${who}`;
    el.textContent = text;
    chatBody.appendChild(el);
    chatBody.scrollTop = chatBody.scrollHeight;
  }

  function addPdfLink(href, label) {
    const wrap = document.createElement('div');
    wrap.className = 'bubble system';
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = `📄 ${label}`;
    a.style.color = 'inherit';
    a.style.textDecoration = 'underline';
    wrap.appendChild(a);
    chatBody.appendChild(wrap);
    chatBody.scrollTop = chatBody.scrollHeight;
  }

  function addLinkButton(href, label) {
    const wrap = document.createElement('div');
    wrap.className = 'bubble system';
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = label;
    a.style.color = 'var(--forest)';
    a.style.fontWeight = '600';
    a.style.textDecoration = 'underline';
    wrap.appendChild(a);
    chatBody.appendChild(wrap);
    chatBody.scrollTop = chatBody.scrollHeight;
  }

  async function checkStatus() {
    addSystem('Checking your status…');
    try {
      const res = await fetch(`/api/applications/${state.reference}`);
      const app = await res.json();
      if (!res.ok) { await botSay(`⚠️ ${app.error || 'Could not find that application.'}`); return; }

      if (app.status === 'pending_kyc') {
        const missing = app.kyc?.missingDocuments || [];
        if (missing.length > 0) {
          await botSay(`Still waiting on: ${missing.join(', ').replace(/_/g, ' ')}.`, [{ label: 'Check status', value: 'status' }]);
        } else {
          await botSay("All your documents are in and our team is reviewing them — usually within 1 business day. Check back soon!", [{ label: 'Check status', value: 'status' }]);
        }
      } else if (app.status === 'awaiting_signature') {
        state.step = 'awaiting_signature';
        await botSay("You're cleared! Reply 'sign' whenever you're ready.", [{ label: 'Sign now', value: 'sign' }]);
      } else if (app.status === 'active') {
        await botSay("This loan is already signed and active. Nothing more to do here!");
        state.step = 'done';
      } else if (app.status === 'declined') {
        await botSay("This application didn't move forward. If you think that's a mistake, please reach out to Khula directly.");
        state.step = 'done';
      } else {
        await botSay(`Current status: ${app.status.replace(/_/g, ' ')}.`);
      }
    } catch {
      await botSay('⚠️ Could not reach the Khula server.');
    }
  }

  function addSystem(text) {
    const el = document.createElement('div');
    el.className = 'bubble system';
    el.textContent = text;
    chatBody.appendChild(el);
    chatBody.scrollTop = chatBody.scrollHeight;
  }

  function setQuickReplies(options) {
    quickReplies.innerHTML = '';
    options.forEach((opt) => {
      const btn = document.createElement('button');
      btn.className = 'quick-reply';
      btn.textContent = opt.label;
      btn.onclick = () => handleInput(opt.value);
      quickReplies.appendChild(btn);
    });
  }

  function clearQuickReplies() { quickReplies.innerHTML = ''; }

  async function botDelay(ms = 500) {
    return new Promise((res) => setTimeout(res, ms));
  }

  async function botSay(text, options) {
    await botDelay();
    addBubble(text, 'bot');
    if (options) setQuickReplies(options); else clearQuickReplies();
  }

  function firstName(full) { return (full || '').trim().split(' ')[0] || 'there'; }

  async function start() {
    await botSay(
      "Welcome to Khula Financial Services 🌱 Grow. Thrive. Rise.\n\nI can get you a loan decision in under 2 minutes — the same way this would work on WhatsApp. What's your full name?"
    );
    state.step = 'ask_name';
  }

  async function handleInput(raw) {
    const text = (raw ?? input.value).trim();
    if (!text) return;
    addBubble(text, 'user');
    input.value = '';
    clearQuickReplies();
    await advance(text);
  }

  async function advance(text) {
    switch (state.step) {
      case 'ask_name':
        state.data.fullName = text;
        state.step = 'ask_id';
        await botSay(`Thanks ${firstName(text)}. What's your 13-digit South African ID number? This stays private and is only used to verify your identity.`);
        break;

      case 'ask_id':
        if (!/^\d{13}$/.test(text.replace(/\s/g, ''))) {
          await botSay("That doesn't look like a valid 13-digit ID number. Please try again.");
          return;
        }
        state.data.idNumber = text.replace(/\s/g, '');
        state.step = 'ask_phone';
        await botSay('And your WhatsApp/cell number, so we can send your decision and agreement?');
        break;

      case 'ask_phone':
        state.data.phoneNumber = text;
        state.step = 'ask_consent';
        await botSay('Do you consent to Khula processing your personal information under POPIA to assess this application?', [
          { label: 'Yes, I consent', value: 'yes' },
          { label: 'No', value: 'no' },
        ]);
        break;

      case 'ask_consent':
        if (!/^y(es)?$/i.test(text)) {
          await botSay("No problem — we need consent to proceed. Reply 'yes' whenever you're ready.", [{ label: 'Yes, I consent', value: 'yes' }]);
          return;
        }
        state.data.popiaConsent = true;
        state.step = 'ask_employment';
        await botSay('What best describes your employment?', [
          { label: 'Permanent employee', value: 'formal_permanent' },
          { label: 'Contract employee', value: 'formal_contract' },
          { label: 'Self-employed', value: 'self_employed' },
          { label: 'Informal / piece work', value: 'informal' },
        ]);
        break;

      case 'ask_employment':
        state.data.employmentType = text;
        state.step = 'ask_months';
        await botSay('How many months have you been in your current job or business?');
        break;

      case 'ask_months': {
        const months = Number(text.replace(/[^\d.]/g, ''));
        if (!months && months !== 0) { await botSay('Please send just the number of months, e.g. 18'); return; }
        state.data.monthsEmployed = months;
        state.step = 'ask_income';
        await botSay("What's your average NET monthly income (after tax), in Rand? e.g. 8500");
        break;
      }

      case 'ask_income': {
        const income = Number(text.replace(/[^\d.]/g, ''));
        if (!income) { await botSay('Please send just the number, e.g. 8500'); return; }
        state.data.netMonthlyIncome = income;
        state.step = 'ask_expenses';
        await botSay('And your average monthly expenses (rent, food, transport)?');
        break;
      }

      case 'ask_expenses': {
        const expenses = Number(text.replace(/[^\d.]/g, ''));
        if (isNaN(expenses)) { await botSay('Please send just the number, e.g. 4200'); return; }
        state.data.monthlyExpenses = expenses;
        state.step = 'ask_debt';
        await botSay('Do you currently pay any other loan or credit instalments each month? If yes, how much in total? Reply 0 if none.');
        break;
      }

      case 'ask_debt': {
        const debt = Number(text.replace(/[^\d.]/g, ''));
        if (isNaN(debt)) { await botSay('Please send just the number, e.g. 0 or 850'); return; }
        state.data.existingDebtInstalments = debt;
        state.step = 'ask_amount';
        await botSay('How much would you like to borrow? (Between R500 and R15,000)');
        break;
      }

      case 'ask_amount': {
        const amount = Number(text.replace(/[^\d.]/g, ''));
        if (!amount) { await botSay('Please send just the number, e.g. 3000'); return; }
        state.data.requestedAmount = amount;
        state.step = 'ask_term';
        await botSay('Over how many months would you like to repay?', [
          { label: '3 months', value: '3' },
          { label: '6 months', value: '6' },
          { label: '12 months', value: '12' },
        ]);
        break;
      }

      case 'ask_term': {
        const term = Number(text.replace(/[^\d.]/g, ''));
        if (!term || term < 1 || term > 36) { await botSay('Please reply with a number of months between 1 and 36.'); return; }
        state.data.termMonths = term;
        state.step = 'submitting';
        await submitApplication();
        break;
      }

      case 'awaiting_signature':
        if (/^sign$/i.test(text)) {
          await signApplication();
        } else {
          await botSay("Reply 'sign' to sign your agreement and get your funds moving.", [{ label: 'Sign now', value: 'sign' }]);
        }
        break;

      case 'pending_kyc':
        if (/^status$/i.test(text)) {
          await checkStatus();
        } else {
          await botSay("Upload your documents using the link above, then reply 'status' to check where things stand.", [{ label: 'Check status', value: 'status' }]);
        }
        break;

      default:
        await botSay("That's the end of this demo conversation. Refresh to start a new application.");
    }
  }

  async function submitApplication() {
    addSystem('Checking affordability…');
    try {
      const res = await fetch('/api/applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...state.data, channel: 'web' }),
      });
      const data = await res.json();
      if (!res.ok) {
        await botSay(`⚠️ ${data.error || 'Something went wrong.'}`);
        state.step = 'done';
        return;
      }
      state.reference = data.reference;
      await botSay(data.message);
      if (data.decision === 'approved') {
        state.step = 'pending_kyc';
        addPdfLink(`/api/applications/${data.reference}/pre-agreement.pdf`, 'View pre-agreement statement (PDF)');
        addLinkButton(`/upload.html?ref=${data.reference}`, '📄 Upload your documents');
        await botSay("Once you've uploaded your documents, our team reviews them (usually within 1 business day). Come back here and reply 'status' any time to check.", [{ label: 'Check status', value: 'status' }]);
      } else {
        state.step = 'done';
      }
    } catch (err) {
      await botSay('⚠️ Could not reach the Khula server. Please make sure the backend is running.');
      state.step = 'done';
    }
  }

  async function signApplication() {
    addSystem('Recording your signature…');
    try {
      const res = await fetch(`/api/applications/${state.reference}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ typedFullName: state.data.fullName }),
      });
      const data = await res.json();
      if (!res.ok) { await botSay(`⚠️ ${data.error}`); return; }
      await botSay(data.message);
      state.step = 'done';
    } catch {
      await botSay('⚠️ Could not reach the Khula server.');
    }
  }

  sendBtn.addEventListener('click', () => handleInput());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleInput(); });

  start();
})();
