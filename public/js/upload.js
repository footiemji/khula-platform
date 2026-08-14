(() => {
  const params = new URLSearchParams(window.location.search);
  const reference = params.get('ref');

  const states = {
    loading: document.getElementById('loadingState'),
    notFound: document.getElementById('notFoundState'),
    wrongStatus: document.getElementById('wrongStatusState'),
    upload: document.getElementById('uploadState'),
    success: document.getElementById('successState'),
  };

  function showState(name) {
    Object.values(states).forEach((el) => (el.style.display = 'none'));
    states[name].style.display = 'block';
  }

  function markUploaded(type) {
    const slot = document.querySelector(`.doc-slot[data-type="${type}"]`);
    if (!slot) return;
    slot.querySelector('[data-status]').textContent = '✓ Received';
    slot.classList.add('doc-slot-done');
  }

  async function loadApplication() {
    if (!reference) return showState('notFound');
    try {
      const res = await fetch(`/api/applications/${encodeURIComponent(reference)}`);
      if (!res.ok) return showState('notFound');
      const app = await res.json();

      if (app.status !== 'pending_kyc') {
        document.getElementById('wrongStatusMessage').textContent =
          app.status === 'awaiting_signature' || app.status === 'active'
            ? "Your documents are already in and you're cleared — head back to your chat to sign."
            : `This application's current status is "${app.status.replace(/_/g, ' ')}", so document upload isn't available right now.`;
        return showState('wrongStatus');
      }

      document.getElementById('refLabel').textContent = app.reference;
      (app.kyc?.documentsUploaded || []).forEach(markUploaded);
      showState('upload');
    } catch {
      showState('notFound');
    }
  }

  async function submitDocuments() {
    const errorEl = document.getElementById('uploadError');
    errorEl.textContent = '';
    const submitBtn = document.getElementById('submitBtn');

    const formData = new FormData();
    let anyFile = false;
    document.querySelectorAll('.doc-slot').forEach((slot) => {
      const type = slot.dataset.type;
      const input = slot.querySelector('[data-input]');
      if (input.files && input.files[0]) {
        formData.append(type, input.files[0]);
        anyFile = true;
      }
    });

    if (!anyFile) {
      errorEl.textContent = 'Choose at least one file to upload.';
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Uploading…';

    try {
      const res = await fetch(`/api/applications/${encodeURIComponent(reference)}/documents`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        errorEl.textContent = data.error || 'Upload failed. Please try again.';
        if (data.rejected) {
          errorEl.textContent += ' ' + data.rejected.map((r) => `${r.type}: ${r.reason}`).join(' ');
        }
        submitBtn.disabled = false;
        submitBtn.textContent = 'Upload documents';
        return;
      }

      data.uploaded.forEach(markUploaded);

      if (data.missingDocuments && data.missingDocuments.length > 0) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Upload remaining documents';
        errorEl.style.color = 'var(--forest)';
        errorEl.textContent = `Got those — still need: ${data.missingDocuments.join(', ').replace(/_/g, ' ')}.`;
      } else {
        document.getElementById('successMessage').textContent = data.message;
        showState('success');
      }
    } catch {
      errorEl.textContent = 'Could not reach the Khula server. Please try again.';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Upload documents';
    }
  }

  document.getElementById('submitBtn').addEventListener('click', submitDocuments);
  loadApplication();
})();
