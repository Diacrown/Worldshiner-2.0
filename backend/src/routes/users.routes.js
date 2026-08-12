import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { requireAuth, requireGlobalAdmin, requireOrgAdminOrAbove } from '../middleware/auth.js';
import { pool } from '../db/pool.js';
export const usersRouter = Router();
usersRouter.use(requireAuth);

// Visibility: global admin -> everyone (optionally filtered by ?office=).
// Org admin / HQ staff -> everyone within their own org. Everyone else ->
// just their own office.
usersRouter.get('/', async (req, res, next) => {
  try {
    const params = [];
    let sql = `
      SELECT u.id, u.email, u.display_name, u.is_global_admin, u.is_org_admin, u.is_office_master,
             u.restrict_to_own_jobs, u.active, o.code AS office_code, o.name AS office_name, g.code AS org_code
      FROM users u JOIN offices o ON o.id = u.office_id JOIN orgs g ON g.id = o.org_id
    `;
    if (req.user.isGlobalAdmin) {
      if (req.query.office) { params.push(req.query.office); sql += ` WHERE o.code = $${params.length}`; }
    } else if (req.user.isOrgAdmin || req.user.officeIsHq) {
      params.push(req.user.orgId);
      sql += ` WHERE o.org_id = $${params.length}`;
      if (req.query.office) { params.push(req.query.office); sql += ` AND o.code = $${params.length}`; }
    } else {
      params.push(req.user.officeCode);
      sql += ` WHERE o.code = $${params.length}`;
    }
    sql += ' ORDER BY g.code, o.name, u.display_name';
    const { rows } = await pool.query(sql, params);
    res.json({ users: rows });
  } catch (err) {
    next(err);
  }
});

// Creating/editing staff: global admin (anyone, anywhere) or org admin
// (their own org only — enforced below, not just by role name).
usersRouter.post('/', requireOrgAdminOrAbove, async (req, res, next) => {
  try {
    const { email, password, displayName, officeCode, isGlobalAdmin, isOrgAdmin, isOfficeMaster, restrictToOwnJobs } = req.body || {};
    if (!email || !password || !displayName || !officeCode) {
      return res.status(400).json({ error: 'email, password, displayName, and officeCode are required' });
    }
    if (isGlobalAdmin && !req.user.isGlobalAdmin) {
      return res.status(403).json({ error: 'Only a global admin can grant global admin rights' });
    }
    const { rows: officeRows } = await pool.query('SELECT id, org_id FROM offices WHERE code = $1', [officeCode]);
    if (!officeRows.length) return res.status(400).json({ error: `Unknown office code: ${officeCode}` });
    if (!req.user.isGlobalAdmin && officeRows[0].org_id !== req.user.orgId) {
      return res.status(403).json({ error: 'You can only add staff within your own org' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, display_name, office_id, is_global_admin, is_org_admin, is_office_master, restrict_to_own_jobs)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, email, display_name, office_id, is_global_admin, is_org_admin, is_office_master, restrict_to_own_jobs`,
      [email.toLowerCase(), passwordHash, displayName, officeRows[0].id, !!isGlobalAdmin, !!isOrgAdmin, !!isOfficeMaster, !!restrictToOwnJobs]
    );
    res.status(201).json({ user: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A user with that email already exists' });
    next(err);
  }
});

usersRouter.patch('/:id', requireOrgAdminOrAbove, async (req, res, next) => {
  try {
    const { officeCode, isGlobalAdmin, isOrgAdmin, isOfficeMaster, restrictToOwnJobs, active, newPassword } = req.body || {};
    if (isGlobalAdmin != null && !req.user.isGlobalAdmin) {
      return res.status(403).json({ error: 'Only a global admin can grant or revoke global admin rights' });
    }
    let officeId;
    if (officeCode) {
      const { rows } = await pool.query('SELECT id, org_id FROM offices WHERE code = $1', [officeCode]);
      if (!rows.length) return res.status(400).json({ error: `Unknown office code: ${officeCode}` });
      if (!req.user.isGlobalAdmin && rows[0].org_id !== req.user.orgId) {
        return res.status(403).json({ error: 'You can only move staff within your own org' });
      }
      officeId = rows[0].id;
    }
    if (!req.user.isGlobalAdmin) {
      // Org admin editing an existing user — confirm that user is actually in their org.
      const { rows: targetRows } = await pool.query(
        `SELECT o.org_id FROM users u JOIN offices o ON o.id = u.office_id WHERE u.id = $1`, [req.params.id]
      );
      if (!targetRows.length) return res.status(404).json({ error: 'User not found' });
      if (targetRows[0].org_id !== req.user.orgId) {
        return res.status(403).json({ error: 'You can only edit staff within your own org' });
      }
    }
    if (newPassword && newPassword.length < 8) {
      return res.status(400).json({ error: 'newPassword must be at least 8 characters' });
    }
    const newHash = newPassword ? await bcrypt.hash(newPassword, 10) : null;
    const { rows } = await pool.query(
      `UPDATE users SET
         office_id = COALESCE($1, office_id),
         is_global_admin = COALESCE($2, is_global_admin),
         is_org_admin = COALESCE($3, is_org_admin),
         is_office_master = COALESCE($4, is_office_master),
         restrict_to_own_jobs = COALESCE($5, restrict_to_own_jobs),
         active = COALESCE($6, active),
         password_hash = COALESCE($7, password_hash)
       WHERE id = $8
       RETURNING id, email, display_name, office_id, is_global_admin, is_org_admin, is_office_master, restrict_to_own_jobs, active`,
      [officeId, isGlobalAdmin, isOrgAdmin, isOfficeMaster, restrictToOwnJobs, active, newHash, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ user: rows[0] });
  } catch (err) {
    next(err);
  }
});
