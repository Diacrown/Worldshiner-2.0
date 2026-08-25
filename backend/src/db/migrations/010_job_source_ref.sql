-- Tracks each migrated job's originating Firestore document ID. The original
-- historical migration (jobs.import_batch_id) had no way to tell "already
-- migrated" from "new" other than po_number, which can't catch PO-less jobs
-- on a second run. source_ref makes incremental re-sync safe: match by ID
-- when known, otherwise by (office, job_name, created_at, po_number) for
-- the original batch that predates this column, then backfill it.
ALTER TABLE jobs ADD COLUMN source_ref TEXT;
CREATE INDEX idx_jobs_source_ref ON jobs(source_ref) WHERE source_ref IS NOT NULL;
