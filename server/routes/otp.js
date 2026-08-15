const express = require('express');
const { requestOtp, verifyOtp } = require('../lib/otp');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

// POST /api/otp/request { phoneNumber }
router.post('/request', asyncHandler(async (req, res) => {
  const { phoneNumber } = req.body || {};
  const result = await requestOtp(phoneNumber);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ message: 'A verification code has been sent to your WhatsApp.' });
}));

// POST /api/otp/verify { phoneNumber, code }
router.post('/verify', asyncHandler(async (req, res) => {
  const { phoneNumber, code } = req.body || {};
  const result = await verifyOtp(phoneNumber, code);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ verificationToken: result.verificationToken });
}));

module.exports = router;
