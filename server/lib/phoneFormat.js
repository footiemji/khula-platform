// Converts a South African phone number, typed in whatever format a person
// naturally uses, into the international digits-only format WhatsApp's
// Cloud API actually requires (e.g. "27821234567", no leading + or 0).
//
// This matters more than it might look: almost every South African types
// their own number in LOCAL format — "082 123 4567" or "0821234567" — not
// international format. Sending that local-format string straight to
// WhatsApp's API doesn't just fail to match Meta's allowed-test-recipient
// list; a leading-zero number isn't a valid WhatsApp recipient identifier
// at all, so this would break message delivery for the large majority of
// real users, not just an edge case.
//
// Used consistently everywhere a phone number is turned into a WhatsApp
// send target OR used as a lookup/matching key (OTP records, rate
// limiting) — using the same canonical format for both means "0821234567"
// and "+27 82 123 4567" are correctly treated as the same number.

function toWhatsAppFormat(phone) {
  let digits = String(phone || '').replace(/[^\d]/g, ''); // strips spaces, dashes, brackets, and any leading +

  if (digits.startsWith('0') && digits.length === 10) {
    // Local format: 0821234567 -> 27821234567
    digits = '27' + digits.slice(1);
  } else if (digits.length === 9 && !digits.startsWith('0')) {
    // Someone typed it without the leading 0: 821234567 -> 27821234567
    digits = '27' + digits;
  }
  // Already-international (27821234567, 11 digits) or anything else
  // (non-SA numbers, unusual input) passes through as-is — best effort
  // rather than silently mangling a format this function doesn't recognise.

  return digits;
}

module.exports = { toWhatsAppFormat };
