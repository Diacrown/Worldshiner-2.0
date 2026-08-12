import { Router } from 'express';
import { requireAuth, requireOrgAdminOrAbove } from '../middleware/auth.js';
import * as InvitesService from '../services/invites.service.js';

export const invitesRouter = Router();
invitesRouter.use(requireAuth, requireOrgAdminOrAbove);

invitesRouter.get('/', async (req, res, next) => {
  try {
    const invites = await InvitesService.listInvites(req.user, req.query.office);
    res.json({ invites });
  } catch (err) {
    next(err);
  }
});

invitesRouter.post('/', async (req, res, next) => {
  try {
    const invite = await InvitesService.createInvite(req.user, req.body || {});
    res.status(201).json({ invite });
  } catch (err) {
    next(err);
  }
});

invitesRouter.patch('/:id/revoke', async (req, res, next) => {
  try {
    const invite = await InvitesService.revokeInvite(req.user, req.params.id);
    if (!invite) return res.status(404).json({ error: 'Invite not found' });
    res.json({ invite });
  } catch (err) {
    next(err);
  }
});
