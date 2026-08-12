import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as JobItemsService from '../services/jobItems.service.js';

export const jobItemsRouter = Router();
jobItemsRouter.use(requireAuth);

// ---- Design entries ----

jobItemsRouter.get('/jobs/:jobId/design-entries', async (req, res, next) => {
  try {
    const entries = await JobItemsService.listDesignEntries(req.user, req.params.jobId);
    if (entries === null) return res.status(404).json({ error: 'Job not found' });
    res.json({ entries });
  } catch (err) {
    next(err);
  }
});

jobItemsRouter.post('/jobs/:jobId/design-entries/claim-number', async (req, res, next) => {
  try {
    const result = await JobItemsService.claimDesignNumber(req.user, req.params.jobId);
    if (result === null) return res.status(404).json({ error: 'Job not found' });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

jobItemsRouter.post('/jobs/:jobId/design-entries', async (req, res, next) => {
  try {
    const entry = await JobItemsService.addDesignEntry(req.user, req.params.jobId, req.body || {});
    if (entry === null) return res.status(404).json({ error: 'Job not found' });
    res.status(201).json({ entry });
  } catch (err) {
    next(err);
  }
});

jobItemsRouter.patch('/jobs/:jobId/design-entries/:id', async (req, res, next) => {
  try {
    const entry = await JobItemsService.updateDesignEntry(req.user, req.params.jobId, req.params.id, req.body || {});
    if (!entry) return res.status(404).json({ error: 'Design entry not found' });
    res.json({ entry });
  } catch (err) {
    next(err);
  }
});

jobItemsRouter.delete('/jobs/:jobId/design-entries/:id', async (req, res, next) => {
  try {
    const deleted = await JobItemsService.deleteDesignEntry(req.user, req.params.jobId, req.params.id);
    if (deleted === null) return res.status(404).json({ error: 'Job not found' });
    if (!deleted) return res.status(404).json({ error: 'Design entry not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---- Client items ----

jobItemsRouter.get('/jobs/:jobId/client-items', async (req, res, next) => {
  try {
    const items = await JobItemsService.listClientItems(req.user, req.params.jobId);
    if (items === null) return res.status(404).json({ error: 'Job not found' });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

jobItemsRouter.post('/jobs/:jobId/client-items', async (req, res, next) => {
  try {
    const item = await JobItemsService.addClientItem(req.user, req.params.jobId, req.body || {});
    if (item === null) return res.status(404).json({ error: 'Job not found' });
    res.status(201).json({ item });
  } catch (err) {
    next(err);
  }
});

jobItemsRouter.patch('/jobs/:jobId/client-items/:id', async (req, res, next) => {
  try {
    const item = await JobItemsService.updateClientItem(req.user, req.params.jobId, req.params.id, req.body || {});
    if (!item) return res.status(404).json({ error: 'Client item not found' });
    res.json({ item });
  } catch (err) {
    next(err);
  }
});

jobItemsRouter.delete('/jobs/:jobId/client-items/:id', async (req, res, next) => {
  try {
    const deleted = await JobItemsService.deleteClientItem(req.user, req.params.jobId, req.params.id);
    if (deleted === null) return res.status(404).json({ error: 'Job not found' });
    if (!deleted) return res.status(404).json({ error: 'Client item not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
