import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { getJobById } from './jobs.service.js';
import { STAGE_ORDER, STAGE_FOR_STATUS, STAGE_LABELS } from './trackingStages.js';

// getJobById already enforces the caller's office-scope permission check, so
// only staff who could already see this job can mint or revoke its link.
export async function getOrCreateTrackingToken(user, jobId) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  if (job.public_tracking_token) return job.public_tracking_token;
  const token = crypto.randomBytes(18).toString('base64url');
  await pool.query('UPDATE jobs SET public_tracking_token = $1 WHERE id = $2', [token, jobId]);
  return token;
}

export async function revokeTrackingToken(user, jobId) {
  const job = await getJobById(user, jobId);
  if (!job) return false;
  await pool.query('UPDATE jobs SET public_tracking_token = NULL WHERE id = $1', [jobId]);
  return true;
}

// Walks history newest-first and skips on_hold/not_proceeding (side-states,
// not points on the linear track) to find how far the job has really
// progressed, even if its current raw status is one of those side-states.
function resolveStage(historyRows, currentStatusCode) {
  for (let i = historyRows.length - 1; i >= 0; i--) {
    const stage = STAGE_FOR_STATUS[historyRows[i].status_code];
    if (stage) return stage;
  }
  return STAGE_FOR_STATUS[currentStatusCode] || STAGE_ORDER[0].key;
}

// Public, unauthenticated lookup by an unguessable token — must never leak
// anything beyond what's safe for a client to see: no notes, pricing,
// vendor/setter names, PO number, or any other job's data.
export async function getPublicTracking(token) {
  const { rows } = await pool.query(
    `SELECT j.id, j.job_name, j.status_code, j.client_delivery_date, j.created_at, o.name AS office_name
     FROM jobs j JOIN offices o ON o.id = j.office_id
     WHERE j.public_tracking_token = $1`,
    [token]
  );
  const job = rows[0];
  if (!job) return null;

  const { rows: history } = await pool.query(
    `SELECT status_code, changed_at FROM job_status_history
     WHERE job_id = $1 AND side = 'branch' ORDER BY changed_at ASC`,
    [job.id]
  );

  const stageReachedAt = new Map();
  for (const h of history) {
    const stage = STAGE_FOR_STATUS[h.status_code];
    if (stage && !stageReachedAt.has(stage)) stageReachedAt.set(stage, h.changed_at);
  }

  const currentStage = resolveStage(history, job.status_code);
  const currentIndex = STAGE_ORDER.findIndex((s) => s.key === currentStage);
  const timeline = STAGE_ORDER.map((s, i) => ({
    key: s.key,
    label: s.label,
    description: s.description,
    reached: i <= currentIndex,
    reachedAt: stageReachedAt.get(s.key) || null,
  }));

  return {
    jobName: job.job_name,
    officeName: job.office_name,
    onHold: job.status_code === 'on_hold',
    cancelled: job.status_code === 'not_proceeding',
    expectedDelivery: job.client_delivery_date,
    orderedAt: job.created_at,
    currentStageLabel: STAGE_LABELS[currentStage] || 'In Progress',
    timeline,
  };
}
