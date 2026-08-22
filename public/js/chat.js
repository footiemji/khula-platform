(() => {
  const chatBody = document.getElementById('chatBody');
  const input = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const quickReplies = document.getElementById('quickReplies');

  const state = { step: 'welcome', data: {} };
  let cachedConfig = null;
  let cachedBanks = null;

  async function getConfig() {
    if (cachedConfig) return cachedConfig;
    try {
      const res = await fetch('/api/config');
      cachedConfig = await res.json();
    } catch {
      cachedConfig = { whatsappBusinessNumber: null };
    }
    return cachedConfig;
  }

  async function getBanks() {
    if (cachedBanks) return cachedBanks;
    try {
      const res = await fetch('/api/banks');
      cachedBanks = await res.json();
    } catch {
      cachedBanks = [];
    }
    return cachedBanks;
  }

  async function botSayBankDropdown() {
    const banks = await getBanks();
    if (!banks.length) {
      await botSay('Which bank?');
      return;
    }
    await botSay('Which bank?', banks.map((b) => ({ label: b.name, value: b.name })));
  }

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

  const STORAGE_KEY = 'khula_in_progress_application';

  function saveProgress() {
    if (!state.reference) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ reference: state.reference, savedAt: Date.now() }));
    } catch {
      // localStorage can throw in private browsing on some browsers — not
      // fatal, it just means this session won't be resumable later.
    }
  }

  function clearProgress() {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  }

  function loadSavedReference() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      // Don't resume something abandoned weeks ago — a stale saved
      // reference pointing at a long-dead application isn't useful, and
      // silently reappearing is more confusing than just starting fresh.
      const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
      if (Date.now() - (parsed.savedAt || 0) > THIRTY_DAYS_MS) return null;
      return parsed.reference || null;
    } catch {
      return null;
    }
  }

  async function start() {
    const savedReference = loadSavedReference();
    if (savedReference) {
      const resumed = await tryResume(savedReference);
      if (resumed) return;
    }
    await botSay(
      "Welcome to Khula Financial Services 🌱 Grow. Thrive. Rise.\n\nI can get you a loan decision in under 2 minutes — the same way this would work on WhatsApp. What's your full name?"
    );
    state.step = 'ask_name';
  }

  // Fetches the REAL current status from the server rather than trusting
  // anything cached locally — the application may well have moved on since
  // this browser last saw it (KYC reviewed, or even signed via WhatsApp,
  // as a customer can freely switch channels). Returns true if it
  // successfully resumed into a live conversation state, false if it
  // should fall through to starting a fresh application instead.
  async function tryResume(reference) {
    try {
      const res = await fetch(`/api/applications/${reference}`);
      if (!res.ok) { clearProgress(); return false; }
      const app = await res.json();

      state.reference = reference;
      state.data.fullName = app.fullName;

      await botSay(`Welcome back! Picking up your application ${reference}…`);

      switch (app.status) {
        case 'pending_kyc': {
          const missing = app.kyc?.missingDocuments || [];
          state.step = 'pending_kyc';
          if (missing.length > 0) {
            addLinkButton(`/upload.html?ref=${reference}`, '📄 Upload your documents');
            await botSay(`Still needed: ${missing.join(', ').replace(/_/g, ' ')}.`, [{ label: 'Check status', value: 'status' }]);
          } else {
            await botSay("All your documents are in — our team is reviewing them, usually within 1 business day.", [{ label: 'Check status', value: 'status' }]);
          }
          return true;
        }
        case 'awaiting_signature':
          state.step = 'awaiting_signature';
          await botSay("You're cleared to sign! Reply 'sign' whenever you're ready.", [{ label: 'Sign now', value: 'sign' }]);
          return true;
        case 'active':
          state.step = 'done';
          await botSay("This loan is already signed and active. Nothing more to do here!");
          return true;
        case 'completed':
          state.step = 'done';
          await botSay("This loan is fully paid off. 🎉 Thanks for being a Khula customer.");
          return true;
        case 'declined':
          clearProgress();
          state.step = 'done';
          await botSay("This application didn't move forward. If you'd like to try again, click \"Start over\" above.");
          return true;
        case 'manual_review':
          state.step = 'done';
          await botSay("Your application is still with our team for review — we'll be in touch within 1 business day.");
          return true;
        default:
          clearProgress();
          return false;
      }
    } catch {
      clearProgress();
      return false;
    }
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
        state.step = 'whatsapp_first';
        await promptWhatsAppFirst();
        break;

      case 'whatsapp_first':
        // This is a recommendation, not a hard gate — any reply continues.
        // Forcing it would block anyone testing, or anyone who already
        // knows the drill. The buttons exist so most people can just tap
        // instead of typing anything at all.
        state.step = 'requesting_otp';
        await requestOtp();
        break;

      case 'awaiting_otp': {
        if (/^resend$/i.test(text)) {
          state.otpResendCount = (state.otpResendCount || 0) + 1;
          state.step = 'requesting_otp';
          await requestOtp();
          break;
        }
        if (/^change ?number$/i.test(text)) {
          state.step = 'ask_phone';
          state.otpResendCount = 0;
          await botSay('No problem — what\'s the correct WhatsApp/cell number?');
          break;
        }
        addSystem('Checking code…');
        try {
          const res = await fetch('/api/otp/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phoneNumber: state.data.phoneNumber, code: text }),
          });
          const data = await res.json();
          if (!res.ok) {
            const options = [{ label: 'Resend code', value: 'resend' }, { label: 'Change number', value: 'change number' }];
            await botSay(`⚠️ ${data.error}`, options);
            return;
          }
          state.phoneVerificationToken = data.verificationToken;
          state.step = 'ask_consent';
          await botSay("Number verified ✓\n\nDo you consent to Khula processing your personal information under POPIA to assess this application?", [
            { label: 'Yes, I consent', value: 'yes' },
            { label: 'No', value: 'no' },
          ]);
        } catch {
          await botSay('⚠️ Could not reach the Khula server. Check your connection and try again — your progress is still here.', [{ label: 'Resend code', value: 'resend' }, { label: 'Change number', value: 'change number' }]);
        }
        break;
      }

      case 'ask_consent':
        if (!/^y(es)?$/i.test(text)) {
          await botSay("No problem — we need consent to proceed. Reply 'yes' whenever you're ready.", [{ label: 'Yes, I consent', value: 'yes' }]);
          return;
        }
        state.data.popiaConsent = true;
        state.step = 'ask_marital_status';
        await botSay('Marital status?', [
          { label: 'Single', value: 'single' },
          { label: 'Married in community of property', value: 'married_in_community' },
          { label: 'Married out of community of property', value: 'married_out_of_community' },
          { label: 'Divorced / widowed', value: 'divorced_widowed' },
        ]);
        break;

      case 'ask_marital_status':
        state.data.maritalStatus = text;
        state.step = 'ask_residential_status';
        await botSay('And your living situation?', [
          { label: 'Own home (bond)', value: 'own_bonded' },
          { label: 'Own home (paid off)', value: 'own_paid_off' },
          { label: 'Renting', value: 'renting' },
          { label: 'Living with family', value: 'living_with_family' },
        ]);
        break;

      case 'ask_residential_status':
        state.data.residentialStatus = text;
        state.step = 'ask_debt_review';
        await botSay('Are you currently under debt review?', [
          { label: 'No', value: 'no' },
          { label: 'Yes', value: 'yes' },
        ]);
        break;

      case 'ask_debt_review':
        state.data.underDebtReview = /^y(es)?$/i.test(text);
        if (state.data.underDebtReview) {
          await botSay("We're not able to proceed with an application while you're under debt review — this is a legal requirement, not a Khula policy choice. Once your debt review ends, we'd be glad to help.");
          state.step = 'done';
          return;
        }
        state.step = 'ask_declarations';
        await botSay(
          "A few more things to confirm before we continue — please review and accept all of these:\n\n" +
          "✓ I consent to a credit bureau check being run on my profile\n" +
          "✓ All information I provide is true, accurate, and complete\n" +
          "✓ I have not withheld anything that could affect this decision\n" +
          "✓ I authorise Khula to verify the information I provide\n" +
          "✓ I understand this does not guarantee approval",
          [{ label: 'I accept all of the above', value: 'accept' }]
        );
        break;

      case 'ask_declarations':
        if (!/^accept$/i.test(text) && !/^yes$/i.test(text)) {
          await botSay("We need your agreement to continue.", [{ label: 'I accept all of the above', value: 'accept' }]);
          return;
        }
        state.data.creditBureauConsent = true;
        state.data.declarationsAccepted = true;
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
        state.step = 'ask_employer_details';
        await botSay("Employer or business name, and their phone number? One message like: ABC Traders, 0115551234\n\n(Reply 'skip' if self-employed or informal with no fixed employer)");
        break;

      case 'ask_employer_details': {
        if (/^skip$/i.test(text.trim())) {
          state.data.employerName = null;
          state.data.employerPhone = null;
        } else {
          const parts = text.split(',').map((p) => p.trim());
          state.data.employerName = parts[0] || null;
          state.data.employerPhone = parts[1] || null;
        }
        state.step = 'ask_months';
        await botSay("How many months have you been in your current job or business, and what day of the month do you get paid? One message like: 18 months, 25th\n\n(If paid on the last working day, just say 'last')");
        break;
      }

      case 'ask_months': {
        const monthsMatch = text.match(/\d+/);
        if (!monthsMatch) { await botSay("Please include how many months, e.g. '18 months, 25th'"); return; }
        state.data.monthsEmployed = parseInt(monthsMatch[0], 10);
        state.data.salaryPaymentDate = (text.split(',')[1] || text).trim();
        state.step = 'ask_income';
        await botSay("What's your average NET monthly income (after tax), in Rand? e.g. 8500");
        break;
      }

      case 'ask_income': {
        const income = Number(text.replace(/[^\d.]/g, ''));
        if (!income) { await botSay('Please send just the number, e.g. 8500'); return; }
        state.data.netMonthlyIncome = income;
        state.step = 'ask_commission';
        await botSay("Any regular commission or overtime (average over the last 3 months)? Reply with the Rand amount, or '0' if none.");
        break;
      }

      case 'ask_commission': {
        const amount = Number(text.replace(/[^\d.]/g, ''));
        if (isNaN(amount)) { await botSay("Please reply with a number, or '0' if none."); return; }
        state.data.averageCommission3mo = amount;
        state.data.averageOvertime3mo = 0;
        state.step = 'ask_expenses';
        await botSay('And your average monthly living expenses (rent, food, transport — not including other debt)?');
        break;
      }

      case 'ask_expenses': {
        const expenses = Number(text.replace(/[^\d.]/g, ''));
        if (isNaN(expenses)) { await botSay('Please send just the number, e.g. 4200'); return; }
        state.data.monthlyExpenses = expenses;
        state.step = 'ask_debt';
        await botSay("Any other loans or accounts (store cards, other lenders)? List each on its own line like:\nCapfin, personal loan, 5000, 800\n\n(Provider, type, balance owed, monthly instalment)", [{ label: "I don't have any", value: 'none' }]);
        break;
      }

      case 'ask_debt': {
        if (/^none$/i.test(text.trim())) {
          state.data.existingDebts = [];
        } else {
          state.data.existingDebts = text.split('\n').map((line) => {
            const parts = line.split(',').map((p) => p.trim());
            return { provider: parts[0] || '', type: parts[1] || '', balance: Number(parts[2]) || 0, instalment: Number(parts[3]) || 0 };
          }).filter((d) => d.provider);
        }
        state.step = 'ask_amount';
        await botSay('How much would you like to borrow? (Between R500 and R50,000)');
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
        if (!term || term < 1 || term > 60) { await botSay('Please reply with a number of months between 1 and 60.'); return; }
        state.data.termMonths = term;
        state.step = 'ask_purpose';
        await botSay("What's the loan for? (e.g. emergency, school fees, medical, home repairs)");
        break;
      }

      case 'ask_purpose':
        state.data.loanPurpose = text;
        state.step = 'ask_bank_holder';
        await botSay("Almost done — I need your payout bank details. This account must be in your own name, so we can pay your loan directly to you.\n\nWhat's the account holder's full name?");
        break;

      case 'ask_bank_holder':
        state.data.bankAccountHolder = text;
        state.step = 'ask_bank_name';
        await botSayBankDropdown();
        break;

      case 'ask_bank_name': {
        const banks = await getBanks();
        const matched = banks.find((b) => b.name === text);
        state.data.bankName = matched ? matched.name : text;
        if (matched && matched.branchCode) {
          state.data.branchCode = matched.branchCode;
          state.step = 'ask_account_number';
          await botSay(`${matched.name} — branch code ${matched.branchCode} filled in automatically. Account number?`);
        } else {
          state.step = 'ask_account_number';
          await botSay('Account number?');
        }
        break;
      }

      case 'ask_account_number': {
        const acc = text.replace(/\s/g, '');
        if (!/^\d{6,17}$/.test(acc)) { await botSay("That doesn't look like a valid account number. Please try again."); return; }
        state.data.accountNumber = acc;
        if (state.data.branchCode) {
          // Already auto-filled — skip straight to submitting.
          state.step = 'submitting';
          await submitApplication();
        } else {
          state.step = 'ask_branch_code';
          await botSay('Branch code? (or reply "skip" if you don\'t have it handy)');
        }
        break;
      }

      case 'ask_branch_code':
        state.data.branchCode = /^skip$/i.test(text.trim()) ? null : text.replace(/\s/g, '');
        state.step = 'submitting';
        await submitApplication();
        break;

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
        await botSay("This application has been completed. Refresh this page to start a new one.");
    }
  }

  async function promptWhatsAppFirst() {
    const config = await getConfig();
    const number = config.whatsappBusinessNumber;

    if (!number) {
      // Not configured yet — skip straight through rather than showing a
      // broken/dead-end step.
      state.step = 'requesting_otp';
      await requestOtp();
      return;
    }

    const waLink = `https://wa.me/${number}?text=${encodeURIComponent('Hi')}`;
    await botSay(
      "One quick thing before your code — WhatsApp needs you to message us first so we're allowed to send anything to your number. Takes 5 seconds:"
    );
    addWhatsAppButton(waLink, '💬 Open WhatsApp & say Hi');
    await botSay("Once you've sent it, tap below.", [
      { label: "I've sent it — continue", value: 'continue' },
      { label: 'Skip — I\'ve messaged Khula before', value: 'skip' },
    ]);
  }

  function addWhatsAppButton(href, label) {
    const wrap = document.createElement('div');
    wrap.className = 'bubble system';
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = label;
    a.style.display = 'inline-block';
    a.style.background = 'var(--forest)';
    a.style.color = 'var(--white)';
    a.style.padding = '9px 16px';
    a.style.borderRadius = '999px';
    a.style.fontWeight = '600';
    a.style.fontSize = '13px';
    a.style.textDecoration = 'none';
    wrap.appendChild(a);
    chatBody.appendChild(wrap);
    chatBody.scrollTop = chatBody.scrollHeight;
  }

  async function requestOtp() {
    addSystem('Sending a verification code to your WhatsApp…');
    try {
      const res = await fetch('/api/otp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: state.data.phoneNumber }),
      });
      const data = await res.json();
      if (!res.ok) {
        await botSay(`⚠️ ${data.error}`);
        state.step = 'ask_phone';
        return;
      }
      state.step = 'awaiting_otp';
      const resendCount = state.otpResendCount || 0;
      const hint = resendCount >= 2
        ? `Still not arrived at ${state.data.phoneNumber}? Double-check that's exactly right — a lot of stuck codes come down to one wrong digit.`
        : `We've sent a 6-digit code to ${state.data.phoneNumber} on WhatsApp. What is it?`;
      await botSay(hint, [{ label: 'Resend code', value: 'resend' }, { label: 'Change number', value: 'change number' }]);
    } catch {
      await botSay('⚠️ Could not reach the Khula server.');
    }
  }

  async function submitApplication() {
    addSystem('Checking affordability…');
    try {
      const res = await fetch('/api/applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...state.data, channel: 'web', phoneVerificationToken: state.phoneVerificationToken }),
      });
      const data = await res.json();
      if (!res.ok) {
        await botSay(`⚠️ ${data.error || 'Something went wrong.'}`);
        state.step = 'done';
        return;
      }
      state.reference = data.reference;
      saveProgress();
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

  document.getElementById('checkStatusHeaderBtn').addEventListener('click', async () => {
    const ref = prompt('Enter your application reference (e.g. KHULA-ABC123XYZ):');
    if (!ref) return;
    const trimmed = ref.trim().toUpperCase();
    addSystem(`Looking up ${trimmed}…`);
    try {
      const res = await fetch(`/api/applications/${trimmed}`);
      const app = await res.json();
      if (!res.ok) { await botSay(`⚠️ ${app.error || 'Could not find that application.'}`); return; }
      state.reference = app.reference;
      state.data.fullName = app.fullName;
      saveProgress();
      const resumed = await tryResume(app.reference);
      if (!resumed) await botSay(`Current status: ${app.status.replace(/_/g, ' ')}.`);
    } catch {
      await botSay('⚠️ Could not reach the Khula server.');
    }
  });

  document.getElementById('restartBtn').addEventListener('click', () => {
    if (state.step !== 'welcome' && state.step !== 'ask_name' && !confirm('Start a new application? This clears everything you\'ve entered so far.')) {
      return;
    }
    clearProgress();
    location.reload();
  });

  start();
})();
