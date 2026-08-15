(() => {
  const loginView = document.getElementById('loginView');
  const agentShell = document.getElementById('agentShell');
  const idleState = document.getElementById('idleState');
  const formState = document.getElementById('formState');
  const resultState = document.getElementById('resultState');

  let token = sessionStorage.getItem('khula_agent_token') || null;
  let phoneVerificationToken = null;

  const FORM_FIELDS = [
    'f_fullName', 'f_idNumber', 'f_phoneNumber', 'f_employmentType', 'f_monthsEmployed',
    'f_netMonthlyIncome', 'f_monthlyExpenses', 'f_existingDebtInstalments', 'f_requestedAmount',
    'f_termMonths', 'f_bankAccountHolder', 'f_bankName', 'f_accountNumber', 'f_branchCode',
  ];

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
    document.getElementById('f_termMonths').value = '6';
    document.getElementById('f_existingDebtInstalments').value = '0';
    document.getElementById('f_employmentType').value = 'formal_permanent';
    document.getElementById('f_consent').checked = false;
    document.getElementById('f_customerPresent').checked = false;
    document.getElementById('f_otpCode').value = '';
    document.getElementById('otpVerifiedBadge').style.display = 'none';
    document.getElementById('otpRequestField').style.display = 'block';
    document.getElementById('otpVerifyField').style.display = 'none';
    document.getElementById('formError').textContent = '';
    document.getElementById('submitAppBtn').disabled = false;
    phoneVerificationToken = null;
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
    if (!document.getElementById('f_customerPresent').checked) {
      errorEl.textContent = 'Confirm the customer is physically present before submitting.';
      return;
    }

    const payload = {
      fullName: document.getElementById('f_fullName').value.trim(),
      idNumber: document.getElementById('f_idNumber').value.trim(),
      phoneNumber: document.getElementById('f_phoneNumber').value.trim(),
      phoneVerificationToken,
      popiaConsent: true,
      employmentType: document.getElementById('f_employmentType').value,
      monthsEmployed: Number(document.getElementById('f_monthsEmployed').value),
      netMonthlyIncome: Number(document.getElementById('f_netMonthlyIncome').value),
      monthlyExpenses: Number(document.getElementById('f_monthlyExpenses').value),
      existingDebtInstalments: Number(document.getElementById('f_existingDebtInstalments').value || 0),
      requestedAmount: Number(document.getElementById('f_requestedAmount').value),
      termMonths: Number(document.getElementById('f_termMonths').value),
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

  document.getElementById('agentLoginBtn').addEventListener('click', login);
  document.getElementById('startBtn').addEventListener('click', startNewApplication);
  document.getElementById('requestOtpBtn').addEventListener('click', requestOtp);
  document.getElementById('verifyOtpBtn').addEventListener('click', verifyOtp);
  document.getElementById('submitAppBtn').addEventListener('click', submitApplication);
  document.getElementById('cancelFormBtn').addEventListener('click', () => { resetForm(); showView(idleState); });
  document.getElementById('nextCustomerBtn').addEventListener('click', () => { resetForm(); showView(idleState); });

  if (token) showDashboard();
})();
