-- Adds the hub layer above offices. Until now every office belonged to one
-- implicit hub; DIAMORE existing as a real second hub means "admin" can no
-- longer mean "sees everything" by default — a DIACROWN admin should not
-- automatically see DIAMORE's client data. Three tiers now exist:
--   is_global_admin  -> true super admin, both orgs, every office (unchanged
--                       meaning, but now actually scoped correctly below)
--   is_org_admin     -> every office within their own org only (new)
--   officeIsHq       -> every office within their own org only (unchanged
--                       intent, now actually correct — previously this
--                       accidentally meant "every office in every org")

CREATE TABLE orgs (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,   -- 'DIACROWN', 'DIAMORE'
  name        TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE offices ADD COLUMN org_id INTEGER REFERENCES orgs(id);
ALTER TABLE users ADD COLUMN is_org_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE invite_codes ADD COLUMN is_org_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Both hubs exist as of this migration; every office seeded so far is
-- DIACROWN's. DIAMORE's own office(s) get added by seed.js after this runs.
INSERT INTO orgs (code, name) VALUES
  ('DIACROWN', 'Diacrown'),
  ('DIAMORE', 'Diamore');

UPDATE offices SET org_id = (SELECT id FROM orgs WHERE code = 'DIACROWN') WHERE org_id IS NULL;

ALTER TABLE offices ALTER COLUMN org_id SET NOT NULL;
