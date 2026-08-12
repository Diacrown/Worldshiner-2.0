import { pool } from '../db/pool.js';
import { buildScope } from './scope.js';

// Thresholds inferred from seed.js's actual branch_statuses vocabulary, not
// guessed blind — but "Q1" and "CAD/Render" are still assumptions worth
// confirming against the real old-system rules:
//   - Ready-to-Ship, 5 days -> 'ready_to_ship' (exact label match, high confidence)
//   - Q1, 24h -> 'quoting' (could instead mean 'quote_given', waiting on the client)
//   - CAD/Render, 6h -> 'cad_provided' + 'render_submitted' (the outbound-to-client
//     moments; could instead mean 'cad_received'/'render_received', inbound)
export const SLA_THRESHOLDS = {
  quoting: { hours: 24, label: 'Q1 (Quoting)' },
  cad_provided: { hours: 6, label: 'CAD/Render' },
  render_submitted: { hours: 6, label: 'CAD/Render' },
  ready_to_ship: { hours: 120, label: 'Ready to Ship' },
};

export async function listSlaBreaches(user, { officeOverride } = {}) {
  const { where, params } = buildScope(user, { officeOverride });
  const codes = Object.keys(SLA_THRESHOLDS);
  const codesParamIndex = params.length + 1;

  const sql = `
    SELECT DISTINCT ON (j.id)
      j.id, j.job_name, j.priority, j.status_code, o.code AS office_code, o.name AS office_name,
      h.changed_at
    FROM jobs j
    JOIN offices o ON o.id = j.office_id
    JOIN job_status_history h ON h.job_id = j.id AND h.side = 'branch'
    ${where}
    ${where ? 'AND' : 'WHERE'} j.status_code = ANY($${codesParamIndex})
    ORDER BY j.id, h.changed_at DESC
  `;
  const { rows } = await pool.query(sql, [...params, codes]);

  const now = Date.now();
  const breaches = rows
    .map((r) => {
      const threshold = SLA_THRESHOLDS[r.status_code];
      const hoursInStatus = (now - new Date(r.changed_at).getTime()) / 3600000;
      return {
        jobId: r.id,
        jobName: r.job_name,
        priority: r.priority,
        officeCode: r.office_code,
        officeName: r.office_name,
        statusCode: r.status_code,
        slaLabel: threshold.label,
        hoursInStatus: Math.round(hoursInStatus * 10) / 10,
        thresholdHours: threshold.hours,
        overageHours: Math.round((hoursInStatus - threshold.hours) * 10) / 10,
      };
    })
    .filter((b) => b.hoursInStatus > b.thresholdHours)
    .sort((a, b) => b.overageHours - a.overageHours);

  return breaches;
}
