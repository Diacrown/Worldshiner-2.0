import PDFDocument from 'pdfkit';
import { pool } from '../db/pool.js';
import { buildScope } from './scope.js';
import { getClientDirectory } from './clients.service.js';

// Per-office monthly summary. "Completed" and "Not Proceeding" are kept as
// separate counts rather than one collapsed "done" bucket — conflating a
// finished job with a cancelled one would misrepresent the numbers. Both
// counts, plus the full status-transition breakdown, come from
// job_status_history rows landing in the given month (not jobs.status_code's
// *current* value), so a job archived in a prior month isn't double-counted
// here just because it's still sitting in that status today.
export async function getMonthlyOfficeSummary(user, { year, month, officeOverride } = {}) {
  const { where, params } = buildScope(user, { officeOverride });
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));

  const createdSql = `
    SELECT o.id AS office_id, o.code AS office_code, o.name AS office_name, count(*)::int AS created_count
    FROM jobs j JOIN offices o ON o.id = j.office_id
    ${where}
    ${where ? 'AND' : 'WHERE'} j.created_at >= $${params.length + 1} AND j.created_at < $${params.length + 2}
    GROUP BY o.id, o.code, o.name
  `;
  const { rows: createdRows } = await pool.query(createdSql, [...params, start, end]);

  const histSql = `
    SELECT o.id AS office_id, o.code AS office_code, o.name AS office_name,
           h.status_code, bs.label, count(*)::int AS n
    FROM job_status_history h
    JOIN jobs j ON j.id = h.job_id
    JOIN offices o ON o.id = j.office_id
    JOIN branch_statuses bs ON bs.code = h.status_code
    ${where}
    ${where ? 'AND' : 'WHERE'} h.side = 'branch' AND h.changed_at >= $${params.length + 1} AND h.changed_at < $${params.length + 2}
    GROUP BY o.id, o.code, o.name, h.status_code, bs.label
  `;
  const { rows: histRows } = await pool.query(histSql, [...params, start, end]);

  const offices = new Map();
  const ensure = (id, code, name) => {
    if (!offices.has(id)) {
      offices.set(id, { officeCode: code, officeName: name, createdCount: 0, completedCount: 0, notProceedingCount: 0, statusBreakdown: [] });
    }
    return offices.get(id);
  };
  for (const r of createdRows) ensure(r.office_id, r.office_code, r.office_name).createdCount = r.created_count;
  for (const r of histRows) {
    const entry = ensure(r.office_id, r.office_code, r.office_name);
    entry.statusBreakdown.push({ code: r.status_code, label: r.label, count: r.n });
    if (r.status_code === 'job_completed') entry.completedCount += r.n;
    if (r.status_code === 'not_proceeding') entry.notProceedingCount += r.n;
  }
  return [...offices.values()].sort((a, b) => a.officeName.localeCompare(b.officeName));
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function renderMonthlyReportPdf(summaries, { year, month }, res) {
  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  doc.fontSize(20).text(`World Shiner — Monthly Report`, { align: 'left' });
  doc.fontSize(12).fillColor('#647085').text(`${MONTH_NAMES[month - 1]} ${year}`);
  doc.moveDown(1.5);

  if (!summaries.length) {
    doc.fillColor('#1b2432').fontSize(12).text('No activity recorded for this period in your visible offices.');
  }

  for (const office of summaries) {
    doc.fillColor('#28466b').fontSize(14).text(office.officeName, { underline: true });
    doc.moveDown(0.3);
    doc.fillColor('#1b2432').fontSize(11);
    doc.text(`Jobs created: ${office.createdCount}`);
    doc.text(`Completed: ${office.completedCount}    Not proceeding: ${office.notProceedingCount}`);
    doc.moveDown(0.3);
    if (office.statusBreakdown.length) {
      doc.fontSize(10).fillColor('#647085').text('Status activity this month:');
      for (const s of office.statusBreakdown) {
        doc.text(`  ${s.label}: ${s.count}`);
      }
    }
    doc.moveDown(1);
  }

  doc.end();
}

