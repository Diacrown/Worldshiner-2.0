import { Router } from 'express';
import { requireAuth, requireHqOrAdmin, resolveWriteOfficeId } from '../middleware/auth.js';
import * as JobsService from '../services/jobs.service.js';
import { getOrCreateTrackingToken, revokeTrackingToken } from '../services/tracking.service.js';
import { pullQuoteIntoProduction } from '../services/jwyCalculator.service.js';

export const jobsRouter = Router();
jobsRouter.use(requireAuth);

jobsRouter.get('/', async (req, res, next) => {
  try {
    const { office, view, status, search, clientPrefix, limit, offset } = req.query;
    const jobs = await JobsService.listJobs(req.user, {
      officeOverride: office,
      ownerView: view,
      status,
      search,
      clientPrefix,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    res.json({ jobs });
  } catch (err) {
    next(err);
  }
});

jobsRouter.post('/assay/batch', async (req, res, next) => {
  try {
    const result = await JobsService.batchUpdateAssay(req.user, req.body || {});
    res.json(result);
  } catch (err) {
    next(err);
  }
});

jobsRouter.get('/:id', async (req, res, next) => {
  try {
    const job = await JobsService.getJobById(req.user, req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ job });
  } catch (err) {
    next(err);
  }
});

jobsRouter.post('/:id/pull-from-calculator', async (req, res, next) => {
  try {
    const result = await pullQuoteIntoProduction(req.user, req.params.id);
    if (result === null) return res.status(404).json({ error: 'Job not found' });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

jobsRouter.get('/:id/production', async (req, res, next) => {
  try {
    const production = await JobsService.getJobProduction(req.user, req.params.id);
    if (production === null) return res.status(404).json({ error: 'Job not found' });
    res.json({ production });
  } catch (err) {
    next(err);
  }
});

jobsRouter.patch('/:id/production', async (req, res, next) => {
  try {
    const production = await JobsService.updateJobProduction(req.user, req.params.id, req.body || {});
    if (production === null) return res.status(404).json({ error: 'Job not found' });
    res.json({ production });
  } catch (err) {
    next(err);
  }
});

jobsRouter.post('/:id/tracking-link', async (req, res, next) => {
  try {
    const token = await getOrCreateTrackingToken(req.user, req.params.id);
    if (!token) return res.status(404).json({ error: 'Job not found' });
    res.json({ token });
  } catch (err) {
    next(err);
  }
});

jobsRouter.delete('/:id/tracking-link', async (req, res, next) => {
  try {
    const ok = await revokeTrackingToken(req.user, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Job not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

jobsRouter.get('/:id/images', async (req, res, next) => {
  try {
    const images = await JobsService.listJobImages(req.user, req.params.id);
    if (images === null) return res.status(404).json({ error: 'Job not found' });
    res.json({ images });
  } catch (err) {
    next(err);
  }
});

jobsRouter.post('/:id/images', async (req, res, next) => {
  try {
    const image = await JobsService.addJobImage(req.user, req.params.id, req.body || {});
    if (!image) return res.status(404).json({ error: 'Job not found' });
    res.status(201).json({ image });
  } catch (err) {
    next(err);
  }
});

jobsRouter.delete('/:id/images/:imageId', async (req, res, next) => {
  try {
    const ok = await JobsService.removeJobImage(req.user, req.params.id, req.params.imageId);
    if (!ok) return res.status(404).json({ error: 'Image or job not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

jobsRouter.get('/:id/specs', async (req, res, next) => {
  try {
    const specs = await JobsService.listJobSpecs(req.user, req.params.id);
    if (specs === null) return res.status(404).json({ error: 'Job not found' });
    res.json({ specs });
  } catch (err) {
    next(err);
  }
});

jobsRouter.post('/:id/specs', async (req, res, next) => {
  try {
    const spec = await JobsService.addJobSpec(req.user, req.params.id, req.body || {});
    if (!spec) return res.status(404).json({ error: 'Job not found' });
    res.status(201).json({ spec });
  } catch (err) {
    next(err);
  }
});

jobsRouter.delete('/:id/specs/:specId', async (req, res, next) => {
  try {
    const ok = await JobsService.removeJobSpec(req.user, req.params.id, req.params.specId);
    if (!ok) return res.status(404).json({ error: 'Spec or job not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

jobsRouter.get('/:id/history', async (req, res, next) => {
  try {
    const history = await JobsService.getJobHistory(req.user, req.params.id);
    if (!history) return res.status(404).json({ error: 'Job not found' });
    res.json({ history });
  } catch (err) {
    next(err);
  }
});

jobsRouter.post('/', async (req, res, next) => {
  try {
    const officeId = await resolveWriteOfficeId(req);
    const job = await JobsService.createJob(req.user, officeId, req.body || {});
    res.status(201).json({ job });
  } catch (err) {
    next(err);
  }
});

// India/HQ setting its own internal status (and optionally production dates)
// — the other direction of the branch<->HQ sync. Separate from the branch
// status route above because it's a different vocabulary and different
// people are allowed to touch it.
jobsRouter.patch('/:id', async (req, res, next) => {
  try {
    const job = await JobsService.updateJob(req.user, req.params.id, req.body || {});
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ job });
  } catch (err) {
    next(err);
  }
});

jobsRouter.patch('/:id/hq-status', requireHqOrAdmin, async (req, res, next) => {
  try {
    const { hqStatusCode, productionFields, note } = req.body || {};
    if (!hqStatusCode) return res.status(400).json({ error: 'hqStatusCode is required' });
    const job = await JobsService.changeJobHqStatus(req.user, req.params.id, {
      newHqStatusCode: hqStatusCode,
      productionFields,
      note,
    });
    res.json({ job });
  } catch (err) {
    next(err);
  }
});

jobsRouter.patch('/:id/status', async (req, res, next) => {
  try {
    const { statusCode, settingCharge, note } = req.body || {};
    if (!statusCode) return res.status(400).json({ error: 'statusCode is required' });
    const job = await JobsService.changeJobStatus(req.user, req.params.id, {
      newStatusCode: statusCode,
      providedSettingCharge: settingCharge,
      note,
    });
    res.json({ job });
  } catch (err) {
    next(err);
  }
});
