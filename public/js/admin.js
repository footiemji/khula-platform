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
          ` : '—'}
        </td>
      </tr>
    `).join('');
    document.getElementById('appRows').innerHTML = rows || '<tr><td colspan="8" style="text-align:center;color:var(--ink-soft);padding:24px;">No applications yet.</td></tr>';

    document.querySelectorAll('.row-actions button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await authedFetch(`/api/admin/applications/${btn.dataset.ref}/decision`, {
          method: 'POST',
          body: JSON.stringify({ decision: btn.dataset.action }),
        });
        await refresh();
      });
    });
  }

  async function refresh() {
    await Promise.all([loadStats(), loadApplications()]);
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
