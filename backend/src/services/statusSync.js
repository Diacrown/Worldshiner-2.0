import { pool } from '../db/pool.js';

// Replaces the hardcoded BRANCH_TO_HQ JS object that lived inside every
// office's HTML file. When a branch office moves a job to `branchStatusCode`,
// this returns the India-side status that should be written alongside it —
// or null if that branch status intentionally leaves India's status alone
// (matches old behaviour for e.g. 'Render Submitted' and 'Local Production').
export async function getBranchToHqStatus(branchStatusCode) {
  const { rows } = await pool.query(
    'SELECT hq_status_code FROM branch_to_hq_status_map WHERE branch_status_code = $1',
    [branchStatusCode]
  );
  return rows[0]?.hq_status_code ?? null;
}

// Replaces the hardcoded HEADLINE JS object. When India changes its own
// internal status, this returns what the branch office should see instead
// (several India-internal statuses all headline as one branch-visible status).
export async function getHqToBranchHeadline(hqStatusCode) {
  const { rows } = await pool.query(
    'SELECT branch_status_code FROM hq_to_branch_headline_map WHERE hq_status_code = $1',
    [hqStatusCode]
  );
  return rows[0]?.branch_status_code ?? null;
}

export async function getBranchStatus(code) {
  const { rows } = await pool.query('SELECT * FROM branch_statuses WHERE code = $1', [code]);
  return rows[0] ?? null;
}
