import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as HqAlertsService from '../services/hqAlerts.service.js';

// Serves the old Diacrown/Diamore India-tracker's 🔥 Alerts bell (7 status-
// driven categories) — distinct from /api/sla and /api/alerts, which are the
// generic branch-office feed. Only meaningful for HQ users (officeIsHq) or
// admins, but scope is enforced by buildScope regardless of who calls it.
export const hqAlertsRouter = Router();
hqAlertsRouter.use(requireAuth);

hqAlertsRouter.get('/counts', async (req, res, next) => {
  try {
    const { counts, total } = await HqAlertsService.listHqAlertCounts(req.user, { officeOverride: req.query.office });
    res.json({ counts, total, cats: HqAlertsService.HQ_ALERT_CATS.map(({ id, label, limitLabel }) => ({ id, label, limitLabel })) });
  } catch (err) {
    next(err);
  }
});

hqAlertsRouter.get('/:catId', async (req, res, next) => {
  try {
    const items = await HqAlertsService.listHqAlertsForCat(req.user, req.params.catId, { officeOverride: req.query.office });
    if (!items) return res.status(404).json({ error: 'Unknown alert category' });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});
