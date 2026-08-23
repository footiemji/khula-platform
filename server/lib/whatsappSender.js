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
//
// `copyCodeValue` is REQUIRED for Authentication templates built with a
// "Copy code" button (as opposed to zero-tap or one-tap autofill) — this
// is a real, easy-to-miss gotcha: the button needs the code sent again as
// its own separate component, distinct from the body text substitution.
// Omitting it produces Meta error 131008 "Required parameter is missing"
// even though the visible message text looks completely correct.
async function sendWhatsAppTemplate(to, templateName, languageCode, bodyParams = [], copyCodeValue = null) {
  if (!process.env.WHATSAPP_ACCESS_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
    console.log(`[WhatsApp TEMPLATE OUT -> ${to}] (dev mode, not actually sent): template=${templateName}, params=${JSON.stringify(bodyParams)}${copyCodeValue ? `, copyCode=${copyCodeValue}` : ''}`);
    return true;
  }

  const components = [];
  if (bodyParams.length) {
    components.push({ type: 'body', parameters: bodyParams.map((p) => ({ type: 'text', text: String(p) })) });
  }
  if (copyCodeValue) {
    // Authentication OTP "Copy code" buttons are, underneath, a URL button
    // whose target is a whatsapp.com deep link with the code embedded as a
    // dynamic parameter — NOT the "coupon_code" parameter type used by
    // Marketing-category coupon buttons, which look identical in the
    // WhatsApp Manager UI but are a completely different structure. Using
    // the coupon_code shape (a reasonable first guess, since it's what
    // most third-party docs show for "copy code" generically) is exactly
    // what produced Meta's generic "issue with the parameters" error —
    // this distinction isn't obvious from the UI at all.
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: String(copyCodeValue) }],
    });
  }

  try {
    const result = await callGraphAPI({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name: templateName, language: { code: languageCode }, components },
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

// Sends a WhatsApp "call-to-action URL" message — a real tappable button
// that opens a link, as opposed to a plain-text URL that WhatsApp may or
// may not auto-linkify depending on formatting and client version. This
// is the reliable fix for "the link isn't clickable": don't rely on text
// parsing at all, send an actual button. `bodyText` can hold the full
// message (e.g. the quotation breakdown) — the button sits below it as
// its own distinct tap target, up to 1024 characters in the body.
async function sendWhatsAppCtaUrl(to, bodyText, buttonText, url) {
  if (!process.env.WHATSAPP_ACCESS_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
    console.log(`[WhatsApp CTA-URL OUT -> ${to}] (dev mode, not actually sent): "${bodyText.slice(0, 60)}..." button="${buttonText}" url=${url}`);
    return true;
  }

  try {
    const result = await callGraphAPI({
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        body: { text: bodyText },
        action: { name: 'cta_url', parameters: { display_text: buttonText, url } },
      },
    });
    return result.ok;
  } catch (err) {
    console.error(`[WhatsApp CTA-URL SEND FAILED -> ${to}] Network/request error:`, err.message);
    return false;
  }
}

// Sends an actual document (PDF, etc.) via a public URL WhatsApp fetches
// directly — this is the standard, well-documented WhatsApp media message
// type (unlike the Authentication button structure, which had a genuine
// undocumented gotcha). The URL must be publicly reachable with no auth,
// since Meta's servers retrieve it themselves, not the recipient's phone.
async function sendWhatsAppDocument(to, documentUrl, filename, caption) {
  if (!process.env.WHATSAPP_ACCESS_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
    console.log(`[WhatsApp DOCUMENT OUT -> ${to}] (dev mode, not actually sent): ${filename} <- ${documentUrl}`);
    return true;
  }

  try {
    const result = await callGraphAPI({
      messaging_product: 'whatsapp',
      to,
      type: 'document',
      document: { link: documentUrl, filename, caption },
    });
    return result.ok;
  } catch (err) {
    console.error(`[WhatsApp DOCUMENT SEND FAILED -> ${to}] Network/request error:`, err.message);
    return false;
  }
}

module.exports = { sendWhatsAppMessage, sendWhatsAppTemplate, sendWhatsAppList, sendWhatsAppButtons, sendWhatsAppCtaUrl, sendWhatsAppDocument };