// Jobs currently out with a setter/polisher/repairer, i.e. sent but not yet
// returned (date_sent set, date_returned still null).
export async function getSetterPolisherSummary(user, { officeOverride } = {}) {
  const { where, params } = buildScope(user, { officeOverride });
  const sql = `
    SELECT sp.role_type, sp.person_name, sp.date_sent, sp.due_date, sp.fee,
           j.id AS job_id, j.job_name, o.code AS office_code, o.name AS office_name
    FROM job_setter_polisher sp
    JOIN jobs j ON j.id = sp.job_id
    JOIN offices o ON o.id = j.office_id
    ${where}
    ${where ? 'AND' : 'WHERE'} sp.date_sent IS NOT NULL AND sp.date_returned IS NULL
    ORDER BY sp.role_type, sp.date_sent
  `;
  const { rows } = await pool.query(sql, params);
  return rows;
}

// Jobs stuck in Quoting or CAD Approved past a threshold (days) — same shape
// as the SLA breach query, but this pair of statuses specifically, per the
// manual's "Overdue: Quoting & CAD Approved" report.
export async function getOverdueQuotingAndCad(user, { officeOverride, thresholdDays = 5 } = {}) {
  const { where, params } = buildScope(user, { officeOverride });
  const codesParamIndex = params.length + 1;
  const sql = `
    SELECT DISTINCT ON (j.id)
      j.id, j.job_name, j.priority, j.status_code, o.code AS office_code, o.name AS office_name, h.changed_at
    FROM jobs j
    JOIN offices o ON o.id = j.office_id
    JOIN job_status_history h ON h.job_id = j.id AND h.side = 'branch'
    ${where}
    ${where ? 'AND' : 'WHERE'} j.status_code = ANY($${codesParamIndex})
    ORDER BY j.id, h.changed_at DESC
  `;
  const { rows } = await pool.query(sql, [...params, ['quoting', 'cad_approved']]);
  const now = Date.now();
  return rows
    .map((r) => ({ ...r, daysInStatus: Math.round((now - new Date(r.changed_at).getTime()) / 86400000) }))
    .filter((r) => r.daysInStatus >= thresholdDays)
    .sort((a, b) => b.daysInStatus - a.daysInStatus);
}

export async function getClientItemsReport(user, { officeOverride } = {}) {
  const { where, params } = buildScope(user, { officeOverride });
  const sql = `
    SELECT ci.id, ci.description, j.id AS job_id, j.job_name, o.code AS office_code, o.name AS office_name
    FROM job_client_items ci
    JOIN jobs j ON j.id = ci.job_id
    JOIN offices o ON o.id = j.office_id
    ${where}
    ORDER BY o.name, j.job_name
  `;
  const { rows } = await pool.query(sql, params);
  return rows;
}

export async function exportJobsCsv(user, { officeOverride, status, search } = {}) {
  const { where, params } = buildScope(user, { officeOverride });
  const extra = [];
  if (status) { params.push(status); extra.push(`j.status_code = $${params.length}`); }
  if (search) { params.push(`%${search}%`); extra.push(`j.job_name ILIKE $${params.length}`); }
  let sql = `
    SELECT j.job_name, j.contact_person, j.priority, j.status_code, o.name AS office_name,
           j.po_number, j.design_no, j.client_delivery_date, j.created_at
    FROM jobs j JOIN offices o ON o.id = j.office_id
    ${where}
  `;
  if (extra.length) sql += (where ? ' AND ' : ' WHERE ') + extra.join(' AND ');
  sql += ' ORDER BY j.created_at DESC';
  const { rows } = await pool.query(sql, params);

  const escape = (v) => {
    if (v == null) return '';
    const s = v instanceof Date ? v.toISOString() : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const headers = ['Job Name', 'Contact', 'Priority', 'Status', 'Office', 'PO Number', 'Design No', 'Delivery Date', 'Created At'];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([r.job_name, r.contact_person, r.priority, r.status_code, r.office_name, r.po_number, r.design_no, r.client_delivery_date, r.created_at].map(escape).join(','));
  }
  return lines.join('\n');
}

