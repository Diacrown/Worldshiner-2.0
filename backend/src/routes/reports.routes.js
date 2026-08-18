import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as ReportsService from '../services/reports.service.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

function parseYearMonth(req) {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!year || !month || month < 1 || month > 12) {
    const err = new Error('year and month query params are required (month 1-12)');
    err.status = 400;
    throw err;
  }
  return { year, month };
}

reportsRouter.get('/monthly-summary', async (req, res, next) => {
  try {
    const { year, month } = parseYearMonth(req);
    const summaries = await ReportsService.getMonthlyOfficeSummary(req.user, { year, month, officeOverride: req.query.office });
    res.json({ year, month, offices: summaries });
  } catch (err) {
    next(err);
  }
});

reportsRouter.get('/monthly-summary/pdf', async (req, res, next) => {
  try {
    const { year, month } = parseYearMonth(req);
    const summaries = await ReportsService.getMonthlyOfficeSummary(req.user, { year, month, officeOverride: req.query.office });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="worldshiner-report-${year}-${String(month).padStart(2, '0')}.pdf"`);
    ReportsService.renderMonthlyReportPdf(summaries, { year, month }, res);
  } catch (err) {
    next(err);
  }
});

reportsRouter.get('/setter-polisher-summary', async (req, res, next) => {
  try {
    res.json({ entries: await ReportsService.getSetterPolisherSummary(req.user, { officeOverride: req.query.office }) });
  } catch (err) {
    next(err);
  }
});

reportsRouter.get('/overdue', async (req, res, next) => {
  try {
    res.json({ jobs: await ReportsService.getOverdueQuotingAndCad(req.user, { officeOverride: req.query.office }) });
  } catch (err) {
    next(err);
  }
});

reportsRouter.get('/client-items', async (req, res, next) => {
  try {
    res.json({ items: await ReportsService.getClientItemsReport(req.user, { officeOverride: req.query.office }) });
  } catch (err) {
    next(err);
  }
});

reportsRouter.get('/export.csv', async (req, res, next) => {
  try {
    const csv = await ReportsService.exportJobsCsv(req.user, { officeOverride: req.query.office, status: req.query.status, search: req.query.search });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="worldshiner-jobs.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
});
