import crypto from 'node:crypto';
import { pool, withTransaction } from '../db/pool.js';

function generateCode() {
  // Short, easy to read aloud or type from a phone screen — e.g. "TX7K-9QRM"
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
  const part = () => Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join('');
  return `${part()}-${part()}`;
}

export async function createInvite(user, { code, officeCode, isGlobalAdmin, isOrgAdmin, isOfficeMaster, restrictToOwnJobs, maxUses, expiresAt }) {
  const { rows: officeRows } = await pool.query('SELECT id, org_id FROM offices WHERE code = $1', [officeCode]);
  if (!officeRows.length) {
    const err = new Error(`Unknown office code: ${officeCode}`);
    err.status = 400;
    throw err;
  }
  if (!user.isGlobalAdmin && officeRows[0].org_id !== user.orgId) {
    const err = new Error('You can only create invite codes for offices in your own org');
    err.status = 403;
    throw err;
  }
  if (isGlobalAdmin && !user.isGlobalAdmin) {
    const err = new Error('Only a global admin can create an invite that grants global admin rights');
    err.status = 403;
    throw err;
  }
  const finalCode = (code && code.trim()) || generateCode();
  const { rows } = await pool.query(
    `INSERT INTO invite_codes (code, office_id, is_global_admin, is_org_admin, is_office_master, restrict_to_own_jobs, max_uses, expires_at, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [finalCode.toUpperCase(), officeRows[0].id, !!isGlobalAdmin, !!isOrgAdmin, !!isOfficeMaster, !!restrictToOwnJobs, maxUses || null, expiresAt || null, user.sub]
  );
  return rows[0];
}

export async function listInvites(user, officeFilter) {
  const params = [];
  let sql = `
    SELECT i.*, o.code AS office_code, o.name AS office_name, u.display_name AS created_by_name
    FROM invite_codes i JOIN offices o ON o.id = i.office_id LEFT JOIN users u ON u.id = i.created_by_user_id
  `;
  const clauses = [];
  if (!user.isGlobalAdmin) { params.push(user.orgId); clauses.push(`o.org_id = $${params.length}`); }
  if (officeFilter) { params.push(officeFilter); clauses.push(`o.code = $${params.length}`); }
  if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
  sql += ' ORDER BY i.created_at DESC';
  const { rows } = await pool.query(sql, params);
  return rows;
}

export async function revokeInvite(user, id) {
  const { rows: existing } = await pool.query(
    `SELECT i.*, o.org_id FROM invite_codes i JOIN offices o ON o.id = i.office_id WHERE i.id = $1`, [id]
  );
  if (!existing.length) return null;
  if (!user.isGlobalAdmin && existing[0].org_id !== user.orgId) {
    const err = new Error('You can only revoke invite codes for your own org');
    err.status = 403;
    throw err;
  }
  const { rows } = await pool.query(`UPDATE invite_codes SET active = FALSE WHERE id = $1 RETURNING *`, [id]);
  return rows[0] ?? null;
}

/**
 * Validates and atomically redeems an invite code, returning the office/role
 * it grants. Throws with .status set on any failure (bad code, expired,
 * exhausted) so the caller can return a clean error to the sign-up form.
 */
export async function redeemInvite(client, codeRaw) {
  const code = (codeRaw || '').trim().toUpperCase();
  if (!code) {
    const err = new Error('An invite code is required to sign up.');
    err.status = 400;
    throw err;
  }
  const { rows } = await client.query('SELECT * FROM invite_codes WHERE code = $1 FOR UPDATE', [code]);
  const invite = rows[0];
  if (!invite || !invite.active) {
    const err = new Error('That invite code is invalid or has been revoked.');
    err.status = 400;
    throw err;
  }
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
    const err = new Error('That invite code has expired.');
    err.status = 400;
    throw err;
  }
  if (invite.max_uses != null && invite.use_count >= invite.max_uses) {
    const err = new Error('That invite code has already been used the maximum number of times.');
    err.status = 400;
    throw err;
  }
  await client.query('UPDATE invite_codes SET use_count = use_count + 1 WHERE id = $1', [invite.id]);
  return invite;
}