// A step up from the static Monthly Summary: jobs/revenue trend over time,
// average turnaround per office, and a top-clients leaderboard. Turnaround
// is measured from job creation to its job_completed status-history event
// (not just current status_code), same reasoning as getMonthlyOfficeSummary
// — a job archived last month shouldn't be missing from this because its
// current status has since changed... except job_completed is a terminal
// archive status, so in practice it never does; kept consistent anyway.
export async function getExecutiveDashboard(user, { months = 6 } = {}) {
  const { where, params } = buildScope(user);
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - (Math.max(1, Math.min(24, months)) - 1));
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);

  const trendSql = `
    SELECT date_trunc('month', j.created_at) AS month, count(*)::int AS job_count,
           COALESCE(sum(j.invoice_amount), 0)::numeric AS revenue
    FROM jobs j
    ${where}
    ${where ? 'AND' : 'WHERE'} j.created_at >= $${params.length + 1}
    GROUP BY 1
    ORDER BY 1
  `;
  const { rows: trendRows } = await pool.query(trendSql, [...params, since]);

  // A true "time to complete" turnaround turned out not to be reliably
  // computable: 448 jobs currently sit at job_completed, and essentially
  // all of them have exactly one job_status_history row total (the
  // completion event itself) — the old system's bulk-migrated records
  // never had intermediate stage timestamps to reconstruct, so there's no
  // real "start" to measure against for a finished job. jobs.created_at
  // doesn't fill that gap either: ~1100 of 2855 jobs share one identical
  // created_at value, which is when the old system's own bulk import into
  // Firestore ran, not each job's real start date.
  //
  // What IS honestly computable: how long currently-open jobs have been
  // sitting since their earliest tracked stage. Every open job has at
  // least its current status as a history row, so this doesn't hit the
  // same sparse-data wall — and it's arguably the more actionable number
  // for HQ anyway (which office has a backlog right now), vs. a historical
  // average that can't flag anything currently happening.
  const turnaroundSql = `
    WITH job_starts AS (
      SELECT job_id, MIN(changed_at) AS started_at
      FROM job_status_history
      WHERE side = 'branch'
      GROUP BY job_id
    )
    SELECT o.code AS office_code, o.name AS office_name,
           avg(extract(epoch FROM (now() - js.started_at)) / 86400)::numeric AS avg_open_days,
           count(*)::int AS open_count
    FROM jobs j
    JOIN offices o ON o.id = j.office_id
    JOIN job_starts js ON js.job_id = j.id
    ${where}
    ${where ? 'AND' : 'WHERE'} j.status_code NOT IN ('job_completed', 'not_proceeding')
    GROUP BY o.code, o.name
    ORDER BY avg_open_days DESC
  `;
  const { rows: turnaroundRows } = await pool.query(turnaroundSql, params);

  // Reuses the Clients page's own directory computation rather than a
  // separate query — "top clients" is just that same data flattened and
  // sorted, so it can never drift out of sync with what the Clients page
  // itself shows.
  const directory = await getClientDirectory(user);
  const topClients = [];
  for (const region of directory) {
    for (const country of region.countries) {
      for (const office of country.offices) {
        for (const client of office.clients) {
          topClients.push({
            clientName: client.clientName, officeCode: office.officeCode, officeName: office.officeName,
            jobCount: client.jobCount, lastActivity: client.lastActivity,
          });
        }
      }
    }
  }
  topClients.sort((a, b) => b.jobCount - a.jobCount);

  return {
    trend: trendRows.map((r) => ({ month: r.month, jobCount: r.job_count, revenue: Number(r.revenue) })),
    openJobAgeByOffice: turnaroundRows.map((r) => ({
      officeCode: r.office_code, officeName: r.office_name,
      avgOpenDays: r.avg_open_days != null ? Number(r.avg_open_days) : null, openCount: r.open_count,
    })),
    topClients: topClients.slice(0, 15),
  };
}
