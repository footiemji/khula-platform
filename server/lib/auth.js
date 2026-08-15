const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret';

function signToken(payload, expiresIn = '8h') {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token && verifyToken(token);
  if (!payload || payload.role !== 'admin') {
    return res.status(401).json({ error: 'Unauthorized. Log in at /api/admin/login.' });
  }
  req.admin = payload;
  next();
}

// Agent tokens expire after 12 hours — roughly a shift length. Short-lived
// on purpose: a shared spaza-shop device shouldn't stay authenticated as an
// agent indefinitely.
function requireAgent(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token && verifyToken(token);
  if (!payload || payload.role !== 'agent') {
    return res.status(401).json({ error: 'Unauthorized. Log in with your agent code and PIN.' });
  }
  req.agent = payload;
  next();
}

async function checkPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

module.exports = { signToken, verifyToken, requireAdmin, requireAgent, checkPassword };
