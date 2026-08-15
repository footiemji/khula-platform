(() => {
  const loginView = document.getElementById('loginView');
  const dashboardView = document.getElementById('dashboardView');
  const loginBtn = document.getElementById('loginBtn');
  const loginError = document.getElementById('loginError');
  const statusFilter = document.getElementById('statusFilter');

  let token = sessionStorage.getItem('khula_admin_token') || null;

  async function login() {
    loginError.textContent = '';
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) { loginError.textContent = data.error || 'Login failed.'; return; }
      token = data.token;
      sessionStorage.setItem('khula_admin_token', token);
      document.getElementById('adminEmailLabel').textContent = email;
      showDashboard();
    } catch {
      loginError.textContent = 'Could not reach the server.';
    }
  }

  async function authedFetch(url, opts = {}) {
    const res = await fetch(url, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (res.status === 401) {
      sessionStorage.removeItem('khula_admin_token');
      token = null;
      loginView.style.display = 'block';
      dashboardView.style.display = 'none';
      throw new Error('Unauthorized');
    }
    return res;
  }

  function fmtCurrency(n) { return `R${Number(n || 0).toLocaleString('en-ZA')}`; }

  async function loadStats() {
    const res = await authedFetch('/api/admin/stats');
    const s = await res.json();
    const cards = [
      { label: 'Total applications', num: s.total },
      { label: 'Approved', num: s.approved },
      { label: 'Manual review', num: s.manualReview },
      { label: 'Active loans', num: s.active },
      { label: 'Disbursed (active)', num: fmtCurrency(s.totalDisbursed) },
    ];
    document.getElementById('statCards').innerHTML = cards
      .map((c) => `<div class="stat-card"><div class="num">${c.num}</div><div class="label">${c.label}</div></div>`)
      .join('');
  }

  async function loadApplications() {
    const status = statusFilter.value;
    const res = await authedFetch(`/api/admin/applications${status ? `?status=${encodeURIComponent(status)}` : ''}`);
    const apps = await res.json();
    const rows = apps.map((a) => `
      <tr>
        <td class="mono">${a.reference}</td>
        <td>${a.fullName}<br><span style="color:var(--ink-soft);font-size:11.5px;">${a.phoneNumber}</span></td>
        <td>${a.channel}${a.agent ? `<br><span style="font-size:10.5px;color:var(--ink-soft);">via ${a.agent.shopName}</span>` : ''}</td>
        <td>${fmtCurrency(a.requestedAmount)}</td>
        <td>${a.termMonths}mo</td>
        <td><span class="pill ${a.status}">${a.status.replace(/_/g, ' ')}</span>${a.reconsiderationDeadline ? `<br><span style="font-size:10.5px;color:var(--ink-soft);">cancel by ${new Date(a.reconsiderationDeadline).toLocaleDateString('en-ZA')}</span>` : ''}</td>
        <td>${a.risk ? `${a.risk.score} · ${a.risk.band.replace('_', ' ')}` : '—'}</td>
        <td class="row-actions">
          ${a.decision === 'manual_review' ? `
            <button class="approve" data-ref="${a.reference}" data-action="approved">Approve</button>
            <button class="decline" data-ref="${a.reference}" data-action="declined">Decline</button>
          ` : ''}
          ${a.status === 'pending_kyc' ? `<button class="review-kyc" data-ref="${a.reference}">Review KYC</button>` : ''}
          ${a.status === 'active' && a.collections?.debicheckStatus === 'not_started' ? `<button class="review-kyc" data-ref="${a.reference}" data-debicheck="1">Start DebiCheck</button>` : ''}
          ${a.status === 'active' && a.collections?.debicheckStatus && a.collections.debicheckStatus !== 'not_started' ? `<span style="font-size:11.5px;color:var(--ink-soft);">DebiCheck: ${a.collections.debicheckStatus.replace(/_/g, ' ')}</span>` : ''}
          ${['active', 'completed'].includes(a.status) && a.collections?.repaymentSchedule?.length ? `<button class="review-kyc" data-ref="${a.reference}" data-repayments="1">Repayments</button>` : ''}
          ${!['manual_review'].includes(a.decision) && a.status !== 'pending_kyc' && !(a.status === 'active') ? '—' : ''}
        </td>
      </tr>
    `).join('');
    document.getElementById('appRows').innerHTML = rows || '<tr><td colspan="8" style="text-align:center;color:var(--ink-soft);padding:24px;">No applications yet.</td></tr>';

    document.querySelectorAll('.row-actions button.approve, .row-actions button.decline').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await authedFetch(`/api/admin/applications/${btn.dataset.ref}/decision`, {
          method: 'POST',
          body: JSON.stringify({ decision: btn.dataset.action }),
        });
        await refresh();
      });
    });

    document.querySelectorAll('.row-actions button.review-kyc:not([data-debicheck])').forEach((btn) => {
      btn.addEventListener('click', () => openKycModal(btn.dataset.ref));
    });

    document.querySelectorAll('.row-actions button[data-debicheck]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Send a DebiCheck mandate request for this loan?')) return;
        const res = await authedFetch(`/api/admin/applications/${btn.dataset.ref}/debicheck`, { method: 'POST' });
        const data = await res.json();
        if (data.debicheckNote) alert(data.debicheckNote);
        await refresh();
      });
    });

    document.querySelectorAll('.row-actions button[data-repayments]').forEach((btn) => {
      btn.addEventListener('click', () => openRepaymentsModal(btn.dataset.ref));
    });
  }

  async function refresh() {
    await Promise.all([loadStats(), loadApplications()]);
  }

  // ---------------- Tabs ----------------
  const tabApplications = document.getElementById('tabApplications');
  const tabAgents = document.getElementById('tabAgents');
  const applicationsPanel = document.getElementById('applicationsPanel');
  const agentsPanel = document.getElementById('agentsPanel');

  tabApplications.addEventListener('click', () => {
    tabApplications.classList.add('active');
    tabAgents.classList.remove('active');
    applicationsPanel.style.display = 'block';
    agentsPanel.style.display = 'none';
  });
  tabAgents.addEventListener('click', () => {
    tabAgents.classList.add('active');
    tabApplications.classList.remove('active');
    agentsPanel.style.display = 'block';
    applicationsPanel.style.display = 'none';
    loadAgents();
  });

  // ---------------- Agent management ----------------
  document.getElementById('showAddAgentBtn').addEventListener('click', () => {
    const form = document.getElementById('addAgentForm');
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
  });

  document.getElementById('createAgentBtn').addEventListener('click', async () => {
    const errorEl = document.getElementById('agentFormError');
    errorEl.textContent = '';
    const body = {
      name: document.getElementById('newAgentName').value.trim(),
      shopName: document.getElementById('newAgentShop').value.trim(),
      location: document.getElementById('newAgentLocation').value.trim(),
      pin: document.getElementById('newAgentPin').value.trim(),
    };
    try {
      const res = await authedFetch('/api/admin/agents', { method: 'POST', body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) { errorEl.textContent = data.error; return; }
      alert(`Agent created — code ${data.agentCode}, PIN ${body.pin}. Write these down and give them to the agent; the PIN won't be shown again.`);
      document.getElementById('newAgentName').value = '';
      document.getElementById('newAgentShop').value = '';
      document.getElementById('newAgentLocation').value = '';
      document.getElementById('newAgentPin').value = '';
      document.getElementById('addAgentForm').style.display = 'none';
      loadAgents();
    } catch {
      errorEl.textContent = 'Could not reach the server.';
    }
  });

  async function loadAgents() {
    const res = await authedFetch('/api/admin/agents');
    const agents = await res.json();
    const rows = agents.map((a) => `
      <tr>
        <td class="mono">${a.agentCode}</td>
        <td>${a.name}</td>
        <td>${a.shopName}${a.location ? `<br><span style="font-size:11px;color:var(--ink-soft);">${a.location}</span>` : ''}</td>
        <td>${a.applicationsSubmitted}</td>
        <td>${a.loansActive}</td>
        <td><span class="pill ${a.active ? 'active' : 'inactive'}">${a.active ? 'active' : 'deactivated'}</span></td>
        <td>${a.active ? `<button class="decline deactivate-agent" data-id="${a.id}" style="border:1px solid var(--danger);color:var(--danger);background:var(--white);border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;">Deactivate</button>` : '—'}</td>
      </tr>
    `).join('');
    document.getElementById('agentRows').innerHTML = rows || '<tr><td colspan="7" style="text-align:center;color:var(--ink-soft);padding:24px;">No agents yet.</td></tr>';

    document.querySelectorAll('.deactivate-agent').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Deactivate this agent? They will no longer be able to log in.')) return;
        await authedFetch(`/api/admin/agents/${btn.dataset.id}/deactivate`, { method: 'POST' });
        loadAgents();
      });
    });
  }

  // ---------------- KYC review modal ----------------
  const kycModal = document.getElementById('kycModal');
  const kycBody = document.getElementById('kycModalBody');

  const DOC_LABELS = { id_document: 'Copy of ID', proof_of_address: 'Proof of address', proof_of_income: 'Proof of income', proof_of_bank_account: 'Proof of bank account' };

  async function openKycModal(reference) {
    kycBody.innerHTML = '<p>Loading…</p>';
    kycModal.style.display = 'flex';
    try {
      const res = await authedFetch(`/api/admin/applications?status=pending_kyc`);
      const apps = await res.json();
      const app = apps.find((a) => a.reference === reference);
      if (!app) { kycBody.innerHTML = '<p>Application not found or no longer pending KYC.</p>'; return; }
      renderKycModal(app);
    } catch {
      kycBody.innerHTML = '<p>Could not load application.</p>';
    }
  }

  function renderKycModal(app) {
    const docs = app.kyc?.documents || [];
    const docRows = ['id_document', 'proof_of_address', 'proof_of_income', 'proof_of_bank_account'].map((type) => {
      const doc = docs.find((d) => d.type === type);
      return `
        <div class="kyc-doc-row">
          <span>${DOC_LABELS[type]}</span>
          ${doc
            ? `<button class="view-doc" data-ref="${app.reference}" data-doc="${doc.id}">View</button>`
            : `<span style="color:var(--ink-soft);font-size:12.5px;">Not uploaded</span>`}
        </div>
      `;
    }).join('');

    const nameMatchBadge = app.payoutNameLooselyMatches === false
      ? `<span style="color:var(--danger);font-weight:600;">⚠ Payout name doesn't obviously match applicant name — check carefully</span>`
      : app.payoutNameLooselyMatches === true
        ? `<span style="color:var(--forest);">✓ Names appear to match</span>`
        : '';

    const q = app.affordability?.quotation;
    const quoteSummary = q ? `
      <div class="kyc-quote-box">
        <strong>Quote:</strong> ${(q.monthlyInterestRate * 100).toFixed(1)}%/mo interest · R${q.initiationFee.toFixed(2)} initiation ·
        R${q.monthlyServiceFee.toFixed(2)}/mo service · insurance from R${q.schedule[0].insurancePremium.toFixed(2)}/mo ·
        <strong>total repayable R${q.totalRepayable.toFixed(2)}</strong>
        ${q.aboveShortTermCreditCeiling ? `<br><span style="color:var(--danger);">⚠ Above R${q.shortTermCreditCeiling} — confirm fee/interest bracket with compliance</span>` : ''}
      </div>` : '';

    const bureau = app.underwriting || {};
    const bureauSection = bureau.bureauChecked ? `
      <div class="kyc-bureau-box">
        <strong>Bureau check recorded</strong> by ${bureau.bureauCheckedBy} on ${new Date(bureau.bureauCheckedAt).toLocaleString('en-ZA')}<br>
        Employment confirmed: ${bureau.employmentConfirmed ? 'Yes' : 'No'} · Credit record clean: ${bureau.creditRecordClean ? 'Yes' : 'No'} ·
        Judgments/defaults found: ${bureau.judgmentsOrDefaultsFound ? 'Yes ⚠' : 'No'}
        ${bureau.notes ? `<br>Notes: ${bureau.notes}` : ''}
      </div>
    ` : `
      <div class="kyc-bureau-box kyc-bureau-pending">
        <strong>No bureau/credit check recorded yet.</strong> This is required before KYC can be verified. Check the applicant manually (employment, credit record, judgments/defaults) and record the result:
        <div class="field" style="margin-top:8px;"><label><input type="checkbox" id="bureauEmployment" /> Employment confirmed</label></div>
        <div class="field"><label><input type="checkbox" id="bureauCreditClean" /> Credit record appears clean</label></div>
        <div class="field"><label><input type="checkbox" id="bureauJudgments" /> Judgments or defaults found</label></div>
        <div class="field"><label>Notes</label><textarea id="bureauNotes" rows="2"></textarea></div>
        <button class="btn-primary" id="recordBureauBtn" style="background:var(--forest); margin-top:6px;">Record bureau check</button>
      </div>
    `;

    kycBody.innerHTML = `
      <h3 class="display" style="margin-top:0;">${app.fullName} · ${app.reference}</h3>
      <p style="color:var(--ink-soft);font-size:13px;">${app.phoneNumber} · R${app.requestedAmount} over ${app.termMonths} months</p>
      ${quoteSummary}

      <div class="kyc-payout-box">
        <strong>Payout account:</strong> ${app.bankAccountHolder} · ${app.bankName} · ${app.accountNumberMasked || ''}<br>
        ${nameMatchBadge}
      </div>

      <div class="kyc-docs">${docRows}</div>

      <div class="field" style="margin-top:18px;">
        <label><input type="checkbox" id="checkIdentity" /> Identity confirmed against ID document</label>
      </div>
      <div class="field">
        <label><input type="checkbox" id="checkAddress" /> Address confirmed against proof of address</label>
      </div>
      <div class="field">
        <label><input type="checkbox" id="checkEmployment" /> Income/employment confirmed against proof of income</label>
      </div>
      <div class="field">
        <label><input type="checkbox" id="checkPayoutAccount" /> Payout account confirmed in borrower's name</label>
      </div>

      ${bureauSection}

      <div class="field" style="margin-top:12px;">
        <label>Note (optional)</label>
        <textarea id="kycNote" rows="2"></textarea>
      </div>

      <div style="display:flex; gap:10px; margin-top:10px;">
        <button class="btn-primary" id="verifyBtn" style="background:var(--forest);">Verify &amp; unlock signing</button>
        <button class="btn-primary" id="rejectBtn" style="background:var(--danger);">Reject</button>
        <button class="btn-primary" id="closeKycBtn" style="background:transparent;color:var(--ink);border:1px solid rgba(22,50,26,0.2);">Close</button>
      </div>
      <p class="error-msg" id="kycError"></p>
    `;

    kycBody.querySelectorAll('.view-doc').forEach((btn) => {
      btn.addEventListener('click', () => viewDocument(btn.dataset.ref, btn.dataset.doc));
    });

    document.getElementById('closeKycBtn').addEventListener('click', () => { kycModal.style.display = 'none'; });

    const recordBureauBtn = document.getElementById('recordBureauBtn');
    if (recordBureauBtn) {
      recordBureauBtn.addEventListener('click', async () => {
        const body = {
          employmentConfirmed: document.getElementById('bureauEmployment').checked,
          creditRecordClean: document.getElementById('bureauCreditClean').checked,
          judgmentsOrDefaultsFound: document.getElementById('bureauJudgments').checked,
          notes: document.getElementById('bureauNotes').value,
        };
        const res = await authedFetch(`/api/admin/applications/${app.reference}/underwriting`, { method: 'POST', body: JSON.stringify(body) });
        const updated = await res.json();
        if (res.ok) renderKycModal(updated);
      });
    }

    document.getElementById('verifyBtn').addEventListener('click', async () => {
      const checks = {
        identity: document.getElementById('checkIdentity').checked,
        address: document.getElementById('checkAddress').checked,
        employment: document.getElementById('checkEmployment').checked,
        payoutAccount: document.getElementById('checkPayoutAccount').checked,
      };
      const note = document.getElementById('kycNote').value;
      const errorEl = document.getElementById('kycError');
      try {
        const res = await authedFetch(`/api/admin/applications/${app.reference}/kyc-decision`, {
          method: 'POST',
          body: JSON.stringify({ decision: 'verify', checks, note }),
        });
        const data = await res.json();
        if (!res.ok) { errorEl.textContent = data.error; return; }
        kycModal.style.display = 'none';
        await refresh();
      } catch {
        errorEl.textContent = 'Could not reach the server.';
      }
    });

    document.getElementById('rejectBtn').addEventListener('click', async () => {
      const note = document.getElementById('kycNote').value;
      const res = await authedFetch(`/api/admin/applications/${app.reference}/kyc-decision`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'reject', note }),
      });
      if (res.ok) {
        kycModal.style.display = 'none';
        await refresh();
      }
    });
  }

  async function viewDocument(reference, docId) {
    try {
      const res = await authedFetch(`/api/admin/applications/${reference}/documents/${docId}`);
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    } catch {
      alert('Could not load document.');
    }
  }

  // ---------------- Repayments modal ----------------
  async function openRepaymentsModal(reference) {
    kycBody.innerHTML = '<p>Loading…</p>';
    kycModal.style.display = 'flex';
    try {
      const res = await authedFetch(`/api/admin/applications`);
      const apps = await res.json();
      const app = apps.find((a) => a.reference === reference);
      if (!app) { kycBody.innerHTML = '<p>Application not found.</p>'; return; }
      renderRepaymentsModal(app);
    } catch {
      kycBody.innerHTML = '<p>Could not load application.</p>';
    }
  }

  const STATUS_LABELS = { due: 'Due', reminder_sent: 'Reminder sent', overdue: 'Overdue', paid: 'Paid' };

  function renderRepaymentsModal(app) {
    const schedule = app.collections?.repaymentSchedule || [];
    const rows = schedule.map((i) => `
      <div class="kyc-doc-row">
        <span>Instalment ${i.installmentNumber} — R${i.amount.toFixed(2)} due ${new Date(i.dueDate).toLocaleDateString('en-ZA')}</span>
        <span style="display:flex; align-items:center; gap:8px;">
          <span class="pill ${i.status === 'paid' ? 'active' : i.status === 'overdue' ? 'declined' : 'pending_kyc'}">${STATUS_LABELS[i.status] || i.status}</span>
          ${i.status !== 'paid' ? `<button class="mark-paid" data-ref="${app.reference}" data-num="${i.installmentNumber}" style="border:1px solid var(--forest);color:var(--forest);background:var(--white);border-radius:8px;padding:4px 10px;font-size:11.5px;cursor:pointer;">Mark paid</button>` : ''}
        </span>
      </div>
    `).join('');

    kycBody.innerHTML = `
      <h3 class="display" style="margin-top:0;">${app.fullName} · ${app.reference}</h3>
      <p style="color:var(--ink-soft);font-size:13px;">Repayment schedule — ${schedule.filter(i=>i.status==='paid').length} of ${schedule.length} paid</p>
      <div class="kyc-docs">${rows}</div>
      <button class="btn-primary" id="closeRepaymentsBtn" style="background:transparent;color:var(--ink);border:1px solid rgba(22,50,26,0.2); margin-top:14px;">Close</button>
    `;

    document.getElementById('closeRepaymentsBtn').addEventListener('click', () => { kycModal.style.display = 'none'; });
    kycBody.querySelectorAll('.mark-paid').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Mark instalment ${btn.dataset.num} as paid? This sends a thank-you message to the customer.`)) return;
        const res = await authedFetch(`/api/admin/applications/${btn.dataset.ref}/repayments/${btn.dataset.num}/mark-paid`, { method: 'POST' });
        const updated = await res.json();
        if (res.ok) { renderRepaymentsModal(updated); await refresh(); }
      });
    });
  }

  function showDashboard() {
    loginView.style.display = 'none';
    dashboardView.style.display = 'block';
    refresh();
  }

  loginBtn.addEventListener('click', login);
  statusFilter.addEventListener('change', loadApplications);

  if (token) {
    document.getElementById('adminEmailLabel').textContent = 'Session restored';
    showDashboard();
  }
})();
