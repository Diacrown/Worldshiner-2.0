import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as SlaService from '../services/sla.service.js';

export const slaRouter = Router();
slaRouter.use(requireAuth);

slaRouter.get('/breaches', async (req, res, next) => {
  try {
    const breaches = await SlaService.listSlaBreaches(req.user, { officeOverride: req.query.office });
    res.json({ breaches, thresholds: SlaService.SLA_THRESHOLDS });
  } catch (err) {
    next(err);
  }
});
