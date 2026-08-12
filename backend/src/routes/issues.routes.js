import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as IssuesService from '../services/issues.service.js';

export const issuesRouter = Router();
issuesRouter.use(requireAuth);

issuesRouter.get('/jobs/:jobId/issues', async (req, res, next) => {
  try {
    const issues = await IssuesService.listIssues(req.user, req.params.jobId);
    if (issues === null) return res.status(404).json({ error: 'Job not found' });
    res.json({ issues });
  } catch (err) {
    next(err);
  }
});

issuesRouter.post('/jobs/:jobId/issues', async (req, res, next) => {
  try {
    const issue = await IssuesService.openIssue(req.user, req.params.jobId, req.body || {});
    if (!issue) return res.status(404).json({ error: 'Job not found' });
    res.status(201).json({ issue });
  } catch (err) {
    next(err);
  }
});

issuesRouter.patch('/issues/:id', async (req, res, next) => {
  try {
    const { action, note } = req.body || {};
    if (!action) return res.status(400).json({ error: 'action is required (resolve, reopen, or note)' });
    const issue = await IssuesService.updateIssue(req.user, req.params.id, { action, note });
    if (!issue) return res.status(404).json({ error: 'Issue not found' });
    res.json({ issue });
  } catch (err) {
    next(err);
  }
});

issuesRouter.get('/issues/:id/events', async (req, res, next) => {
  try {
    const events = await IssuesService.getIssueEvents(req.params.id);
    res.json({ events });
  } catch (err) {
    next(err);
  }
});
