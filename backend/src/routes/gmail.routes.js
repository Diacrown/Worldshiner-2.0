import { Router } from 'express';
import { requireAuth, requireHqOrAdmin, requireOfficeAdminOrAbove } from '../middleware/auth.js';
import * as GmailService from '../services/gmail.service.js';
import { matchJobByText } from '../services/jobs.service.js';

export const gmailRouter = Router();

// GET /status is intentionally public-to-any-authenticated-user and never
// throws — the frontend needs this to render "not configured" gracefully.
// Always about the CALLER'S OWN office — each office connects its own
// mailbox independently (see gmail_oauth_tokens, keyed by office_id).
gmailRouter.get('/status', requireAuth, async (req, res, next) => {
  try {
    res.json(await GmailService.getStatus(req.user.officeId));
  } catch (err) {
    next(err);
  }
});

// HQ/org-admin's view across every office in their org at once, so they can
// see who's connected before checking the combined inbox.
gmailRouter.get('/status-by-office', requireAuth, requireHqOrAdmin, async (req, res, next) => {
  try {
    res.json({ offices: await GmailService.getStatusByOffice(req.user.orgId) });
  } catch (err) {
    next(err);
  }
});

// Connecting/disconnecting/sending is self-service per office (any office
// master or above can manage their own office's mailbox — not gated to
// HQ/admin the way it used to be, now that every office has its own
// connection instead of one company-wide mailbox). Each of these always
// acts on the caller's OWN officeId; there's no "connect on behalf of
// another office" path since that mailbox's real owner should be the one
// authorizing it.
gmailRouter.get('/connect', requireAuth, requireOfficeAdminOrAbove, async (req, res, next) => {
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

gmailRouter.get('/inquiries', requireAuth, requireOfficeAdminOrAbove, async (req, res, next) => {
  try {
    res.json(await GmailService.searchInquiries(req.user.officeId, req.query.q));
  } catch (err) {
    next(err);
  }
});

// Recent inbox messages, each with a best-guess job match (by PO number) so
// staff can either drop a reply straight into that job's chat, or — if
// nothing matched — use it to pre-fill a new job. A branch office sees only
// its own connected mailbox; HQ/org-admin/global-admin sees every connected
// office in the org at once, each message tagged with which office it came
// from — same "HQ sees everything, branch sees its own" split used
// everywhere else in this app, just applied to mailboxes instead of jobs.
gmailRouter.get('/inbox', requireAuth, requireOfficeAdminOrAbove, async (req, res, next) => {
  try {
    const isHqOrAdmin = req.user.isGlobalAdmin || req.user.isOrgAdmin || req.user.officeIsHq;
    const targetOffices = isHqOrAdmin
      ? await GmailService.listConnectedOfficeIds(req.user.orgId)
      : [{ officeId: req.user.officeId, officeCode: req.user.officeCode, officeName: null }];

    const perOffice = await Promise.all(targetOffices.map(async (office) => {
      try {
        const messages = await GmailService.listInboxCandidates(office.officeId);
        return messages.map((m) => ({ ...m, officeCode: office.officeCode, officeName: office.officeName }));
      } catch {
        return []; // one office's mailbox having an issue shouldn't blank out everyone else's
      }
    }));

    const flat = perOffice.flat().sort((a, b) => new Date(b.date) - new Date(a.date));
    const withMatches = await Promise.all(flat.map(async (m) => ({
      ...m,
      matchedJob: await matchJobByText(req.user, `${m.subject}\n${m.body}`),
    })));
    res.json({ messages: withMatches });
  } catch (err) {
    next(err);
  }
});

gmailRouter.post('/send-cad', requireAuth, requireOfficeAdminOrAbove, async (req, res, next) => {
  try {
    const { to, subject, body } = req.body || {};
    if (!to || !subject) return res.status(400).json({ error: 'to and subject are required' });
    res.json(await GmailService.sendCadEmail(req.user.officeId, { to, subject, body: body || '' }));
  } catch (err) {
    next(err);
  }
});

gmailRouter.post('/bulk-send', requireAuth, requireOfficeAdminOrAbove, async (req, res, next) => {
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

gmailRouter.delete('/disconnect', requireAuth, requireOfficeAdminOrAbove, async (req, res, next) => {
  try {
    await GmailService.disconnect(req.user.officeId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
