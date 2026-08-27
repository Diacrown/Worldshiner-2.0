import { Router } from 'express';
import { requireAuth, requireHqOrAdmin } from '../middleware/auth.js';
import * as GmailService from '../services/gmail.service.js';
import { matchJobByText } from '../services/jobs.service.js';

export const gmailRouter = Router();

// GET /status is intentionally public-to-any-authenticated-user and never
// throws — the frontend needs this to render "not configured" gracefully.
gmailRouter.get('/status', requireAuth, async (req, res, next) => {
  try {
    res.json(await GmailService.getStatus(req.user.officeId));
  } catch (err) {
    next(err);
  }
});

gmailRouter.get('/connect', requireAuth, requireHqOrAdmin, async (req, res, next) => {
  try {
    res.json({ authUrl: GmailService.buildAuthUrl(req.user) });
  } catch (err) {
    next(err);
  }
});

// Hit directly by Google redirecting the browser — no Authorization header
// available, so this is deliberately NOT behind requireAuth. It verifies the
// signed `state` param instead (see gmail.service.js buildAuthUrl/verifyState).
gmailRouter.get('/callback', async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8080';
  try {
    const { code, state } = req.query;
    if (!code || !state) throw new Error('Missing code or state');
    const { sub, officeId } = GmailService.verifyState(state);
    const tokens = await GmailService.exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      throw new Error('Google did not return a refresh token — try disconnecting and reconnecting with consent prompted');
    }
    await GmailService.saveConnection(officeId, sub, { refreshToken: tokens.refresh_token, scope: tokens.scope });
    res.redirect(`${frontendUrl}?gmail=connected`);
  } catch (err) {
    res.redirect(`${frontendUrl}?gmail=error&message=${encodeURIComponent(err.message)}`);
  }
});

gmailRouter.get('/inquiries', requireAuth, requireHqOrAdmin, async (req, res, next) => {
  try {
    res.json(await GmailService.searchInquiries(req.user.officeId, req.query.q));
  } catch (err) {
    next(err);
  }
});

// Recent inbox messages, each with a best-guess job match (by PO number) so
// staff can either drop a reply straight into that job's chat, or — if
// nothing matched — use it to pre-fill a new job.
gmailRouter.get('/inbox', requireAuth, requireHqOrAdmin, async (req, res, next) => {
  try {
    const messages = await GmailService.listInboxCandidates(req.user.officeId);
    const withMatches = await Promise.all(messages.map(async (m) => ({
      ...m,
      matchedJob: await matchJobByText(req.user, `${m.subject}\n${m.body}`),
    })));
    res.json({ messages: withMatches });
  } catch (err) {
    next(err);
  }
});

gmailRouter.post('/send-cad', requireAuth, requireHqOrAdmin, async (req, res, next) => {
  try {
    const { to, subject, body } = req.body || {};
    if (!to || !subject) return res.status(400).json({ error: 'to and subject are required' });
    res.json(await GmailService.sendCadEmail(req.user.officeId, { to, subject, body: body || '' }));
  } catch (err) {
    next(err);
  }
});

gmailRouter.post('/bulk-send', requireAuth, requireHqOrAdmin, async (req, res, next) => {
  try {
    const { recipients, subject, body } = req.body || {};
    if (!Array.isArray(recipients) || !recipients.length || !subject) {
      return res.status(400).json({ error: 'recipients (array) and subject are required' });
    }
    res.json({ results: await GmailService.sendBulkMail(req.user.officeId, { recipients, subject, body: body || '' }) });
  } catch (err) {
    next(err);
  }
});

gmailRouter.delete('/disconnect', requireAuth, requireHqOrAdmin, async (req, res, next) => {
  try {
    await GmailService.disconnect(req.user.officeId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
