// Detects file type from the actual file bytes, not the client-supplied
// filename or Content-Type header — both of which are trivial to spoof.
// A borrower (or an attacker) could name a malicious file "id.pdf" and set
// the mimetype to application/pdf; this catches that by checking the file's
// real magic bytes before it's ever written to disk.
//
// PDF only, by policy — photos of documents are harder to review reliably
// (glare, cropping, blur) and easier to falsify convincingly than a real
// PDF export. If this needs to loosen back up later, re-add the JPEG/PNG
// magic-byte checks that used to be here.

function detectType(buffer) {
  if (!buffer || buffer.length < 4) return null;

  // %PDF
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return { mime: 'application/pdf', ext: 'pdf' };
  }
  return null;
}

const ALLOWED_MIME_TYPES = ['application/pdf'];

module.exports = { detectType, ALLOWED_MIME_TYPES };
