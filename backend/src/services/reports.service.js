import PDFDocument from 'pdfkit';
import { pool } from '../db/pool.js';
import { buildScope } from './scope.js';

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
