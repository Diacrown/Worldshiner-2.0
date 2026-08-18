import { pool } from '../db/pool.js';
import { buildScope } from './scope.js';

// Distinct from SLA breaches (time-in-status) — these are date/silence-driven,
// matching the branch manual's three alert types exactly.
export async function listAlerts(user, { officeOverride } = {}) {
  const { where, params } = buildScope(user, { officeOverride });
  const baseWhere = where ? `${where} AND` : 'WHERE';

  const dueSoonSql = `
    SELECT j.id, j.job_name, j.priority, o.code AS office_code, o.name AS office_name,
           j.client_delivery_date, 'due_soon' AS alert_type
    FROM jobs j JOIN offices o ON o.id = j.office_id
    JOIN branch_statuses bs ON bs.code = j.status_code
    ${baseWhere} bs.is_archive = FALSE
      AND j.client_delivery_date IS NOT NULL
      AND j.client_delivery_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '3 days'
      AND (j.snoozed_until IS NULL OR j.snoozed_until < CURRENT_DATE)
  `;

  // "Awaiting overseas update" — no HQ-side status change in 5+ days while
  // the job is still open. Threshold is an assumption (documented), same as
  // the SLA thresholds were — easy to tune once real usage confirms it.
  const awaitingOverseasSql = `
    SELECT j.id, j.job_name, j.priority, o.code AS office_code, o.name AS office_name,
           (SELECT max(h.changed_at) FROM job_status_history h WHERE h.job_id = j.id AND h.side = 'hq') AS last_hq_update,
           'awaiting_overseas' AS alert_type
    FROM jobs j JOIN offices o ON o.id = j.office_id
    JOIN branch_statuses bs ON bs.code = j.status_code
    ${baseWhere} bs.is_archive = FALSE
      AND (j.snoozed_until IS NULL OR j.snoozed_until < CURRENT_DATE)
      AND COALESCE(
        (SELECT max(h.changed_at) FROM job_status_history h WHERE h.job_id = j.id AND h.side = 'hq'),
        j.created_at
      ) < now() - INTERVAL '5 days'
  `;

  const chaseUpSql = `
    SELECT j.id, j.job_name, j.priority, o.code AS office_code, o.name AS office_name,
           j.follow_up_date, 'chase_up' AS alert_type
    FROM jobs j JOIN offices o ON o.id = j.office_id
    JOIN branch_statuses bs ON bs.code = j.status_code
    ${baseWhere} bs.is_archive = FALSE
      AND j.follow_up_date IS NOT NULL
      AND j.follow_up_date <= CURRENT_DATE
      AND (j.snoozed_until IS NULL OR j.snoozed_until < CURRENT_DATE)
  `;

  const [dueSoon, awaitingOverseas, chaseUp] = await Promise.all([
    pool.query(dueSoonSql, params),
    pool.query(awaitingOverseasSql, params),
    pool.query(chaseUpSql, params),
  ]);

  return {
    dueSoon: dueSoon.rows,
    awaitingOverseas: awaitingOverseas.rows,
    chaseUp: chaseUp.rows,
  };
}

export async function snoozeJob(user, jobId, days = 10) {
  const { rows } = await pool.query(
    `UPDATE jobs SET snoozed_until = CURRENT_DATE + ($1 || ' days')::interval WHERE id = $2 RETURNING id, snoozed_until`,
    [days, jobId]
  );
  return rows[0] ?? null;
}
