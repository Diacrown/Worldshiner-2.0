import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { pool } from '../db/pool.js';

export const officesRouter = Router();
officesRouter.use(requireAuth);

officesRouter.get('/', async (req, res, next) => {
  try {
    if (req.user.isGlobalAdmin) {
      const { rows } = await pool.query(
        `SELECT o.*, g.code AS org_code, g.name AS org_name FROM offices o JOIN orgs g ON g.id = o.org_id
         WHERE o.active = TRUE ORDER BY g.code, o.is_hq DESC, o.name`
      );
      return res.json({ offices: rows });
    }
    if (req.user.isOrgAdmin || req.user.officeIsHq) {
      const { rows } = await pool.query(
        `SELECT o.*, g.code AS org_code, g.name AS org_name FROM offices o JOIN orgs g ON g.id = o.org_id
         WHERE o.active = TRUE AND o.org_id = $1 ORDER BY o.is_hq DESC, o.name`,
        [req.user.orgId]
      );
      return res.json({ offices: rows });
    }
    const { rows } = await pool.query('SELECT * FROM offices WHERE id = $1', [req.user.officeId]);
    res.json({ offices: rows });
  } catch (err) {
    next(err);
  }
});

officesRouter.get('/orgs', async (req, res, next) => {
  try {
    if (!req.user.isGlobalAdmin) return res.status(403).json({ error: 'Only a global admin can list orgs' });
    const { rows } = await pool.query('SELECT * FROM orgs WHERE active = TRUE ORDER BY code');
    res.json({ orgs: rows });
  } catch (err) {
    next(err);
  }
});

officesRouter.get('/statuses', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT code, label, sort_order, is_system_only, is_archive FROM branch_statuses ORDER BY sort_order'
    );
    res.json({ statuses: rows });
  } catch (err) {
    next(err);
  }
});
