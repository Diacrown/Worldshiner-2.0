-- Invite codes: restores the old system's actual sign-up pattern
-- (createUserWithEmailAndPassword gated by an invite code) instead of the
-- admin-only account creation this build shipped with initially. An internal
-- tool with client/job data across offices should not have open self-
-- registration — an invite code ties a new sign-up to a specific office and
-- role, same as before.
CREATE TABLE invite_codes (
  id                    SERIAL PRIMARY KEY,
  code                  TEXT NOT NULL UNIQUE,
  office_id             INTEGER NOT NULL REFERENCES offices(id),
  is_global_admin       BOOLEAN NOT NULL DEFAULT FALSE,
  is_office_master      BOOLEAN NOT NULL DEFAULT FALSE,
  restrict_to_own_jobs  BOOLEAN NOT NULL DEFAULT FALSE,
  max_uses              INTEGER,           -- NULL = unlimited
  use_count             INTEGER NOT NULL DEFAULT 0,
  expires_at            TIMESTAMPTZ,       -- NULL = never expires
  created_by_user_id    INTEGER REFERENCES users(id),
  active                BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
