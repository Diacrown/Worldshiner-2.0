-- Historical-data import (Excel/CSV). Each commit is logged as a batch for
-- auditability — imported jobs are tagged with which batch created them, so
-- a bad import can be traced (and manually cleaned up) without guessing.
CREATE TABLE import_batches (
  id                          BIGSERIAL PRIMARY KEY,
  office_id                   INTEGER NOT NULL REFERENCES offices(id),
  filename                    TEXT NOT NULL,
  imported_by_user_id         INTEGER REFERENCES users(id),
  imported_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_count_total              INTEGER NOT NULL DEFAULT 0,
  row_count_imported            INTEGER NOT NULL DEFAULT 0,
  row_count_skipped_duplicate    INTEGER NOT NULL DEFAULT 0,
  row_count_errored             INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE jobs ADD COLUMN import_batch_id BIGINT REFERENCES import_batches(id);
ALTER TABLE jobs ADD COLUMN imported_at TIMESTAMPTZ;
CREATE INDEX idx_jobs_import_batch ON jobs(import_batch_id);
