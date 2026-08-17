(() => {
  const loginView = document.getElementById('loginView');
  const agentShell = document.getElementById('agentShell');
  const idleState = document.getElementById('idleState');
  const formState = document.getElementById('formState');
  const resultState = document.getElementById('resultState');

  let token = sessionStorage.getItem('khula_agent_token') || null;
  let phoneVerificationToken = null;
  let otpResendCount = 0;

  // Fetch once on load — used to build the "message us first" WhatsApp link.
  fetch('/api/config')
    .then((r) => r.json())
    .then((config) => {
      const link = document.getElementById('waFirstLink');
      if (config.whatsappBusinessNumber && link) {
        link.href = `https://wa.me/${config.whatsappBusinessNumber}?text=${encodeURIComponent('Hi')}`;
      } else if (link) {
        link.closest('#waFirstReminder').style.display = 'none'; // nothing to link to yet — hide rather than show a dead link
      }
    })
    .catch(() => {});

  // Populate the bank dropdown and wire up branch-code auto-fill.
  let banksList = [];
  fetch('/api/banks')
    .then((r) => r.json())
    .then((banks) => {
      banksList = banks;
      const select = document.getElementById('f_bankName');
      select.innerHTML = '<option value="">Select bank…</option>' + banks.map((b) => `<option value="${b.name}">${b.name}</option>`).join('');
      select.addEventListener('change', () => {
        const bank = banksList.find((b) => b.name === select.value);
        const branchInput = document.getElementById('f_branchCode');
        const autoLabel = document.getElementById('branchCodeAutoLabel');
        if (bank && bank.branchCode) {
          branchInput.value = bank.branchCode;
          branchInput.disabled = true;
          autoLabel.textContent = '(filled in automatically)';
        } else {
          branchInput.value = '';
          branchInput.disabled = false;
          autoLabel.textContent = bank ? '(please enter manually)' : '';
        }
      });
    })
    .catch(() => {
      document.getElementById('f_bankName').outerHTML = '<input id="f_bankName" type="text" placeholder="Bank name" />';
    });

  const FORM_FIELDS = [
    'f_fullName', 'f_idNumber', 'f_phoneNumber', 'f_employmentType', 'f_employerName', 'f_employerPhone',
    'f_monthsEmployed', 'f_salaryPaymentDate', 'f_netMonthlyIncome', 'f_averageCommission3mo', 'f_monthlyExpenses',
    'f_existingDebts', 'f_requestedAmount', 'f_termMonths', 'f_loanPurpose',
    'f_bankAccountHolder', 'f_bankName', 'f_accountNumber', 'f_branchCode',
  ];
  const CHECKBOX_FIELDS = ['f_consent', 'f_underDebtReview', 'f_creditBureauConsent', 'f_declarationsAccepted', 'f_customerPresent'];

  function showView(view) {
    [idleState, formState, resultState].forEach((el) => (el.style.display = 'none'));
    view.style.display = 'block';
  }

  async function agentFetch(url, opts = {}) {
    const res = await fetch(url, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (res.status === 401) {
      sessionStorage.removeItem('khula_agent_token');
      token = null;
      loginView.style.display = 'block';
      agentShell.style.display = 'none';
      throw new Error('Unauthorized');
    }
    return res;
  }

  async function login() {
    const errorEl = document.getElementById('agentLoginError');
    errorEl.textContent = '';
    const agentCode = document.getElementById('agentCode').value.trim().toUpperCase();
    const pin = document.getElementById('agentPin').value;
    try {
      const res = await fetch('/api/agent/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentCode, pin }),
      });
      const data = await res.json();
      if (!res.ok) { errorEl.textContent = data.error || 'Login failed.'; return; }
      token = data.token;
      sessionStorage.setItem('khula_agent_token', token);
      sessionStorage.setItem('khula_agent_name', data.agentName);
      sessionStorage.setItem('khula_agent_shop', data.shopName);
      showDashboard();
    } catch {
      errorEl.textContent = 'Could not reach the server.';
    }
  }

  function showDashboard() {
    loginView.style.display = 'none';
    agentShell.style.display = 'block';
    document.getElementById('agentLabel').textContent = `${sessionStorage.getItem('khula_agent_name')} · ${sessionStorage.getItem('khula_agent_shop')}`;
    document.getElementById('agentNameLabel').textContent = sessionStorage.getItem('khula_agent_name');
    document.getElementById('shopNameLabel').textContent = sessionStorage.getItem('khula_agent_shop');
    showView(idleState);
  }

  // Resets every field and every piece of transient state. This is the
  // most important function on this page — a shared device at a spaza
  // shop must never carry one customer's data into the next customer's
  // session, even accidentally.
  function resetForm() {
    FORM_FIELDS.forEach((id) => { document.getElementById(id).value = ''; });
    CHECKBOX_FIELDS.forEach((id) => { document.getElementById(id).checked = false; });
    document.getElementById('f_termMonths').value = '6';
    document.getElementById('f_averageCommission3mo').value = '0';
    document.getElementById('f_employmentType').value = 'formal_permanent';
    document.getElementById('f_maritalStatus').value = 'single';
    document.getElementById('f_residentialStatus').value = 'renting';
    document.getElementById('f_otpCode').value = '';
    document.getElementById('f_phoneNumber').disabled = false;
    document.getElementById('f_branchCode').disabled = false;
    document.getElementById('branchCodeAutoLabel').textContent = '';
    document.getElementById('otpVerifiedBadge').style.display = 'none';
    document.getElementById('otpRequestField').style.display = 'block';
    document.getElementById('otpVerifyField').style.display = 'none';
    document.getElementById('formError').textContent = '';
    document.getElementById('formError').style.color = '';
    document.getElementById('submitAppBtn').disabled = false;
    phoneVerificationToken = null;
    otpResendCount = 0;
  }

  function startNewApplication() {
    resetForm();
    showView(formState);
  }

  async function requestOtp() {
    const phone = document.getElementById('f_phoneNumber').value.trim();
    const errorEl = document.getElementById('formError');
    errorEl.textContent = '';
    if (!phone) { errorEl.textContent = "Enter the customer's phone number first."; return; }
    try {
      const res = await fetch('/api/otp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: phone }),
      });
      const data = await res.json();
      if (!res.ok) { errorEl.textContent = data.error; return; }
      document.getElementById('otpRequestField').style.display = 'none';
      document.getElementById('otpVerifyField').style.display = 'block';
      document.getElementById('f_phoneNumber').disabled = true;
      otpResendCount += 1;
      if (otpResendCount >= 3) {
        errorEl.style.color = 'var(--gold)';
        errorEl.textContent = `Sent to ${phone} again. Still nothing after a few tries usually means the number's wrong, not a delivery problem — worth double-checking with the customer.`;
      }
    } catch {
      errorEl.textContent = 'Could not reach the server.';
    }
  }

  async function verifyOtp() {
    const phone = document.getElementById('f_phoneNumber').value.trim();
    const code = document.getElementById('f_otpCode').value.trim();
    const errorEl = document.getElementById('formError');
    errorEl.textContent = '';
    try {
      const res = await fetch('/api/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: phone, code }),
      });
      const data = await res.json();
      if (!res.ok) { errorEl.textContent = data.error; return; }
      phoneVerificationToken = data.verificationToken;
      document.getElementById('otpVerifiedBadge').style.display = 'inline';
    } catch {
      errorEl.textContent = 'Could not reach the server.';
    }
  }

  async function submitApplication() {
    const errorEl = document.getElementById('formError');
    errorEl.textContent = '';

    if (!phoneVerificationToken) {
      errorEl.textContent = "Verify the customer's phone number first.";
      return;
    }
    if (!document.getElementById('f_consent').checked) {
      errorEl.textContent = 'Customer must consent under POPIA to proceed.';
      return;
    }
    if (!document.getElementById('f_creditBureauConsent').checked) {
      errorEl.textContent = 'Customer must consent to a credit bureau check to proceed.';
      return;
    }
    if (!document.getElementById('f_declarationsAccepted').checked) {
      errorEl.textContent = 'Customer must accept the applicant declarations to proceed.';
      return;
    }
    if (!document.getElementById('f_customerPresent').checked) {
      errorEl.textContent = 'Confirm the customer is physically present before submitting.';
      return;
    }

    const debtsText = document.getElementById('f_existingDebts').value.trim();
    const existingDebts = debtsText
      ? debtsText.split('\n').map((line) => {
          const parts = line.split(',').map((p) => p.trim());
          return { provider: parts[0] || '', type: parts[1] || '', balance: Number(parts[2]) || 0, instalment: Number(parts[3]) || 0 };
        }).filter((d) => d.provider)
      : [];

    const payload = {
      fullName: document.getElementById('f_fullName').value.trim(),
      idNumber: document.getElementById('f_idNumber').value.trim(),
      phoneNumber: document.getElementById('f_phoneNumber').value.trim(),
      phoneVerificationToken,
      popiaConsent: true,
      creditBureauConsent: true,
      declarationsAccepted: true,
      maritalStatus: document.getElementById('f_maritalStatus').value,
      residentialStatus: document.getElementById('f_residentialStatus').value,
      underDebtReview: document.getElementById('f_underDebtReview').checked,
      employmentType: document.getElementById('f_employmentType').value,
      employerName: document.getElementById('f_employerName').value.trim() || null,
      employerPhone: document.getElementById('f_employerPhone').value.trim() || null,
      monthsEmployed: Number(document.getElementById('f_monthsEmployed').value),
      salaryPaymentDate: document.getElementById('f_salaryPaymentDate').value.trim() || null,
      netMonthlyIncome: Number(document.getElementById('f_netMonthlyIncome').value),
      averageCommission3mo: Number(document.getElementById('f_averageCommission3mo').value || 0),
      averageOvertime3mo: 0,
      monthlyExpenses: Number(document.getElementById('f_monthlyExpenses').value),
      existingDebts,
      requestedAmount: Number(document.getElementById('f_requestedAmount').value),
      termMonths: Number(document.getElementById('f_termMonths').value),
      loanPurpose: document.getElementById('f_loanPurpose').value.trim() || null,
      bankAccountHolder: document.getElementById('f_bankAccountHolder').value.trim(),
      bankName: document.getElementById('f_bankName').value.trim(),
      accountNumber: document.getElementById('f_accountNumber').value.trim(),
      branchCode: document.getElementById('f_branchCode').value.trim() || null,
      agentConfirmedCustomerPresent: true,
    };

    const submitBtn = document.getElementById('submitAppBtn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';

    try {
      const res = await agentFetch('/api/agent/applications', { method: 'POST', body: JSON.stringify(payload) });
      const data = await res.json();
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit application';
      if (!res.ok) { errorEl.textContent = data.error; return; }
      showResult(data);
    } catch {
      errorEl.textContent = 'Could not reach the server.';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit application';
    }
  }

  function showResult(data) {
    const titleEl = document.getElementById('resultTitle');
    const messageEl = document.getElementById('resultMessage');
    const uploadPrompt = document.getElementById('uploadPrompt');
    const uploadLink = document.getElementById('uploadLink');

    titleEl.textContent = data.decision === 'approved' ? 'Pre-approved! 🎉' : data.decision === 'manual_review' ? 'Needs human review' : 'Not approved right now';
    messageEl.textContent = data.message;

    if (data.decision === 'approved') {
      uploadPrompt.style.display = 'block';
      uploadLink.href = `/upload.html?ref=${data.reference}`;
    } else {
      uploadPrompt.style.display = 'none';
    }
    showView(resultState);
  }

  function fixWrongNumber() {
    document.getElementById('otpVerifyField').style.display = 'none';
    document.getElementById('otpRequestField').style.display = 'block';
    document.getElementById('f_phoneNumber').disabled = false;
    document.getElementById('f_otpCode').value = '';
    document.getElementById('otpVerifiedBadge').style.display = 'none';
    document.getElementById('formError').textContent = '';
    document.getElementById('formError').style.color = '';
    phoneVerificationToken = null;
    otpResendCount = 0;
    document.getElementById('f_phoneNumber').focus();
  }

  document.getElementById('agentLoginBtn').addEventListener('click', login);
  document.getElementById('startBtn').addEventListener('click', startNewApplication);
  document.getElementById('requestOtpBtn').addEventListener('click', requestOtp);
  document.getElementById('resendOtpBtn').addEventListener('click', requestOtp);
  document.getElementById('wrongNumberBtn').addEventListener('click', fixWrongNumber);
  document.getElementById('verifyOtpBtn').addEventListener('click', verifyOtp);
  document.getElementById('submitAppBtn').addEventListener('click', submitApplication);
  document.getElementById('cancelFormBtn').addEventListener('click', () => { resetForm(); showView(idleState); });
  document.getElementById('nextCustomerBtn').addEventListener('click', () => { resetForm(); showView(idleState); });

  if (token) showDashboard();
})();
