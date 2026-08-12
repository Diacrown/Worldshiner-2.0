-- Gmail integration scaffolding. Non-functional until GOOGLE_CLIENT_ID/
-- SECRET/REDIRECT_URI env vars are set (see gmail.service.js). One
-- connection per office (inquiries/CAD email are naturally office-specific).
-- Refresh tokens are stored encrypted, never in plaintext (see utils/crypto.js).
CREATE TABLE gmail_oauth_tokens (
  id                        SERIAL PRIMARY KEY,
  office_id                 INTEGER NOT NULL REFERENCES offices(id),
  connected_by_user_id      INTEGER REFERENCES users(id),
  google_email              TEXT,
  encrypted_refresh_token   TEXT NOT NULL,
  encryption_iv             TEXT NOT NULL,
  encryption_auth_tag       TEXT NOT NULL,
  scopes                    TEXT,
  connected_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(office_id)
);
