// Shared WhatsApp Cloud API sender. Used by the conversation engine
// (server/routes/whatsapp.js) and OTP delivery (server/lib/otp.js) — one
// place that knows how to actually send a WhatsApp message, so both stay
// consistent and both fall back the same way when real credentials aren't
// configured yet.
//
// TODO once you have WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID: this
// already calls the real Graph API — nothing else to wire up. Until then,
// messages are logged to the console so you can test flows locally.

async function sendWhatsAppMessage(to, body) {
  if (process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) {
    const url = `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    try {
      await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
      });
      return true;
    } catch (err) {
      console.error('Failed to send WhatsApp message:', err.message);
      return false;
    }
  } else {
    console.log(`[WhatsApp OUT -> ${to}]:`, body);
    return true; // logged successfully in dev mode, even though nothing was actually sent
  }
}

module.exports = { sendWhatsAppMessage };
