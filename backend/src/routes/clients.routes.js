import { Router } from 'express';
import { requireAuth, requireHqOrAdmin } from '../middleware/auth.js';
import { getClientDirectory, getMergeSuggestions, mergeClients } from '../services/clients.service.js';

export const clientsRouter = Router();
clientsRouter.use(requireAuth);

clientsRouter.get('/', async (req, res, next) => {
  try {
    const regions = await getClientDirectory(req.user);
    res.json({ regions });
  } catch (err) {
    next(err);
  }
});

// Merging rewrites job_name for every job under the "duplicate" name, so
// it's restricted to HQ/org-admin/global-admin, same as Staff and Import.
clientsRouter.get('/merge-suggestions', requireHqOrAdmin, async (req, res, next) => {
  try {
    const suggestions = await getMergeSuggestions(req.user);
    res.json({ suggestions });
  } catch (err) {
    next(err);
  }
});

clientsRouter.post('/merge', requireHqOrAdmin, async (req, res, next) => {
  try {
    const result = await mergeClients(req.user, req.body || {});
    res.json(result);
  } catch (err) {
    next(err);
  }
});
