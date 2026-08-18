import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as AlertsService from '../services/alerts.service.js';

export const alertsRouter = Router();
alertsRouter.use(requireAuth);

alertsRouter.get('/', async (req, res, next) => {
  try {
    res.json(await AlertsService.listAlerts(req.user, { officeOverride: req.query.office }));
  } catch (err) {
    next(err);
  }
});

alertsRouter.post('/jobs/:jobId/snooze', async (req, res, next) => {
  try {
    const result = await AlertsService.snoozeJob(req.user, req.params.jobId, req.body?.days || 10);
    if (!result) return res.status(404).json({ error: 'Job not found' });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
