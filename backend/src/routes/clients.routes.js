import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getClientDirectory } from '../services/clients.service.js';

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
