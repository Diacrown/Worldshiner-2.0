import { pool, withTransaction } from '../db/pool.js';
import { getJobById } from './jobs.service.js';

export async function listIssues(user, jobId) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  const { rows } = await pool.query(
    `SELECT i.*, u1.display_name AS opened_by_name, u2.display_name AS resolved_by_name
     FROM job_issues i
     LEFT JOIN users u1 ON u1.id = i.opened_by_user_id
     LEFT JOIN users u2 ON u2.id = i.resolved_by_user_id
     WHERE i.job_id = $1
     ORDER BY i.opened_at DESC`,
    [jobId]
  );
  return rows;
}

export async function openIssue(user, jobId, { issueType, description }) {
  const job = await getJobById(user, jobId);
  if (!job) return null;
  if (!issueType || !issueType.trim()) {
    const err = new Error('issueType is required');
    err.status = 400;
    throw err;
  }
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO job_issues (job_id, issue_type, description, opened_by_user_id)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [jobId, issueType.trim(), description || null, user.sub]
    );
    const issue = rows[0];
    await client.query(
      `INSERT INTO job_issue_events (issue_id, event_type, actor_user_id, note)
       VALUES ($1,'opened',$2,$3)`,
      [issue.id, user.sub, description || null]
    );
    return issue;
  });
}

export async function updateIssue(user, issueId, { action, note }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM job_issues WHERE id = $1 FOR UPDATE', [issueId]);
    const issue = rows[0];
    if (!issue) return null;

    if (action === 'resolve') {
      const { rows: updated } = await client.query(
        `UPDATE job_issues SET status = 'resolved', resolved_by_user_id = $1, resolved_at = now()
         WHERE id = $2 RETURNING *`,
        [user.sub, issueId]
      );
      await client.query(
        `INSERT INTO job_issue_events (issue_id, event_type, actor_user_id, note) VALUES ($1,'resolved',$2,$3)`,
        [issueId, user.sub, note || null]
      );
      return updated[0];
    }
    if (action === 'reopen') {
      const { rows: updated } = await client.query(
        `UPDATE job_issues SET status = 'open', resolved_by_user_id = NULL, resolved_at = NULL
         WHERE id = $1 RETURNING *`,
        [issueId]
      );
      await client.query(
        `INSERT INTO job_issue_events (issue_id, event_type, actor_user_id, note) VALUES ($1,'reopened',$2,$3)`,
        [issueId, user.sub, note || null]
      );
      return updated[0];
    }
    if (action === 'note') {
      await client.query(
        `INSERT INTO job_issue_events (issue_id, event_type, actor_user_id, note) VALUES ($1,'note',$2,$3)`,
        [issueId, user.sub, note || null]
      );
      return issue;
    }
    const err = new Error(`Unknown action: ${action}. Use resolve, reopen, or note.`);
    err.status = 400;
    throw err;
  });
}

export async function getIssueEvents(issueId) {
  const { rows } = await pool.query(
    `SELECT e.*, u.display_name AS actor_name
     FROM job_issue_events e LEFT JOIN users u ON u.id = e.actor_user_id
     WHERE e.issue_id = $1 ORDER BY e.created_at ASC`,
    [issueId]
  );
  return rows;
}
