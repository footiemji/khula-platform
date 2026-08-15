// Shared WhatsApp Cloud API sender. Used by the conversation engine
// (server/routes/whatsapp.js) and OTP delivery (server/lib/otp.js) — one
// place that knows how to actually send a WhatsApp message, so both stay
// consistent and both fall back the same way when real credentials aren't
// configured yet.

async function sendWhatsAppMessage(to, body) {
  if (process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) {
    const url = `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
      });

      // fetch() only rejects on network-level failures — it does NOT throw
      // on HTTP error responses like 401 (expired/invalid token) or 400
      // (invalid recipient, not in the test-number allow list, etc). Meta
      // returns those as normal 2xx-status-code responses with an error
      // body, so this has to be checked explicitly or failures vanish
      // silently — exactly the "nothing in the logs" symptom this fixes.
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        const errorDetail = data?.error?.message || JSON.stringify(data) || `HTTP ${res.status}`;
        const errorCode = data?.error?.code;
        console.error(`[WhatsApp SEND FAILED -> ${to}] HTTP ${res.status}: ${errorDetail}${errorCode ? ` (code ${errorCode})` : ''}`);
        return false;
      }

      console.log(`[WhatsApp OUT -> ${to}] sent successfully, message id: ${data?.messages?.[0]?.id || 'unknown'}`);
      return true;
    } catch (err) {
      console.error(`[WhatsApp SEND FAILED -> ${to}] Network/request error:`, err.message);
      return false;
    }
  } else {
    console.log(`[WhatsApp OUT -> ${to}] (dev mode, not actually sent):`, body);
    return true; // logged successfully in dev mode, even though nothing was actually sent
  }
}

module.exports = { sendWhatsAppMessage };
