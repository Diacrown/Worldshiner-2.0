import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool, withTransaction } from '../db/pool.js';
import { signToken } from '../utils/jwt.js';
import { requireAuth } from '../middleware/auth.js';
import { redeemInvite } from '../services/invites.service.js';
import { verifyGoogleIdToken, isGoogleSignInConfigured } from '../services/google-signin.service.js';

export const authRouter = Router();

function tokenPayloadFor(user) {
  return {
    sub: user.id,
    email: user.email,
    displayName: user.display_name,
    hasPassword: !!user.password_hash,
    officeId: user.office_id,
    officeCode: user.office_code,
    officeName: user.office_name,
    officeIsHq: user.office_is_hq,
    officeHasAssay: user.office_has_assay,
    orgId: user.org_id,
    orgCode: user.org_code,
    orgName: user.org_name,
    isGlobalAdmin: user.is_global_admin,
    isOrgAdmin: user.is_org_admin,
    isOfficeMaster: user.is_office_master,
    restrictToOwnJobs: user.restrict_to_own_jobs,
  };
}

async function findUserByEmail(email) {
  const { rows } = await pool.query(
    `SELECT u.*, o.code AS office_code, o.name AS office_name, o.is_hq AS office_is_hq,
            o.has_assay_office AS office_has_assay,
            g.id AS org_id, g.code AS org_code, g.name AS org_name
     FROM users u
     JOIN offices o ON o.id = u.office_id
     JOIN orgs g ON g.id = o.org_id
     WHERE lower(u.email) = lower($1) AND u.active = TRUE`,
    [email]
  );
  return rows[0] ?? null;
}

async function findUserByGoogleSub(googleSub) {
  const { rows } = await pool.query(
    `SELECT u.*, o.code AS office_code, o.name AS office_name, o.is_hq AS office_is_hq,
            o.has_assay_office AS office_has_assay,
            g.id AS org_id, g.code AS org_code, g.name AS org_name
     FROM users u
     JOIN offices o ON o.id = u.office_id
     JOIN orgs g ON g.id = o.org_id
     WHERE u.google_sub = $1 AND u.active = TRUE`,
    [googleSub]
  );
  return rows[0] ?? null;
}

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  const user = await findUserByEmail(email);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  if (!user.password_hash) {
    return res.status(401).json({ error: 'This account signs in with Google — use "Continue with Google" instead.' });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  const payload = tokenPayloadFor(user);
  const token = signToken(payload);
  res.json({ token, user: payload });
});

// Self-service sign-up, gated by an invite code (see services/invites.service.js).
// Mirrors the old system's createUserWithEmailAndPassword-behind-an-invite-code
// pattern — deliberately NOT open registration, since a valid invite is what
// determines which office and role a new account gets.
authRouter.post('/signup', async (req, res, next) => {
  try {
    const { email, password, displayName, inviteCode } = req.body || {};
    if (!email || !password || !displayName) {
      return res.status(400).json({ error: 'email, password, and displayName are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const result = await withTransaction(async (client) => {
      const invite = await redeemInvite(client, inviteCode);
      const passwordHash = await bcrypt.hash(password, 10);
      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash, display_name, office_id, is_global_admin, is_org_admin, is_office_master, restrict_to_own_jobs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [email.toLowerCase(), passwordHash, displayName, invite.office_id, invite.is_global_admin, invite.is_org_admin, invite.is_office_master, invite.restrict_to_own_jobs]
      );
      return rows[0];
    });

    const { rows: withOffice } = await pool.query(
      `SELECT u.*, o.code AS office_code, o.name AS office_name, o.is_hq AS office_is_hq,
              g.id AS org_id, g.code AS org_code, g.name AS org_name
       FROM users u JOIN offices o ON o.id = u.office_id JOIN orgs g ON g.id = o.org_id
       WHERE u.id = $1`,
      [result.id]
    );
    const payload = tokenPayloadFor(withOffice[0]);
    const token = signToken(payload);
    res.status(201).json({ token, user: payload });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An account with that email already exists' });
    next(err);
  }
});

// Public — tells the frontend whether to render "Continue with Google" at
// all. clientId is not a secret (it's the public identifier Google Identity
// Services embeds in the browser), so it's safe to hand back here.
authRouter.get('/google-config', (req, res) => {
  res.json({ enabled: isGoogleSignInConfigured(), clientId: process.env.GOOGLE_SIGNIN_CLIENT_ID || null });
});

// Google-backed equivalent of /signup: still gated by an invite code (same
// reasoning as above — the invite is what assigns office/role), just skips
// choosing a password since the account is verified by Google instead.
authRouter.post('/google-signup', async (req, res, next) => {
  try {
    const { idToken, inviteCode, displayName } = req.body || {};
    const google = await verifyGoogleIdToken(idToken);

    const result = await withTransaction(async (client) => {
      const invite = await redeemInvite(client, inviteCode);
      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash, display_name, office_id, is_global_admin, is_org_admin, is_office_master, restrict_to_own_jobs, google_sub)
         VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [google.email.toLowerCase(), (displayName || '').trim() || google.name, invite.office_id, invite.is_global_admin, invite.is_org_admin, invite.is_office_master, invite.restrict_to_own_jobs, google.sub]
      );
      return rows[0];
    });

    const withOffice = await findUserByEmail(result.email);
    const payload = tokenPayloadFor(withOffice);
    const token = signToken(payload);
    res.status(201).json({ token, user: payload });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An account with that email already exists' });
    next(err);
  }
});

// Log back in with Google for an account that originally signed up via
// google-signup — matched by the stable google_sub, not email, so a
// password-only account can never be logged into by presenting a Google
// identity that merely shares its email address.
authRouter.post('/google-login', async (req, res, next) => {
  try {
    const { idToken } = req.body || {};
    const google = await verifyGoogleIdToken(idToken);
    const user = await findUserByGoogleSub(google.sub);
    if (!user) return res.status(401).json({ error: 'No account found for this Google sign-in — sign up with an invite code first.' });
    const payload = tokenPayloadFor(user);
    const token = signToken(payload);
    res.json({ token, user: payload });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Self-service password change — needs the current password, so it works
// without any email infrastructure (no SMTP/Gmail is configured — see
// docs/ROADMAP.md). For "I forgot my password", an admin resets it via
// PATCH /api/users/:id instead — a real email-based reset flow needs
// mail-sending credentials only you can provide.
authRouter.patch('/password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword) {
      return res.status(400).json({ error: 'newPassword is required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.sub]);
    const user = rows[0];
    // Google-only accounts have no password_hash yet — setting one for the
    // first time doesn't need to prove a password that doesn't exist.
    if (user.password_hash) {
      if (!currentPassword) return res.status(400).json({ error: 'currentPassword is required' });
      const ok = await bcrypt.compare(currentPassword, user.password_hash);
      if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.sub]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
