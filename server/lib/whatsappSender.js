// Shared WhatsApp Cloud API sender. Used by the conversation engine
// (server/routes/whatsapp.js) and OTP delivery (server/lib/otp.js) — one
// place that knows how to actually send a WhatsApp message, so both stay
// consistent and both fall back the same way when real credentials aren't
// configured yet.

async function callGraphAPI(payload) {
  const url = `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
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
    console.error(`[WhatsApp SEND FAILED -> ${payload.to}] HTTP ${res.status}: ${errorDetail}${errorCode ? ` (code ${errorCode})` : ''}`);
    return { ok: false };
  }

  console.log(`[WhatsApp OUT -> ${payload.to}] sent successfully, message id: ${data?.messages?.[0]?.id || 'unknown'}`);
  return { ok: true };
}

async function sendWhatsAppMessage(to, body) {
  if (process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) {
    try {
      const result = await callGraphAPI({ messaging_product: 'whatsapp', to, type: 'text', text: { body } });
      return result.ok;
    } catch (err) {
      console.error(`[WhatsApp SEND FAILED -> ${to}] Network/request error:`, err.message);
      return false;
    }
  } else {
    console.log(`[WhatsApp OUT -> ${to}] (dev mode, not actually sent):`, body);
    return true; // logged successfully in dev mode, even though nothing was actually sent
  }
}

// Sends a pre-approved WhatsApp template message — the only reliable way
// to message someone FIRST (an OTP, a payment reminder) outside the
// 24-hour window a customer's own message opens. Free-form text sent
// outside that window gets silently non-delivered even though Meta's API
// reports the send as successful — this is not a workaround, it's the
// actual supported mechanism for business-initiated messages. See
// docs/COMPLIANCE.md or README §4 for how to create and get one approved.
//
// `bodyParams` fills the template's {{1}}, {{2}}, etc. placeholders, in
// order — e.g. for an OTP template with body "Your code is {{1}}",
// pass ['482913'].
async function sendWhatsAppTemplate(to, templateName, languageCode, bodyParams = []) {
  if (!process.env.WHATSAPP_ACCESS_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
    console.log(`[WhatsApp TEMPLATE OUT -> ${to}] (dev mode, not actually sent): template=${templateName}, params=${JSON.stringify(bodyParams)}`);
    return true;
  }

  try {
    const result = await callGraphAPI({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components: bodyParams.length
          ? [{ type: 'body', parameters: bodyParams.map((p) => ({ type: 'text', text: String(p) })) }]
          : [],
      },
    });
    return result.ok;
  } catch (err) {
    console.error(`[WhatsApp TEMPLATE SEND FAILED -> ${to}] Network/request error:`, err.message);
    return false;
  }
}

// Sends a WhatsApp "list message" — a tappable native picker, up to 10
// options total. This is what replaces "reply with a number 1-4": the
// customer taps an option instead of typing a digit, which is both less
// error-prone and, per direct user feedback, considerably less confusing.
//
// `options` is an array of { id, title } — title must be 24 characters or
// fewer (a WhatsApp platform limit), so keep labels short. `id` is what
// comes back in the webhook reply and can be any string — using the
// actual semantic value (e.g. "single", "married_in_community") rather
// than a numeric index means the conversation handler doesn't need a
// separate lookup table to interpret the reply.
async function sendWhatsAppList(to, bodyText, buttonLabel, options) {
  if (!process.env.WHATSAPP_ACCESS_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
    console.log(`[WhatsApp LIST OUT -> ${to}] (dev mode, not actually sent): "${bodyText}" options=${JSON.stringify(options.map((o) => o.title))}`);
    return true;
  }

  try {
    const result = await callGraphAPI({
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText },
        action: {
          button: buttonLabel,
          sections: [{ title: 'Options', rows: options.map((o) => ({ id: o.id, title: o.title })) }],
        },
      },
    });
    return result.ok;
  } catch (err) {
    console.error(`[WhatsApp LIST SEND FAILED -> ${to}] Network/request error:`, err.message);
    return false;
  }
}

// Sends WhatsApp "reply buttons" — up to 3 tappable options shown directly
// under the message, no extra tap to open a list. Best for short, binary
// or ternary choices (yes/no, agree/decline). Button titles are limited
// to 20 characters by WhatsApp.
async function sendWhatsAppButtons(to, bodyText, options) {
  if (!process.env.WHATSAPP_ACCESS_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
    console.log(`[WhatsApp BUTTONS OUT -> ${to}] (dev mode, not actually sent): "${bodyText}" options=${JSON.stringify(options.map((o) => o.title))}`);
    return true;
  }

  try {
    const result = await callGraphAPI({
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: { buttons: options.map((o) => ({ type: 'reply', reply: { id: o.id, title: o.title } })) },
      },
    });
    return result.ok;
  } catch (err) {
    console.error(`[WhatsApp BUTTONS SEND FAILED -> ${to}] Network/request error:`, err.message);
    return false;
  }
}

module.exports = { sendWhatsAppMessage, sendWhatsAppTemplate, sendWhatsAppList, sendWhatsAppButtons };
