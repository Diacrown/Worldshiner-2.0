-- World Shiner 2.0 — Core schema
-- Replaces: per-office Firestore docs tagged with a hardcoded `office` string,
-- a `staff` collection keyed by email, and status vocab hardcoded as <option>
-- tags duplicated (and drifting) across 9 separate HTML files.
--
-- Design goals this schema enforces that the old system could not:
--   1. One source of truth for offices/status vocab (old system had the same
--      OFFICES array copy-pasted into multiple files — we found two different,
--      inconsistent copies inside india_factory_app.html alone).
--   2. Office is derived server-side from the authenticated user, never taken
--      from client input (old system hardcoded `office: 'DM-USA'` literally
--      inside each office's file — a copy-paste of that file to a new office
--      without updating the literal is exactly what caused the Poland/Texas
--      "~124 Sydney-tagged jobs" contamination incident).

CREATE TABLE offices (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,        -- e.g. 'WS-SYD', 'DM-USA', 'HQ'
  name          TEXT NOT NULL,               -- e.g. 'Sydney', 'Texas', 'Head Office / India'
  is_hq         BOOLEAN NOT NULL DEFAULT FALSE,
  currency      TEXT,                        -- e.g. 'AUD', 'USD', 'GBP' — nullable until confirmed per office
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                    SERIAL PRIMARY KEY,
  email                 TEXT NOT NULL UNIQUE,
  password_hash         TEXT NOT NULL,
  display_name          TEXT NOT NULL,
  office_id             INTEGER NOT NULL REFERENCES offices(id),
  is_global_admin       BOOLEAN NOT NULL DEFAULT FALSE, -- old: staff.admin === true / ADMIN_FALLBACK — sees every office
  is_office_master      BOOLEAN NOT NULL DEFAULT FALSE, -- old: MASTER_ACCOUNTS — sees all jobs in own office, can toggle "mine"
  restrict_to_own_jobs  BOOLEAN NOT NULL DEFAULT FALSE, -- old: OWN_ONLY_ACCOUNTS — always scoped to own jobs only
  active                BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_office ON users(office_id);

-- Branch-facing statuses (what an overseas office picks from). Mirrors the
-- <option> list found in jewellery_tracker_v3_pwa.html, single copy instead
-- of one per office file.
CREATE TABLE branch_statuses (
  code            TEXT PRIMARY KEY,   -- e.g. 'quote_given'
  label           TEXT NOT NULL,      -- e.g. 'Quote Given'
  sort_order      INTEGER NOT NULL,
  is_system_only  BOOLEAN NOT NULL DEFAULT FALSE, -- e.g. 'Production Started' — never manually selectable
  is_archive      BOOLEAN NOT NULL DEFAULT FALSE  -- e.g. 'Job Completed' / 'Not Proceeding' — triggers photo purge
);

-- India/HQ-facing statuses (India's own internal production vocabulary).
CREATE TABLE hq_statuses (
  code          TEXT PRIMARY KEY,   -- e.g. 'in_production'
  label         TEXT NOT NULL,      -- e.g. 'In Production'
  sort_order    INTEGER NOT NULL
);

-- Replaces the hardcoded BRANCH_TO_HQ JS object. When a branch office moves a
-- job to `branch_status`, India's own status is written to the mapped
-- `hq_status` (if any — statuses absent from this table intentionally leave
-- India's status untouched, matching old behaviour for e.g. 'Render Submitted').
CREATE TABLE branch_to_hq_status_map (
  branch_status_code   TEXT PRIMARY KEY REFERENCES branch_statuses(code),
  hq_status_code       TEXT NOT NULL REFERENCES hq_statuses(code)
);

-- Replaces the hardcoded HEADLINE JS object. When India changes its own
-- status, the branch office sees this mapped "headline" status instead of
-- India's raw internal vocabulary (e.g. several India statuses all headline
-- as 'Production Started' on the branch side).
CREATE TABLE hq_to_branch_headline_map (
  hq_status_code        TEXT PRIMARY KEY REFERENCES hq_statuses(code),
  branch_status_code    TEXT NOT NULL REFERENCES branch_statuses(code)
);

CREATE TABLE jobs (
  id                      BIGSERIAL PRIMARY KEY,
  office_id               INTEGER NOT NULL REFERENCES offices(id),
  job_name                TEXT NOT NULL,
  contact_person          TEXT,
  client_phone            TEXT,
  priority                TEXT NOT NULL DEFAULT 'Medium' CHECK (priority IN ('Low','Medium','High')),
  status_code             TEXT NOT NULL REFERENCES branch_statuses(code),
  hq_status_code          TEXT REFERENCES hq_statuses(code),
  client_delivery_date    DATE,
  po_number               TEXT,
  render_link             TEXT,
  diacrown_ssp             TEXT,
  invoice_amount          NUMERIC(12,2),
  notes                   TEXT,
  client_stone_semi_mount BOOLEAN NOT NULL DEFAULT FALSE,
  setting_charge_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  design_no               TEXT,             -- denormalized display string built from job_design_entries
  owner_user_id           INTEGER REFERENCES users(id),
  status_synced_by        TEXT CHECK (status_synced_by IN ('branch','hq')),
  status_synced_at        TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_jobs_office ON jobs(office_id);
CREATE INDEX idx_jobs_status ON jobs(status_code);
CREATE INDEX idx_jobs_owner ON jobs(owner_user_id);
CREATE INDEX idx_jobs_po ON jobs(po_number);

-- Replaces ~20 separate nullable `ts*` timestamp columns (tsQuoting,
-- tsCadApproved, tsInProduction, ...) with one append-only history table.
-- "Time in current status" / "time since X" become simple queries against
-- this instead of a wall of per-status columns that must be listed by hand
-- in TS_FIELDS every time a new status is added.
CREATE TABLE job_status_history (
  id                BIGSERIAL PRIMARY KEY,
  job_id            BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status_code       TEXT NOT NULL,
  side              TEXT NOT NULL CHECK (side IN ('branch','hq')),
  changed_by_user_id INTEGER REFERENCES users(id),
  note              TEXT,
  changed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_status_history_job ON job_status_history(job_id, changed_at);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_jobs_updated_at BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
