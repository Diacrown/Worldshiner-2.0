import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { pool } from '../db/pool.js';
import { getJobById } from '../services/jobs.service.js';

export const chatRouter = Router();
chatRouter.use(requireAuth);

chatRouter.get('/jobs/:jobId/chat', async (req, res, next) => {
  try {
    const job = await getJobById(req.user, req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const { rows } = await pool.query(
      `SELECT m.*, u.display_name AS sender_name
       FROM job_chat_messages m LEFT JOIN users u ON u.id = m.sender_user_id
       WHERE m.job_id = $1 ORDER BY m.created_at ASC`,
      [req.params.jobId]
    );
    res.json({ messages: rows });
  } catch (err) {
    next(err);
  }
});

chatRouter.post('/jobs/:jobId/chat', async (req, res, next) => {
  try {
    const job = await getJobById(req.user, req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const { body, imageUrl } = req.body || {};
    if ((!body || !body.trim()) && !imageUrl) {
      return res.status(400).json({ error: 'Message needs a body or an image' });
    }
    const { rows } = await pool.query(
      `INSERT INTO job_chat_messages (job_id, sender_user_id, body, image_url)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.jobId, req.user.sub, body || null, imageUrl || null]
    );
    res.status(201).json({ message: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Marks everything sent so far as read by the caller — drives an unread badge.
chatRouter.post('/jobs/:jobId/chat/read', async (req, res, next) => {
  try {
    await pool.query(
      `INSERT INTO job_chat_read_receipts (job_id, user_id, last_read_at)
       VALUES ($1,$2,now())
       ON CONFLICT (job_id, user_id) DO UPDATE SET last_read_at = now()`,
      [req.params.jobId, req.user.sub]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Unread counts across every job in the caller's scope — powers a header badge
// without the client having to poll every job's full thread.
chatRouter.get('/chat/unread-counts', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.job_id, count(*)::int AS unread
       FROM job_chat_messages m
       JOIN jobs j ON j.id = m.job_id
       LEFT JOIN job_chat_read_receipts r ON r.job_id = m.job_id AND r.user_id = $1
       WHERE m.sender_user_id IS DISTINCT FROM $1
         AND m.created_at > COALESCE(r.last_read_at, 'epoch'::timestamptz)
         AND ($2 OR j.office_id = $3)
       GROUP BY m.job_id`,
      [req.user.sub, req.user.isGlobalAdmin || req.user.officeIsHq, req.user.officeId]
    );
    res.json({ unread: rows });
  } catch (err) {
    next(err);
  }
});
