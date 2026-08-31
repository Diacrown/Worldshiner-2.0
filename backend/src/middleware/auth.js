import { verifyToken } from '../utils/jwt.js';
import { pool } from '../db/pool.js';

// Verifies the Bearer token and attaches the authenticated user's identity —
// including their office and role flags — to req.user. Every route that
// needs to know "which office does this request belong to" reads it from
// req.user, never from anything the client sent in the body/query for writes.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  try {
    const payload = verifyToken(token);
    req.user = payload; // { sub, email, officeId, officeCode, isGlobalAdmin, isOfficeMaster, restrictToOwnJobs }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireGlobalAdmin(req, res, next) {
  if (!req.user?.isGlobalAdmin) {
    return res.status(403).json({ error: 'This action requires HQ/global admin access' });
  }
  next();
}

export function requireOrgAdminOrAbove(req, res, next) {
  if (!req.user?.isGlobalAdmin && !req.user?.isOrgAdmin) {
    return res.status(403).json({ error: 'This action requires org admin or global admin access' });
  }
  next();
}

// For actions that are India/HQ's job specifically (setting the factory-side
// status, production dates, etc.) — open to HQ-office staff OR global admins,
// same pairing used for read-scope in jobs.service.js's buildScope().
export function requireHqOrAdmin(req, res, next) {
  if (!req.user?.isGlobalAdmin && !req.user?.isOrgAdmin && !req.user?.officeIsHq) {
    return res.status(403).json({ error: 'This action is only available to HQ (India) staff, an org admin, or a global admin' });
  }
  next();
}

// For actions any office should be able to self-serve at their own office —
// connecting that office's own Gmail mailbox, etc. — but that shouldn't be
// open to every ordinary staff account. HQ/org/global admins qualify too,
// same as everywhere else, since they can already act on any office in
// scope.
export function requireOfficeAdminOrAbove(req, res, next) {
  if (!req.user?.isGlobalAdmin && !req.user?.isOrgAdmin && !req.user?.officeIsHq && !req.user?.isOfficeMaster) {
    return res.status(403).json({ error: 'This action requires office master or higher at your office' });
  }
  next();
}

// Resolves which office_id a request should be scoped to for WRITES.
// A global admin may explicitly target any office via ?office=CODE; an org
// admin or HQ staffer may target any office within their own org (HQ
// already sees every job org-wide via buildScope — this lets HQ likewise
// *create* a job under the right branch office, e.g. from a branch's
// inbound email, instead of every HQ-created job landing under HQ's own
// office_id). Everyone else is always pinned to their own office_id from
// the token — this is the direct fix for the old system's `office:
// 'DM-USA'` literal hardcoded per file, which is what let a copy-pasted
// file silently mistag another office's jobs.
export async function resolveWriteOfficeId(req) {
  const requestedCode = req.query.office || req.body?.officeCode;
  if (!requestedCode) return req.user.officeId;

  if (req.user.isGlobalAdmin) {
    const { rows } = await pool.query('SELECT id FROM offices WHERE code = $1', [requestedCode]);
    if (!rows.length) throw new Error(`Unknown office code: ${requestedCode}`);
    return rows[0].id;
  }
  if (req.user.isOrgAdmin || req.user.officeIsHq) {
    const { rows } = await pool.query('SELECT id FROM offices WHERE code = $1 AND org_id = $2', [requestedCode, req.user.orgId]);
    if (!rows.length) throw new Error(`Unknown office code in your org: ${requestedCode}`);
    return rows[0].id;
  }
  return req.user.officeId;
}
