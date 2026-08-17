// Office-wide broadcast chat with HQ — separate from per-job chat
// (chat.routes.js). Confirmed as a real, actively-used feature in the old
// system's office_chat Firestore collection.
import { Router } from 'express';
import { requireAuth, resolveWriteOfficeId } from '../middleware/auth.js';
import { pool } from '../db/pool.js';

export const officeChatRouter = Router();
officeChatRouter.use(requireAuth);

async function resolveReadOfficeId(req) {
  const code = req.query.office;
  if (!code) return req.user.officeId;
  if (req.user.isGlobalAdmin) {
    const { rows } = await pool.query('SELECT id FROM offices WHERE code = $1', [code]);
    return rows[0]?.id ?? null;
  }
  if (req.user.isOrgAdmin || req.user.officeIsHq) {
    const { rows } = await pool.query('SELECT id FROM offices WHERE code = $1 AND org_id = $2', [code, req.user.orgId]);
    return rows[0]?.id ?? null;
  }
  return code === req.user.officeCode ? req.user.officeId : null;
}

officeChatRouter.get('/', async (req, res, next) => {
  try {
    const officeId = await resolveReadOfficeId(req);
    if (!officeId) return res.status(403).json({ error: 'You do not have access to this office\'s chat' });
    const { rows } = await pool.query(
      `SELECT m.*, u.display_name AS sender_display_name
       FROM office_chat_messages m LEFT JOIN users u ON u.id = m.sender_user_id
       WHERE m.office_id = $1 ORDER BY m.created_at ASC`,
      [officeId]
    );
    res.json({ messages: rows });
  } catch (err) {
    next(err);
  }
});

officeChatRouter.post('/', async (req, res, next) => {
  try {
    const { body, imageUrl } = req.body || {};
    if ((!body || !body.trim()) && !imageUrl) {
      return res.status(400).json({ error: 'Message needs a body or an image' });
    }
    const officeId = await resolveWriteOfficeId(req);
    const { rows } = await pool.query(
      `INSERT INTO office_chat_messages (office_id, sender_user_id, sender_name, body, image_url)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [officeId, req.user.sub, req.user.displayName, body || null, imageUrl || null]
    );
    res.status(201).json({ message: rows[0] });
  } catch (err) {
    next(err);
  }
});
