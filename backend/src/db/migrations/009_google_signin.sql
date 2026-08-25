-- Google sign-in support. A user can redeem an invite code by signing up
-- with Google instead of choosing a password (password_hash becomes
-- optional for that account), and can set a local password afterward from
-- the app if they want one — see PATCH /api/auth/password.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN google_sub TEXT UNIQUE;
