-- Corrections and enrichments derived from reading the real production
-- Firestore data (not just the manual/docx). Two real findings this fixes:
--   1. Design numbers are claimed per-office (S/B/K/T prefixes with
--      independent counters), not from one global counter as 007 assumed.
--   2. Setter/polisher/repairer are parallel JOB-level fields in real data
--      (name/fee/dateSent/dueDate/dateReturned each) — 007 incorrectly put
--      repairer fields on job_issues instead. Undoing that here.

ALTER TABLE offices ADD COLUMN letter_prefix TEXT;
ALTER TABLE offices ADD COLUMN next_design_value INTEGER NOT NULL DEFAULT 1;

DROP TABLE IF EXISTS design_number_counter;

-- Undo 007's incorrect placement — real data keeps repairer info alongside
-- setter/polisher on the job, not nested under an issue.
ALTER TABLE job_issues DROP COLUMN IF EXISTS repairer_name;
ALTER TABLE job_issues DROP COLUMN IF EXISTS amount_given;
ALTER TABLE job_issues DROP COLUMN IF EXISTS date_given;

ALTER TABLE job_setter_polisher DROP CONSTRAINT job_setter_polisher_role_type_check;
ALTER TABLE job_setter_polisher ADD CONSTRAINT job_setter_polisher_role_type_check
  CHECK (role_type IN ('setter', 'polisher', 'repairer'));

-- job_production was missing most of the real production-spec fields.
ALTER TABLE job_production ADD COLUMN item_size TEXT;
ALTER TABLE job_production ADD COLUMN qty INTEGER;
ALTER TABLE job_production ADD COLUMN metal_type TEXT;
ALTER TABLE job_production ADD COLUMN metal_color TEXT;
ALTER TABLE job_production ADD COLUMN alloy_type TEXT;
ALTER TABLE job_production ADD COLUMN rhodium TEXT;
ALTER TABLE job_production ADD COLUMN stone_type TEXT;
ALTER TABLE job_production ADD COLUMN stone_details TEXT;
ALTER TABLE job_production ADD COLUMN stone_source TEXT;
ALTER TABLE job_production ADD COLUMN setting_type TEXT;
ALTER TABLE job_production ADD COLUMN stamp_logo TEXT;
ALTER TABLE job_production ADD COLUMN stamp_metal TEXT;
ALTER TABLE job_production ADD COLUMN stamp_loc TEXT;
ALTER TABLE job_production ADD COLUMN vendor TEXT;
ALTER TABLE job_production ADD COLUMN finding1 TEXT;
ALTER TABLE job_production ADD COLUMN approval_date DATE;
ALTER TABLE job_production ADD COLUMN po_date DATE;
ALTER TABLE job_production ADD COLUMN stone_issue_date DATE;
ALTER TABLE job_production ADD COLUMN delivery_date DATE;
ALTER TABLE job_production ADD COLUMN cad_issued_to TEXT;

-- Stock design entries need their own style code + quantity (real data:
-- {kind:"stock", styleCode:"E2008-4966", qty:1}) — previously only
-- custom/matching_set had a meaningful base_number.
ALTER TABLE job_design_entries ADD COLUMN style_code TEXT;
ALTER TABLE job_design_entries ADD COLUMN qty INTEGER;

-- Client-chase and India-email tracking, found on real jobs, feeding the
-- Alerts panel (client chase-up, snooze) and a lightweight "was this sent to
-- India" record independent of whether Gmail is connected yet.
ALTER TABLE jobs ADD COLUMN client_comment TEXT;
ALTER TABLE jobs ADD COLUMN client_comment_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN snoozed_until DATE;
ALTER TABLE jobs ADD COLUMN india_emailed_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN india_email_count INTEGER NOT NULL DEFAULT 0;

-- Office-wide broadcast chat with HQ — separate from per-job chat
-- (job_chat_messages). Confirmed as a real, actively-used feature in the
-- office_chat Firestore collection that had no equivalent here yet.
CREATE TABLE office_chat_messages (
  id              BIGSERIAL PRIMARY KEY,
  office_id       INTEGER NOT NULL REFERENCES offices(id),
  sender_user_id  INTEGER REFERENCES users(id),
  sender_name     TEXT,
  body            TEXT,
  image_url       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_office_chat_office ON office_chat_messages(office_id, created_at);
