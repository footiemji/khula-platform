const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../lib/db');
const { signToken, requireAgent } = require('../lib/auth');
const { createApplication } = require('../lib/applicationEngine');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

// POST /api/agent/login  { agentCode, pin }
router.post('/login', asyncHandler(async (req, res) => {
  const { agentCode, pin } = req.body || {};
  if (!agentCode || !pin) return res.status(400).json({ error: 'Agent code and PIN are required.' });

  const agent = await db.find('agents', (a) => a.agentCode === agentCode.toUpperCase().trim());
  if (!agent || !agent.active) {
    return res.status(401).json({ error: 'Invalid agent code or PIN.' });
  }
  const ok = await bcrypt.compare(String(pin), agent.pinHash);
  if (!ok) return res.status(401).json({ error: 'Invalid agent code or PIN.' });

  const token = signToken({ role: 'agent', agentId: agent.id, agentCode: agent.agentCode, agentName: agent.name, shopName: agent.shopName }, '12h');
  res.json({ token, agentName: agent.name, shopName: agent.shopName });
}));

// POST /api/agent/applications
// Same engine as the web widget (server/lib/applicationEngine.js), tagged
// with which agent and shop facilitated it. Phone OTP verification is still
// required — see the engine for why that matters even more here, not less.
router.post('/applications', requireAgent, asyncHandler(async (req, res) => {
  const { agentConfirmedCustomerPresent } = req.body || {};
  if (!agentConfirmedCustomerPresent) {
    return res.status(400).json({ error: 'The agent must confirm the customer is physically present and consents before submitting.' });
  }
  const result = await createApplication(req.body, {
    channel: 'agent_assisted',
    baseUrl: process.env.PUBLIC_APP_URL,
    agentContext: { agentId: req.agent.agentId, agentCode: req.agent.agentCode, agentName: req.agent.agentName, shopName: req.agent.shopName },
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.status(201).json(result.response);
}));

module.exports = router;
