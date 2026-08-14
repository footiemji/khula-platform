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
        <td>${a.channel}</td>
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
          ${a.decision !== 'manual_review' && a.status !== 'pending_kyc' ? '—' : ''}
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

    document.querySelectorAll('.row-actions button.review-kyc').forEach((btn) => {
      btn.addEventListener('click', () => openKycModal(btn.dataset.ref));
    });
  }

  async function refresh() {
    await Promise.all([loadStats(), loadApplications()]);
  }

  // ---------------- KYC review modal ----------------
  const kycModal = document.getElementById('kycModal');
  const kycBody = document.getElementById('kycModalBody');

  const DOC_LABELS = { id_document: 'Copy of ID', proof_of_address: 'Proof of address', proof_of_income: 'Proof of income' };

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
    const docRows = ['id_document', 'proof_of_address', 'proof_of_income'].map((type) => {
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

    kycBody.innerHTML = `
      <h3 class="display" style="margin-top:0;">${app.fullName} · ${app.reference}</h3>
      <p style="color:var(--ink-soft);font-size:13px;">${app.phoneNumber} · R${app.requestedAmount} over ${app.termMonths} months</p>
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

    document.getElementById('verifyBtn').addEventListener('click', async () => {
      const checks = {
        identity: document.getElementById('checkIdentity').checked,
        address: document.getElementById('checkAddress').checked,
        employment: document.getElementById('checkEmployment').checked,
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
