import { Router } from 'express';
import { getPublicTracking } from '../services/tracking.service.js';

// Deliberately NOT behind requireAuth — this is the public, client-facing
// tracking link (like a courier tracking number). Security rests entirely
// on the token being an unguessable 144-bit random value; the service layer
// (tracking.service.js getPublicTracking) is responsible for returning only
// customer-safe fields.
export const trackRouter = Router();

trackRouter.get('/:token', async (req, res, next) => {
  try {
    const tracking = await getPublicTracking(req.params.token);
    if (!tracking) return res.status(404).json({ error: 'Tracking link not found' });
    res.json(tracking);
  } catch (err) {
    next(err);
  }
});
