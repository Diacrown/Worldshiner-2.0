-- Tier 2 field-audit gap: the old tracker's `specs` array held ~23 legacy
-- spreadsheet columns per job (Style code, Mined or Lab, Tag Color, Cert
-- No., Center/Side Diam Details, Shape Col/Clarity, VendorItemNo, up to 3
-- reference image links, and free-text Remarks), with no fixed set present
-- on every job. A flexible key/value sidecar mirrors that shape losslessly
-- instead of forcing ~10 sparsely-populated columns onto job_production.
-- Keys that already have a real column elsewhere (Loc, JobNo, Customer, CAD
-- Issued To/Date, Ship Date, Stone Issue Date, SSP, Item Size) are
-- deliberately NOT duplicated in here — see job-import.js SPEC_SKIP_KEYS.
CREATE TABLE job_specs (
  id          BIGSERIAL PRIMARY KEY,
  job_id      BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  spec_key    TEXT NOT NULL,
  spec_value  TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_job_specs_job ON job_specs(job_id, sort_order);
